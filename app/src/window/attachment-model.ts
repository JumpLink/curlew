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

/** True when the part can be opened/saved today: mail only, chat fetches are not wired yet (ADR 0010). */
export function isOpenable(info: AttachmentInfo): boolean {
  return info.section !== undefined && info.section !== '';
}

/** Above this a thumbnail is not worth decoding in the bubble; the tile and the viewer still work. */
export const INLINE_IMAGE_MAX_BYTES = 12_000_000;

/** Whether the bubble shows the picture itself (true) or a tile (false). */
export function showsInline(info: AttachmentInfo): boolean {
  if (!isOpenable(info) || attachmentKind(info) !== 'image') return false;
  return info.size === null || info.size === undefined || info.size <= INLINE_IMAGE_MAX_BYTES;
}

/** What a tile's primary button does: a video plays in the viewer, anything else goes to the desktop. */
export function tileAction(kind: AttachmentKind): 'view' | 'open' {
  return kind === 'video' ? 'view' : 'open';
}

export const BUBBLE_MAX_IMAGE_HEIGHT = 300;
export const BUBBLE_MAX_IMAGE_WIDTH = 420;

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
