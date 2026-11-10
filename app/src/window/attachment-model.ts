/** Pure rules for showing a message's attachments: what kind they are, how big, which are shown. */

import type { AttachmentInfo } from './conversation-model.ts';

export type AttachmentKind = 'image' | 'video' | 'audio' | 'voice' | 'file';

/** Formats the toolkit decodes everywhere; SVG stays a file, as drawing foreign vector markup is not worth it. */
const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/avif',
]);

const BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  wav: 'audio/wav',
};

/** The type a part really is: its MIME type, else a guess from the extension when it is generic. */
export function effectiveMime(info: Pick<AttachmentInfo, 'filename' | 'mimeType'>): string | null {
  const mime = info.mimeType?.toLowerCase().split(';')[0]?.trim() || null;
  if (mime && mime !== 'application/octet-stream') return mime;
  const ext = info.filename?.toLowerCase().split('.').pop();
  return (ext && info.filename?.includes('.') ? BY_EXTENSION[ext] : undefined) ?? mime;
}

export function attachmentKind(info: Pick<AttachmentInfo, 'filename' | 'mimeType' | 'kind'>): AttachmentKind {
  // Trust the backend/store when it already classified the part (chat, or mail coming soon).
  if (info.kind === 'image' || info.kind === 'video' || info.kind === 'audio' || info.kind === 'voice') {
    return info.kind;
  }
  const mime = effectiveMime(info);
  if (!mime) return 'file';
  if (IMAGE_TYPES.has(mime)) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

/** True when the part can be opened/saved: mail has a section, chat is fetchable and its backend can fetch (ADR 0010). */
export function isOpenable(info: AttachmentInfo): boolean {
  if (info.section !== undefined && info.section !== '') return true;
  return info.fetchable === true && info.backendCanFetch === true;
}

/** Above this a thumbnail is not worth decoding in the bubble; the tile and the viewer still work. */
export const INLINE_IMAGE_MAX_BYTES = 12_000_000;

/** A chat image is fetched on its own only up to this size; a larger one waits for a tap (ADR 0010). */
export const AUTO_FETCH_IMAGE_MAX_BYTES = 2_000_000;

/** Whether a chat image is small enough to be fetched without a tap once its bubble is in view. */
export function shouldAutoFetch(info: AttachmentInfo): boolean {
  return (
    isOpenable(info) &&
    attachmentKind(info) === 'image' &&
    info.size !== null &&
    info.size !== undefined &&
    info.size <= AUTO_FETCH_IMAGE_MAX_BYTES
  );
}

/** A chat video is fetched on its own, to show its first frame, only up to this size (ADR 0010). */
export const AUTO_FETCH_VIDEO_MAX_BYTES = 8_000_000;

/** Whether the bubble shows a video's first frame (true) or a tile (false). */
export function showsPoster(info: AttachmentInfo): boolean {
  if (!isOpenable(info) || attachmentKind(info) !== 'video') return false;
  // Showing the frame means fetching the whole video unasked: only a chat part of known, small size.
  if (info.section !== undefined && info.section !== '') return false;
  return info.size !== null && info.size !== undefined && info.size <= AUTO_FETCH_VIDEO_MAX_BYTES;
}

/** Whether the bubble shows the picture itself (true) or a tile (false). */
export function showsInline(info: AttachmentInfo): boolean {
  if (!isOpenable(info) || attachmentKind(info) !== 'image') return false;
  // Showing the picture means fetching it unasked, which a chat part may only do when small.
  if (info.section === undefined || info.section === '') return shouldAutoFetch(info);
  return info.size === null || info.size === undefined || info.size <= INLINE_IMAGE_MAX_BYTES;
}

/** What a tile's primary button does: a video plays in the viewer, anything else goes to the desktop. */
export function tileAction(kind: AttachmentKind): 'view' | 'open' {
  return kind === 'video' ? 'view' : 'open';
}

/**
 * A picture in a bubble is laid out with a size request, which is a minimum: a wider one would keep
 * the window from going narrower. 280 px plus the bubble's margins fits a 360 px phone screen.
 */
export const BUBBLE_MAX_IMAGE_HEIGHT = 300;
export const BUBBLE_MAX_IMAGE_WIDTH = 280;

export interface Size {
  width: number;
  height: number;
}

/** `natural` scaled down, never up, to fit the box; the ratio is kept and nothing collapses to zero. */
export function boundedSize(
  natural: Size,
  maxWidth = BUBBLE_MAX_IMAGE_WIDTH,
  maxHeight = BUBBLE_MAX_IMAGE_HEIGHT,
): Size {
  if (!(natural.width > 0) || !(natural.height > 0))
    return { width: maxWidth, height: Math.round(maxHeight / 2) };
  const scale = Math.min(1, maxWidth / natural.width, maxHeight / natural.height);
  return {
    width: Math.max(1, Math.round(natural.width * scale)),
    height: Math.max(1, Math.round(natural.height * scale)),
  };
}

export const MAX_SHOWN_ATTACHMENTS = 6;

/** The parts a bubble lists: those that can be fetched at all, at most `limit`, and how many were left out. */
export function shownAttachments(
  attachments: readonly AttachmentInfo[] | undefined,
  limit = MAX_SHOWN_ATTACHMENTS,
): { shown: AttachmentInfo[]; more: number } {
  // Mail parts are keyed by their section (an empty one cannot be fetched); chat parts by position.
  // A chat part that cannot be fetched yet still lists, as a tile that does nothing.
  const usable = (attachments ?? []).filter((a) =>
    a.section !== undefined ? a.section !== '' : a.index !== undefined,
  );
  return { shown: usable.slice(0, limit), more: usable.length - Math.min(usable.length, limit) };
}

/** Where a fetched part is cached: one directory per message part, so a part is fetched once. */
export function previewKey(
  ref: { accountId: string; folder?: string; uid?: number; remoteId?: string },
  section: string,
  index?: number,
): string {
  // Chat attachments have no IMAP section; their position is the index.
  const segment = section !== undefined && section !== '' ? section : String(index ?? '');
  return [ref.accountId, ref.folder ?? '', ref.uid ?? '', ref.remoteId ?? '', segment].join('\u0000');
}

/** A length as `m:ss`, or `h:mm:ss` from an hour on; empty when the index has none. */
export function durationLabel(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return '';
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** Whether a part belongs in a message's picture grid: a picture or a video that can be opened. */
export function isGridMedia(info: AttachmentInfo): boolean {
  const kind = attachmentKind(info);
  return (kind === 'image' || kind === 'video') && isOpenable(info);
}

/**
 * Whether the first of a message's attachments is a picture block (a picture, a poster or a grid)
 * rather than a tile. Such a block runs to the bubble's edges, so the bubble gives it no padding.
 */
export function leadsWithMedia(shown: readonly AttachmentInfo[]): boolean {
  const first = shown[0];
  if (!first) return false;
  if (showsInline(first) || showsPoster(first)) return true;
  return isGridMedia(first) && shown.filter(isGridMedia).length > 1;
}

/** Whether the bubble shows a player (true) or a tile (false): a voice note or audio that can be fetched. */
export function showsPlayer(info: AttachmentInfo): boolean {
  const kind = attachmentKind(info);
  return (kind === 'voice' || kind === 'audio') && isOpenable(info);
}

/** The player's time text: where it is and how long the whole is, e.g. `0:07 / 0:31`; only the position if the length is unknown. */
export function playbackLabel(positionMs: number, totalMs: number | null | undefined): string {
  const position = durationLabel(positionMs) || '0:00';
  const total = durationLabel(totalMs);
  return total ? `${position} / ${total}` : position;
}

/** Where a seek bar sits, 0 to 1, for a position in a whole of known length; 0 when the length is unknown. */
export function playbackFraction(positionMs: number, totalMs: number | null | undefined): number {
  if (!totalMs || !Number.isFinite(totalMs) || totalMs <= 0) return 0;
  return Math.min(1, Math.max(0, positionMs / totalMs));
}
