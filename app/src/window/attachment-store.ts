/**
 * Fetching, caching and saving what a bubble shows. The bytes are not in the index: they come
 * from the mailbox through the same `mailSaveAttachment` the CLI and MCP use, only on a person's
 * action or when a picture scrolls into view, into a private per-part directory that is emptied
 * when the window starts.
 */

import { createHash } from 'node:crypto';
import { readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import type { MessageRef } from '@curlew/protocol';
import { ensurePrivateDir, previewsDir } from '@curlew/store';

import { chatSaveAttachment } from '../core/actions/chat-attachment.ts';
import { ATTACHMENT_BYTES } from '../core/actions/limits.ts';
import { mailSaveAttachment } from '../core/actions/mail.ts';
import { previewKey } from './attachment-model.ts';
import { type CachedPart, pickEvictions, PREVIEW_CACHE_MAX_BYTES } from './preview-cache-model.ts';
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
  const key = previewKey(source.ref, source.info.section ?? '', source.info.index);
  // Not GLib's checksum: it reads a C string and stops at the NUL that separates the key's fields.
  return join(root, createHash('sha256').update(key).digest('hex'));
}

/** What the part directories under `root` hold; `pasted` is not a cache, it holds files not sent yet. */
function cachedParts(root: string): CachedPart[] {
  const parts: CachedPart[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'pasted') continue;
    let bytes = 0;
    let modified = 0;
    for (const name of readdirSync(join(root, entry.name))) {
      const stat = statSync(join(root, entry.name, name));
      bytes += stat.size;
      modified = Math.max(modified, stat.mtimeMs);
    }
    parts.push({ name: entry.name, bytes, modified });
  }
  return parts;
}

/**
 * Keeps the cache under its cap by dropping the least recently fetched parts. A part still
 * playing survives its file being unlinked, and a bubble that shows its picture holds it in
 * memory; one more tap fetches a dropped part again. Best effort: the cache is not state.
 */
export function trimPreviews(
  root = previewsDir(),
  keep: readonly string[] = [],
  cap = PREVIEW_CACHE_MAX_BYTES,
): void {
  try {
    for (const name of pickEvictions(cachedParts(root), cap, [
      ...keep,
      ...[...inFlight.keys()].map((d) => basename(d)),
    ])) {
      rmSync(join(root, name), { recursive: true, force: true });
    }
  } catch {
    // The cache is only a convenience; a failed sweep leaves it larger, not broken.
  }
}

function cachedFile(dir: string): string | null {
  try {
    return readdirSync(dir).find((name) => !name.endsWith('.part')) ?? null;
  } catch {
    return null;
  }
}

/**
 * The local path of the part's bytes: the cached copy, else one fetch shared by every caller.
 * Anything the window fetches was asked for by a person or is small enough to show unasked, so the
 * cap is the highest one the actions allow, not the 25 MB default meant for an agent: a phone video
 * is often bigger than that.
 */
export function fetchAttachment(source: AttachmentSource, root = previewsDir()): Promise<string> {
  const { ref, info } = source;
  const dir = partDir(source, root);
  const hit = cachedFile(dir);
  if (hit) return Promise.resolve(join(dir, hit));
  const running = inFlight.get(dir);
  if (running) return running;
  const fetching = (async () => {
    ensurePrivateDir(dir);
    for (const name of readdirSync(dir)) unlinkSync(join(dir, name));
    const saved =
      ref.backend === 'mail' && info.section !== undefined && info.section !== '' && ref.uid !== undefined
        ? await mailSaveAttachment({
            accountId: ref.accountId,
            uid: String(ref.uid),
            ...(ref.folder ? { folder: ref.folder } : {}),
            section: info.section,
            directory: dir,
            maxBytes: ATTACHMENT_BYTES.max,
          })
        : await chatSaveAttachment({
            ref,
            index: info.index as number,
            directory: dir,
            maxBytes: ATTACHMENT_BYTES.max,
          });
    trimPreviews(root, [basename(dir)]);
    return saved.path;
  })().finally(() => inFlight.delete(dir));
  inFlight.set(dir, fetching);
  return fetching;
}

/**
 * Decodes a picture into a texture OFF the main loop: a phone photo can be 12 MB
 * (`INLINE_IMAGE_MAX_BYTES`), and decoding one on the main loop stalls the window for as long
 * as it takes. `max` is the box in device pixels to scale into, ratio kept; omit it for the
 * picture's own size. Rejects when the bytes are not a picture — the caller keeps its fallback.
 */
export function loadTexture(path: string, max?: { width: number; height: number }): Promise<Gdk.Texture> {
  return new Promise((resolve, reject) => {
    Gio.File.new_for_path(path).read_async(GLib.PRIORITY_DEFAULT, null, (file, result) => {
      let stream: Gio.FileInputStream;
      try {
        stream = (file as Gio.File).read_finish(result);
      } catch (err) {
        reject(err);
        return;
      }
      // The decode's own outcome is what the caller needs; a failing close must not mask it.
      const done = (err: unknown, pixbuf: GdkPixbuf.Pixbuf | null) => {
        try {
          stream.close(null);
        } catch {
          // A read-only stream that fails to close changed nothing.
        }
        if (!err && pixbuf) resolve(Gdk.Texture.new_for_pixbuf(pixbuf));
        else reject(err);
      };
      const decoded = (_source: unknown, res: Gio.AsyncResult) => {
        try {
          done(null, GdkPixbuf.Pixbuf.new_from_stream_finish(res));
        } catch (err) {
          done(err, null);
        }
      };
      if (max)
        GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, max.width, max.height, true, null, decoded);
      else GdkPixbuf.Pixbuf.new_from_stream_async(stream, null, decoded);
    });
  });
}

/** How long a video may take to show its first frame before the bubble keeps its tile. */
const POSTER_TIMEOUT_MS = 10_000;

/**
 * The first frame of a video as a paintable, taken through GTK's own media backend so every
 * format the desktop plays has a poster. The stream is closed again: a bubble holds a picture,
 * not a running pipeline. Rejects when the file does not decode or shows nothing in time.
 */
export function loadPoster(path: string): Promise<Gdk.Paintable> {
  return new Promise((resolve, reject) => {
    const media = Gtk.MediaFile.new_for_filename(path);
    let finished = false;
    const finish = (err: Error | null, frame: Gdk.Paintable | null) => {
      if (finished) return;
      finished = true;
      GLib.source_remove(timer);
      media.clear();
      if (err || !frame) reject(err ?? new Error('the video shows no picture'));
      else resolve(frame);
    };
    const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POSTER_TIMEOUT_MS, () => {
      finish(new Error('the video did not show a picture in time'), null);
      return GLib.SOURCE_REMOVE;
    });
    let framed = false;
    const ready = () => {
      const failure = media.error;
      if (failure) return finish(new Error(failure.message), null);
      // Prepared says the stream is known; a drawn frame says there is something to show.
      if (media.prepared && framed) finish(null, media.get_current_image());
    };
    media.connect('notify::prepared', ready);
    media.connect('notify::error', ready);
    media.connect('invalidate-contents', () => {
      framed = true;
      ready();
    });
    ready();
  });
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

/** Hands the file to the desktop's default application; `ask` lets the person pick another one. */
export function openWithDesktop(parent: Gtk.Window | null, path: string, ask = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const launcher = new Gtk.FileLauncher({ file: Gio.File.new_for_path(path), alwaysAsk: ask });
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
