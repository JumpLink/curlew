import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';

import {
  chatConversationId,
  getConversation,
  loadAttachments,
  loadThumbTarget,
  setThumbState,
  THUMBNAIL_FETCH_MAX_BYTES,
  storedThumbPath,
  syncChats,
  THUMBNAIL_MAX_BYTES,
  thumbnailColumns,
  thumbPath,
  previewsDir,
} from '@curlew/store';
import type { AttachmentFetcher } from '@curlew/protocol';
import { storeThumbnail } from '../../../src/core/actions/chat-thumbnail.ts';
import { BEN, chatMessage, FakeChatBackend } from './chat-fixtures.ts';
import { freshDb } from './fixtures.ts';

// A stand-in for a JPEG: the store never decodes it.
const TINY = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const HASH = 'LEHV6nWB2yk8pyo0adR*.7kCMdnj';

function withThumbsDir<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'curlew-thumbs-'));
  const before = process.env.CURLEW_THUMBS_DIR;
  process.env.CURLEW_THUMBS_DIR = root;
  return body(root).finally(() => {
    if (before === undefined) delete process.env.CURLEW_THUMBS_DIR;
    else process.env.CURLEW_THUMBS_DIR = before;
    rmSync(root, { recursive: true, force: true });
  });
}

function photo(thumb: Partial<{ thumbnail: Uint8Array; thumbHandle: string; blurHash: string }>) {
  return {
    filename: 'a.jpg',
    mimeType: 'image/jpeg',
    size: 1234,
    kind: 'image' as const,
    width: 100,
    height: 100,
    durationMs: null,
    handle: JSON.stringify({ fileId: 'a' }),
    ...thumb,
  };
}

async function syncOne(attachment: ReturnType<typeof photo>) {
  const backend = new FakeChatBackend();
  backend.addChat({ remoteId: '1002', kind: 'direct', title: 'Ben', members: [BEN] });
  backend.post(
    '1002',
    chatMessage('1002', 1, BEN, 'look', { hasAttachments: true, attachments: [attachment] }),
  );
  const db = freshDb();
  await syncChats(db, backend);
  const conversation = chatConversationId('telegram', 'telegram-42', '1002');
  const message = getConversation(db, conversation)?.messages[0];
  return { db, backend, conversation, message: message! };
}

