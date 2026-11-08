/**
 * Checking the files a chat message is to carry — the ONE place a path becomes a `SendFile`.
 *
 * The window's file dialog and an agent's `--attach` both end here (ADR 0010 §4). Every refusal
 * comes before a connection exists, and none prints file content: the error names the path and
 * the rule.
 *
 *   - the path must be absolute (a relative one depends on a working directory the person never saw);
 *   - a symlink is followed ONCE with `realpath` and the target is checked like any other path: a
 *     link must not turn a directory, a device or a fifo into something that passes (a fifo would
 *     also block the read forever);
 *   - only a regular file passes; the size comes from `stat` BEFORE the file is read;
 *   - the filename is the basename of the path given, the type comes from the extension.
 *
 * The bytes are read by the sender, at the moment it uploads: `SendFile.realPath` is what to open.
 */

import { realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute } from 'node:path';

import { _, fmt, type SendingAttachment } from '@curlew/protocol';

export interface SendFile {
  /** The path as it was given. */
  path: string;
  /** The path with every link resolved: what to open. */
  realPath: string;
  filename: string;
  size: number;
  contentType: string;
}

export interface SendFileLimits {
  /** Per file, in bytes. */
  perFile: number;
  /** How many files one message may carry. */
  count: number;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
};

/** The type for a file name, `application/octet-stream` when the extension is not known. */
export function contentTypeForName(filename: string): string {
  return CONTENT_TYPES[extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

/** Check every file, or throw before anything is sent. */
export function inspectSendFiles(
  attachments: readonly SendingAttachment[],
  limits: SendFileLimits,
): SendFile[] {
  if (attachments.length > limits.count) {
    throw new Error(
      fmt(_('at most {max} attachments per message, this one has {count}'), {
        max: limits.count,
        count: attachments.length,
      }),
    );
  }
  return attachments.map(({ path }) => {
    if (!isAbsolute(path)) {
      throw new Error(fmt(_('attachment {path} is not an absolute path'), { path }));
    }
    let realPath: string;
    let size: number;
    try {
      realPath = realpathSync(path);
      const info = statSync(realPath);
      if (!info.isFile()) {
        throw new Error(fmt(_('attachment {path} is not a regular file'), { path }));
      }
      size = info.size;
    } catch (error) {
      if (error instanceof Error && error.message.includes(path) && !('code' in error)) throw error;
      throw new Error(fmt(_('attachment {path} cannot be read'), { path }), { cause: error });
    }
    if (size > limits.perFile) {
      throw new Error(
        fmt(_('attachment {path} is {size} bytes, more than the {max} allowed per file'), {
          path,
          size,
          max: limits.perFile,
        }),
      );
    }
    const filename = basename(path);
    return { path, realPath, filename, size, contentType: contentTypeForName(filename) };
  });
}
