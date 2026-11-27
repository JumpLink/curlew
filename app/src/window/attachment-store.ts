/**
 * Fetching, caching and saving what a bubble shows. The bytes are not in the index: they come
 * from the mailbox through the same `mailSaveAttachment` the CLI and MCP use, only on a person's
 * action or when a picture scrolls into view, into a private per-part directory that is emptied
 * when the window starts.
 */

import { readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import { _, type MessageRef } from '@curlew/protocol';
import { ensurePrivateDir, previewsDir } from '@curlew/store';

import { decodeBlurHash } from './blur-hash.ts';
import { chatSaveAttachment } from '../core/actions/chat-attachment.ts';
import { chatFetchThumbnail } from '../core/actions/chat-thumbnail.ts';
import { ATTACHMENT_BYTES } from '../core/actions/limits.ts';
import { mailSaveAttachment } from '../core/actions/mail.ts';
import { isSignedOutFailure, previewKey, shouldFetchThumb } from './attachment-model.ts';
import {
  type CachedPart,
  cachedFile,
  cachedPath,
  partDir,
  pickEvictions,
  PREVIEW_CACHE_MAX_BYTES,
} from './preview-cache-model.ts';
import type { AttachmentInfo } from './conversation-model.ts';
import type { DaemonAccountEntry } from '../core/lib/daemon-bus.ts';
import { accountKeyOf, SignedOutRegistry } from './signed-out-model.ts';

/** One fetchable part of one mail message. */
export interface AttachmentSource {
  ref: MessageRef;
  info: AttachmentInfo;
}

/**
 * The path of a part whose bytes are already on this machine — the file a pending send carries
 * (ADR 0021 §4), else the previews cache — and null when they are not. The view's cue that it may
 * show a large video's frame without fetching anything.
 */
export function cachedAttachment(source: AttachmentSource, root = previewsDir()): string | null {
  const { localPath } = source.info;
  if (localPath !== undefined && localPath !== '') return localPath;
  return cachedPath(source, root);
}

const inFlight = new Map<string, Promise<string>>();

const signedOut = new SignedOutRegistry();

function accountKey(ref: MessageRef): string {
  return accountKeyOf(ref.backend, ref.accountId);
}

/** Whether the account is known to be signed out (the daemon said so, or a fetch was refused), so no part tries. */
export function isSignedOut(ref: MessageRef, now = Date.now()): boolean {
  return signedOut.isSignedOut(accountKey(ref), now);
}

/** Whether the part cannot be had at all: its account is signed out and no copy is cached. */
export function blockedBySignOut(source: AttachmentSource, now = Date.now()): boolean {
  return isSignedOut(source.ref, now) && cachedAttachment(source) === null;
}

/** Marks the account when `err` is a dead-session failure; mail has its own sign-in and is never marked. */
export function noteFetchFailure(ref: MessageRef, err: unknown, now = Date.now()): boolean {
  if (ref.backend === 'mail' || !isSignedOutFailure(err)) return false;
  signedOut.noteFailure(accountKey(ref), now);
  return true;
}

/** Feeds the daemon's account states in; a logged-out account is marked before any fetch, any other state clears it. */
export function applyDaemonAccounts(accounts: Iterable<DaemonAccountEntry>): string[] {
  return signedOut.applyDaemon(accounts);
}

/** Thrown instead of fetching when the account is already known to be signed out. */
export class SignedOutError extends Error {
  readonly loggedOut = true;
  constructor() {
    super(_('the account is signed out'));
    this.name = 'SignedOutError';
  }
}

/** Parts whose thumbnail was tried in this window run: a failure is retried on the next run, not now. */
const thumbAttempts = new Set<string>();
const thumbInFlight = new Map<string, Promise<string | null>>();

function thumbKey(source: AttachmentSource): string {
  return previewKey(source.ref, '', source.info.index);
}

/** Whether the part's thumbnail should be fetched by its handle now (ADR 0017 §2). */
export function wantsThumbnail(source: AttachmentSource): boolean {
  return shouldFetchThumb(source.info, thumbAttempts.has(thumbKey(source)));
}

/**
 * Fetches the part's THUMBNAIL (never the file) and records its path on the info, so the bubble
 * repaints from it. Null when the fetch failed: the poster stays blurHash or dark box.
 */
export function fetchThumbnail(source: AttachmentSource): Promise<string | null> {
  const key = thumbKey(source);
  const running = thumbInFlight.get(key);
  if (running) return running;
  if (!wantsThumbnail(source) || isSignedOut(source.ref))
    return Promise.resolve(source.info.thumbPath ?? null);
  thumbAttempts.add(key);
  const fetching = chatFetchThumbnail({ ref: source.ref, index: source.info.index as number })
    .then((path) => {
      source.info.thumbPath = path;
      source.info.thumbFetchable = false;
      return path;
    })
    .catch((err: unknown) => {
      noteFetchFailure(source.ref, err);
      return null;
    })
    .finally(() => thumbInFlight.delete(key));
  thumbInFlight.set(key, fetching);
  return fetching;
}

/** The window starts with no leftovers of an earlier run: they are message content. */
export function clearPreviews(dir = previewsDir()): void {
  rmSync(dir, { recursive: true, force: true });
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
function trimPreviews(
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

/**
 * The local path of the part's bytes: the cached copy, else one fetch shared by every caller.
 * Anything the window fetches was asked for by a person or is small enough to show unasked, so the
 * cap is the highest one the actions allow, not the 25 MB default meant for an agent: a phone video
 * is often bigger than that.
 */
export function fetchAttachment(
  source: AttachmentSource,
  root = previewsDir(),
  maxBytes: number = ATTACHMENT_BYTES.max,
): Promise<string> {
  const { ref, info } = source;
  // A pending send's file is already here (ADR 0021 §4): no fetch, no cache copy, no network.
  if (info.localPath !== undefined && info.localPath !== '') return Promise.resolve(info.localPath);
  const dir = partDir(source, root);
  const hit = cachedFile(dir);
  if (hit) return Promise.resolve(join(dir, hit));
  const running = inFlight.get(dir);
  if (running) return running;
  if (isSignedOut(ref)) return Promise.reject(new SignedOutError());
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
            maxBytes,
          })
        : await chatSaveAttachment({
            ref,
            index: info.index as number,
            directory: dir,
            maxBytes,
          });
    trimPreviews(root, [basename(dir)]);
    return saved.path;
  })()
    .catch((err: unknown) => {
      noteFetchFailure(ref, err);
      throw err;
    })
    .finally(() => inFlight.delete(dir));
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

/**
 * The still stored for a part at sync (ADR 0017): its thumbnail file, else its blurHash drawn
 * small. Null when it has neither; rejects when the thumbnail does not decode.
 */
export async function stillTexture(
  info: Pick<AttachmentInfo, 'thumbPath' | 'blurHash'>,
  max: { width: number; height: number },
): Promise<Gdk.Texture | null> {
  if (info.thumbPath) {
    try {
      return await loadTexture(info.thumbPath, max);
    } catch {
      // A damaged thumbnail falls through to the blurHash.
    }
  }
  if (!info.blurHash) return null;
  const pixels = decodeBlurHash(info.blurHash, BLUR_SIZE, BLUR_SIZE);
  if (!pixels) return null;
  return Gdk.MemoryTexture.new(
    BLUR_SIZE,
    BLUR_SIZE,
    Gdk.MemoryFormat.R8G8B8A8,
    GLib.Bytes.new(pixels),
    BLUR_SIZE * 4,
  );
}

const BLUR_SIZE = 32;

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
