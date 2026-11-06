/**
 * Fetching, caching and saving what a bubble shows. The bytes are not in the index: they come
 * from the mailbox through the same `mailSaveAttachment` the CLI and MCP use, only on a person's
 * action or when a picture scrolls into view, into a private per-part directory that is emptied
 * when the window starts.
 */

import { createHash } from 'node:crypto';
import { readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import type { MessageRef } from '@curlew/protocol';
import { ensurePrivateDir, previewsDir } from '@curlew/store';

import { mailSaveAttachment } from '../core/actions/mail.ts';
import { previewKey } from './attachment-model.ts';
import type { AttachmentInfo } from './conversation-model.ts';

/** One fetchable part of one mail message. */
export interface AttachmentSource {
  ref: MessageRef;
  info: AttachmentInfo;
}

const inFlight = new Map<string, Promise<string>>();

/** The window starts with no leftovers of an earlier run: they are message content. */
export function clearPreviews(dir = previewsDir()): void {
  rmSync(dir, { recursive: true, force: true });
}

function partDir(source: AttachmentSource, root: string): string {
  const key = previewKey(source.ref, source.info.section ?? '');
  // Not GLib's checksum: it reads a C string and stops at the NUL that separates the key's fields.
  return join(root, createHash('sha256').update(key).digest('hex'));
}

function cachedFile(dir: string): string | null {
  try {
    return readdirSync(dir).find((name) => !name.endsWith('.part')) ?? null;
  } catch {
    return null;
  }
}

/** The local path of the part's bytes: the cached copy, else one fetch shared by every caller. */
export function fetchAttachment(source: AttachmentSource, root = previewsDir()): Promise<string> {
  const { ref, info } = source;
  if (info.section === undefined || ref.uid === undefined)
    return Promise.reject(new Error('Not a mail attachment'));
  const dir = partDir(source, root);
  const hit = cachedFile(dir);
  if (hit) return Promise.resolve(join(dir, hit));
  const running = inFlight.get(dir);
  if (running) return running;
  const fetching = (async () => {
    ensurePrivateDir(dir);
    for (const name of readdirSync(dir)) unlinkSync(join(dir, name));
    const saved = await mailSaveAttachment({
      accountId: ref.accountId,
      uid: String(ref.uid),
      ...(ref.folder ? { folder: ref.folder } : {}),
      section: info.section,
      directory: dir,
    });
    return saved.path;
  })().finally(() => inFlight.delete(dir));
  inFlight.set(dir, fetching);
  return fetching;
}

/** Asks where to put a copy of `path` and copies it; false when the person cancelled. */
export function saveCopyAs(parent: Gtk.Window | null, path: string, suggestedName: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const dialog = new Gtk.FileDialog({ initialName: suggestedName });
    dialog.save(parent, null, (_source, result) => {
      let target: Gio.File | null;
      try {
        target = dialog.save_finish(result);
      } catch (err) {
        // Dismissing the dialog is an error in the API, not a failure.
        if (err instanceof GLib.Error && err.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED)) {
          resolve(false);
        } else reject(err);
        return;
      }
      try {
        Gio.File.new_for_path(path).copy(target, Gio.FileCopyFlags.OVERWRITE, null, null);
        resolve(true);
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** Hands the file to the desktop's default application. */
export function openWithDesktop(parent: Gtk.Window | null, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const launcher = new Gtk.FileLauncher({ file: Gio.File.new_for_path(path) });
    launcher.launch(parent, null, (_source, result) => {
      try {
        launcher.launch_finish(result);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** An error's text for a toast; never the part's content or a credential. */
export function failureText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
