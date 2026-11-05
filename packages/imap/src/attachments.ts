/**
 * Reading the files an agent wants to attach to a mail — the ONE place a path becomes bytes.
 *
 * An agent names paths; nothing else in curlew opens them. Every refusal comes before a
 * connection exists, and none prints file content: the error names the path and the rule.
 *
 *   - the path must be absolute (a relative one depends on a working directory the person never
 *     saw);
 *   - a symlink is followed ONCE with `realpath` and the target is checked like any other path:
 *     links into Downloads and the like are normal, but a link must not turn a directory, a
 *     device or a fifo into something that passes (a fifo would also block the read forever);
 *   - only a regular file passes; per-file and total size are capped, the size read from `stat`
 *     BEFORE the file is read;
 *   - the filename is the basename of the path the agent gave, the type comes from the extension.
 *
 * Pure on purpose (`node:*` only): unit-tested on both runtimes.
 */

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute } from 'node:path';

import type { SendingAttachment } from '@curlew/protocol';
import { _, fmt } from '@curlew/protocol';

/** Per file, in bytes. Base64 adds a third, and many servers refuse a message over ~35 MB. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** All files of one message, in bytes. */
export const MAX_ATTACHMENTS_TOTAL_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

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
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
};

/** The type for a file name, `application/octet-stream` when the extension is not known. */
export function contentTypeFor(filename: string): string {
  return CONTENT_TYPES[extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

export interface ReadAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
  size: number;
}

export interface AttachmentLimits {
  perFile?: number;
  total?: number;
}

/** Read every file, or throw before sending anything. */
export function readAttachments(
  attachments: readonly SendingAttachment[],
  limits: AttachmentLimits = {},
): ReadAttachment[] {
  const perFile = limits.perFile ?? MAX_ATTACHMENT_BYTES;
  const total = limits.total ?? MAX_ATTACHMENTS_TOTAL_BYTES;
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new Error(
      fmt(_('at most {max} attachments per mail, this one has {count}'), {
        max: MAX_ATTACHMENTS,
        count: attachments.length,
      }),
    );
  }
  const out: ReadAttachment[] = [];
  let sum = 0;
  for (const { path } of attachments) {
    if (!isAbsolute(path)) {
      throw new Error(fmt(_('attachment {path} is not an absolute path'), { path }));
    }
    let real: string;
    let size: number;
    try {
      real = realpathSync(path);
      const info = statSync(real);
      if (!info.isFile()) {
        throw new Error(fmt(_('attachment {path} is not a regular file'), { path }));
      }
      size = info.size;
    } catch (error) {
      if (error instanceof Error && error.message.includes(path) && !('code' in error)) throw error;
      throw new Error(fmt(_('attachment {path} cannot be read'), { path }), { cause: error });
    }
    if (size > perFile) {
      throw new Error(
        fmt(_('attachment {path} is {size} bytes, more than the {max} allowed per file'), {
          path,
          size,
          max: perFile,
        }),
      );
    }
    sum += size;
    if (sum > total) {
      throw new Error(
        fmt(_('the attachments together exceed {max} bytes'), { max: total }),
      );
    }
    const filename = basename(path);
    let content: Uint8Array;
    try {
      content = readFileSync(real);
    } catch (error) {
      throw new Error(fmt(_('attachment {path} cannot be read'), { path }), { cause: error });
    }
    out.push({ filename, contentType: contentTypeFor(filename), content, size: content.byteLength });
  }
  return out;
}
