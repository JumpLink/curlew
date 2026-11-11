/** Unified attachment reader: mail keeps its `attachments` table, chats get `message_attachments`. */

import type { AttachmentKind, MessageRef } from '@curlew/protocol';
import type { IndexDatabase } from './db.ts';
import { mailAttachments, type MailAttachmentInfo } from './mail-reply.ts';

/** What the index knows about one attachment; the opaque handle never leaves `@curlew/store`. */
export interface AttachmentInfo {
  /** IMAP section for mail; chat attachments have no section. */
  section?: string;
  filename: string | null;
  mimeType: string | null;
  size: number | null;
  /** Position in the message; mail uses `section` instead. */
  index: number;
  /** What the UI should show it as. */
  kind: AttachmentKind;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** True when a chat attachment row has a non-empty backend handle and can be fetched. */
  fetchable: boolean;
}

/** Load every attachment descriptor for a message; routes by `ref.backend`. */
export function loadAttachments(db: IndexDatabase, ref: MessageRef): AttachmentInfo[] {
  if (ref.backend === 'mail') {
    return mailAttachments(db, ref).map((a, i) => ({
      section: a.section,
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
      index: i,
      kind: kindFromMime(a.filename, a.mimeType),
      width: null,
      height: null,
      durationMs: null,
      fetchable: false,
    }));
  }
  return chatAttachments(db, ref);
}

/** The opaque backend handle for one chat attachment, or null when there is none. */
export function loadAttachmentHandle(db: IndexDatabase, ref: MessageRef, index: number): string | null {
  if (ref.backend === 'mail' || !ref.remoteId) return null;
  const row = db
    .prepare(
      `SELECT a.handle FROM message_attachments a
         JOIN conversation_messages m ON m.id = a.message_id
        WHERE m.backend = ? AND m.account_id = ? AND m.remote_id = ? AND a.idx = ?`,
    )
    .get(ref.backend, ref.accountId, ref.remoteId, index) as { handle?: unknown } | undefined;
  return typeof row?.handle === 'string' ? row.handle : null;
}

function chatAttachments(db: IndexDatabase, ref: MessageRef): AttachmentInfo[] {
  if (!ref.remoteId) return [];
  const rows = db
    .prepare(
      `SELECT a.idx, a.filename, a.mime_type, a.size, a.kind, a.width, a.height, a.duration_ms, a.handle
         FROM message_attachments a
         JOIN conversation_messages m ON m.id = a.message_id
        WHERE m.backend = ? AND m.account_id = ? AND m.remote_id = ?
        ORDER BY a.idx`,
    )
    .all(ref.backend, ref.accountId, ref.remoteId) as Array<{
      idx: unknown;
      filename: unknown;
      mime_type: unknown;
      size: unknown;
      kind: unknown;
      width: unknown;
      height: unknown;
      duration_ms: unknown;
      handle: unknown;
    }>;
  return rows.map((r) => ({
    index: Number(r.idx),
    filename: str(r.filename),
    mimeType: str(r.mime_type),
    size: num(r.size),
    kind: (r.kind as AttachmentKind) ?? kindFromMime(str(r.filename), str(r.mime_type)),
    width: num(r.width),
    height: num(r.height),
    durationMs: num(r.duration_ms),
    fetchable: typeof r.handle === 'string' && r.handle !== '',
  }));
}

const EXTENSIONS: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
};

/**
 * A name for an attachment the sender gave none (a voice note has none), with an extension from
 * its type so a tool that opens the file by name knows what it is.
 */
export function fallbackAttachmentName(info: Pick<AttachmentInfo, 'kind' | 'mimeType' | 'index'>): string {
  const base = info.kind === 'voice' ? 'voice-note' : info.kind === 'file' ? 'attachment' : info.kind;
  const mime = info.mimeType?.toLowerCase().split(';')[0]?.trim() ?? '';
  const extension = EXTENSIONS[mime];
  return `${base}-${info.index + 1}${extension ? `.${extension}` : ''}`;
}

function kindFromMime(filename: string | null, mimeType: string | null): AttachmentKind {
  const mime = mimeType?.toLowerCase().split(';')[0]?.trim() ?? '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  const ext = filename?.toLowerCase().split('.').pop();
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'webp') return 'image';
  if (ext === 'mp4' || ext === 'webm' || ext === 'mkv' || ext === 'mov') return 'video';
  if (ext === 'mp3' || ext === 'ogg' || ext === 'opus' || ext === 'flac' || ext === 'wav') return 'audio';
  return 'file';
}

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export type { MailAttachmentInfo };