export default async () => {
  await describe('thumbnailColumns', async () => {
    await it('writes inline bytes within the cap and marks them stored', async () => {
      await withThumbsDir(async (root) => {
        expect(thumbnailColumns('m1', 0, { thumbnail: TINY, blurHash: HASH }, root)).toStrictEqual([
          null,
          'stored',
          HASH,
        ]);
        expect(existsSync(thumbPath('m1', 0, root))).toBe(true);
        expect(storedThumbPath('m1', 0, 'stored', root)).toBe(thumbPath('m1', 0, root));
      });
    });

    await it('drops bytes above 16 KiB and empty ones', async () => {
      await withThumbsDir(async (root) => {
        const big = new Uint8Array(THUMBNAIL_MAX_BYTES + 1);
        expect(thumbnailColumns('m1', 0, { thumbnail: big }, root)).toStrictEqual([null, 'none', null]);
        expect(thumbnailColumns('m1', 1, { thumbnail: new Uint8Array(0) }, root)[1]).toBe('none');
        expect(existsSync(thumbPath('m1', 0, root))).toBe(false);
        const edge = new Uint8Array(THUMBNAIL_MAX_BYTES);
        expect(thumbnailColumns('m1', 2, { thumbnail: edge }, root)[1]).toBe('stored');
      });
    });

    await it('keeps a handle for the window to fetch and leaves the state empty', async () => {
      expect(thumbnailColumns('m1', 0, { thumbHandle: 'h' })).toStrictEqual(['h', null, null]);
      const big = new Uint8Array(THUMBNAIL_MAX_BYTES + 1);
      expect(thumbnailColumns('m1', 0, { thumbnail: big, thumbHandle: 'h' })).toStrictEqual([
        'h',
        null,
        null,
      ]);
    });

    await it('marks a failed write and keeps the handle', async () => {
      // A directory that cannot exist: its parent is a regular file.
      const root = mkdtempSync(join(tmpdir(), 'curlew-thumbs-'));
      try {
        const file = join(root, 'file');
        writeFileSync(file, 'x');
        const result = thumbnailColumns('m1', 0, { thumbnail: TINY, thumbHandle: 'h' }, join(file, 'thumbs'));
        expect(result).toStrictEqual(['h', 'failed', null]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    await it('ignores a malformed blurHash', async () => {
      expect(thumbnailColumns('m1', 0, { blurHash: 'no spaces allowed' })[2]).toBe(null);
    });

    await it('keeps thumbnails out of the previews cache', async () => {
      expect(thumbPath('m1', 0).startsWith(previewsDir())).toBe(false);
    });
  });

  await describe('thumbnails at sync', async () => {
    await it('writes the thumbnail file and reads its path back', async () => {
      await withThumbsDir(async (root) => {
        const { db, message } = await syncOne(photo({ thumbnail: TINY, blurHash: HASH }));
        try {
          const [part] = loadAttachments(db, message.ref);
          expect(part?.thumbPath).toBe(thumbPath(message.id, 0, root));
          expect(part?.blurHash).toBe(HASH);
          expect('thumbHandle' in (part ?? {})).toBe(false);
        } finally {
          db.close();
        }
      });
    });

    await it('reports no path once the file is gone', async () => {
      await withThumbsDir(async (root) => {
        const { db, message } = await syncOne(photo({ thumbnail: TINY }));
        try {
          rmSync(thumbPath(message.id, 0, root));
          expect(loadAttachments(db, message.ref)[0]?.thumbPath).toBe(null);
        } finally {
          db.close();
        }
      });
    });

    await it('stores state none for an oversize thumbnail', async () => {
      await withThumbsDir(async () => {
        const { db, message } = await syncOne(photo({ thumbnail: new Uint8Array(THUMBNAIL_MAX_BYTES + 1) }));
        try {
          const row = db
            .prepare('SELECT thumb_state AS s FROM message_attachments WHERE message_id = ?')
            .get(message.id) as { s: string };
          expect(row.s).toBe('none');
          expect(loadAttachments(db, message.ref)[0]?.thumbPath).toBe(null);
        } finally {
          db.close();
        }
      });
    });

    await it('removes the file with its message row', async () => {
      await withThumbsDir(async (root) => {
        const { db, backend, message } = await syncOne(photo({ thumbnail: TINY }));
        try {
          backend.canProbe = true;
          expect(existsSync(thumbPath(message.id, 0, root))).toBe(true);
          backend.chats.get('1002')!.messages = [];
          await syncChats(db, backend, { fullScan: true, probeDepth: 5 });
          expect(existsSync(thumbPath(message.id, 0, root))).toBe(false);
        } finally {
          db.close();
        }
      });
    });
  });

  await describe('thumbnail handle fetch', async () => {
    const fetcherOf = (bytes: Uint8Array | Error, seen: string[] = []): AttachmentFetcher => ({
      fetchAttachment: async (_account, attachment, sink) => {
        seen.push(attachment.handle);
        if (bytes instanceof Error) throw bytes;
        await sink.write(bytes);
        sink.close();
        return { mimeType: 'image/jpeg', size: bytes.length };
      },
    });

    await it('looks up the thumb handle, not the file handle, and flags the part fetchable', async () => {
      await withThumbsDir(async () => {
        const { db, message } = await syncOne(photo({ thumbHandle: 'thumb-h' }));
        try {
          const target = loadThumbTarget(db, message.ref, 0);
          expect(target?.handle).toBe('thumb-h');
          expect(target?.state).toBe(null);
          expect(loadAttachments(db, message.ref)[0]?.thumbFetchable).toBe(true);
        } finally {
          db.close();
        }
      });
    });

    await it('stores the bytes 0600, marks stored, and stops offering the handle', async () => {
      await withThumbsDir(async (root) => {
        const { db, message } = await syncOne(photo({ thumbHandle: 'thumb-h' }));
        try {
          const seen: string[] = [];
          const stored = await storeThumbnail(db, fetcherOf(TINY, seen), message.ref, 0, { root });
          expect(seen).toStrictEqual(['thumb-h']);
          expect(stored?.path).toBe(thumbPath(message.id, 0, root));
          expect(readFileSync(thumbPath(message.id, 0, root)).length).toBe(TINY.length);
          expect(statSync(thumbPath(message.id, 0, root)).mode & 0o777).toBe(0o600);
          expect(loadThumbTarget(db, message.ref, 0)).toBe(null);
          const [part] = loadAttachments(db, message.ref);
          expect(part?.thumbPath).toBe(thumbPath(message.id, 0, root));
          expect(part?.thumbFetchable).toBe(false);
        } finally {
          db.close();
        }
      });
    });

    await it('marks failed on a fetch error and keeps the handle for one retry', async () => {
      await withThumbsDir(async (root) => {
        const { db, message } = await syncOne(photo({ thumbHandle: 'thumb-h' }));
        try {
          let thrown = false;
          await storeThumbnail(db, fetcherOf(new Error('offline')), message.ref, 0, { root }).catch(() => {
            thrown = true;
          });
          expect(thrown).toBe(true);
          expect(existsSync(thumbPath(message.id, 0, root))).toBe(false);
          expect(loadThumbTarget(db, message.ref, 0)?.state).toBe('failed');
          expect(loadAttachments(db, message.ref)[0]?.thumbFetchable).toBe(true);
          setThumbState(db, message.id, 0, 'none');
          expect(loadThumbTarget(db, message.ref, 0)).toBe(null);
        } finally {
          db.close();
        }
      });
    });

    await it('has nothing to fetch without a handle, and caps fetched thumbnails above the inline cap', async () => {
      await withThumbsDir(async (root) => {
        const { db, message } = await syncOne(photo({ thumbnail: TINY }));
        try {
          expect(await storeThumbnail(db, fetcherOf(TINY), message.ref, 0, { root })).toBe(null);
        } finally {
          db.close();
        }
        expect(THUMBNAIL_FETCH_MAX_BYTES > THUMBNAIL_MAX_BYTES).toBe(true);
      });
    });

    await it('never puts a handle into the window DTO', async () => {
      await withThumbsDir(async () => {
        const { db, message } = await syncOne(photo({ thumbHandle: 'thumb-h' }));
        try {
          const json = JSON.stringify(loadAttachments(db, message.ref));
          expect(json.includes('thumb-h')).toBe(false);
          expect(json.includes('fileId')).toBe(false);
          expect(json.includes('"thumbHandle"')).toBe(false);
        } finally {
          db.close();
        }
      });
    });
  });
};
