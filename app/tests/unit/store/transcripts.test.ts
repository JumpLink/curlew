import { describe, expect, it } from '@gjsify/unit';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadTranscript,
  migrate,
  openIndexDb,
  pruneTranscripts,
  saveTranscript,
  SCHEMA_VERSION,
} from '@curlew/store';

import { freshDb } from './fixtures.ts';

const message = (db: ReturnType<typeof freshDb>, id: string): void => {
  db.prepare(
    `INSERT INTO conversation_messages (id, conversation_id, backend, account_id, presentation, classification, classification_reason)
     VALUES (?, 'c1', 'signal', 'a1', 'chat', 'known', 'test')`,
  ).run(id);
};

export default async () => {
  await describe('voice-note transcripts', async () => {
    await it('reads back what was saved, silence included', async () => {
      const db = freshDb();
      message(db, 'm1');
      expect(loadTranscript(db, 'm1', 0)).toBe(null);
      saveTranscript(
        db,
        'm1',
        0,
        { text: 'hello there', language: 'en', engine: 'test' },
        new Date('2026-01-01T00:00:00Z'),
      );
      saveTranscript(db, 'm1', 1, { text: '', engine: 'test' });
      expect(loadTranscript(db, 'm1', 0)?.text).toBe('hello there');
      expect(loadTranscript(db, 'm1', 0)?.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(loadTranscript(db, 'm1', 1)?.text).toBe('');
      expect(loadTranscript(db, 'm1', 1)?.language).toBe(null);
    });
    await it('replaces a transcript saved twice', async () => {
      const db = freshDb();
      message(db, 'm1');
      saveTranscript(db, 'm1', 0, { text: 'one', engine: 'test' });
      saveTranscript(db, 'm1', 0, { text: 'two', engine: 'test' });
      expect(loadTranscript(db, 'm1', 0)?.text).toBe('two');
    });
    await it('prunes the transcripts of deleted messages only', async () => {
      const db = freshDb();
      message(db, 'm1');
      message(db, 'm2');
      saveTranscript(db, 'm1', 0, { text: 'a', engine: 'test' });
      saveTranscript(db, 'm2', 0, { text: 'b', engine: 'test' });
      db.prepare("DELETE FROM conversation_messages WHERE id = 'm1'").run();
      expect(pruneTranscripts(db)).toBe(1);
      expect(loadTranscript(db, 'm1', 0)).toBe(null);
      expect(loadTranscript(db, 'm2', 0)?.text).toBe('b');
    });
    await it('upgrades a copy of a v30 index and keeps its rows', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-transcripts-'));
      try {
        const path = join(dir, 'index.db');
        const first = openIndexDb(path);
        migrate(first);
        message(first, 'm1');
        first.exec('DROP TABLE attachment_transcripts');
        first
          .prepare(`INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', '30')`)
          .run();
        first.close();
        const copy = join(dir, 'copy.db');
        copyFileSync(path, copy);
        const db = openIndexDb(copy);
        try {
          migrate(db);
          const v = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as {
            value: string;
          };
          expect(Number(v.value)).toBe(SCHEMA_VERSION);
          saveTranscript(db, 'm1', 0, { text: 'kept', engine: 'test' });
          expect(loadTranscript(db, 'm1', 0)?.text).toBe('kept');
          expect(
            (db.prepare('SELECT COUNT(*) AS n FROM conversation_messages').get() as { n: number }).n,
          ).toBe(1);
        } finally {
          db.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
