/**
 * Transcripts of voice notes (schema v31, ADR 0012): computed once on the person's request and read
 * back from here, so a second look costs no CPU. Keyed by the message row and the attachment index.
 * The text is other people's words, so it goes with the message: `pruneTranscripts` runs after every
 * deletion and removes what no message owns any more.
 */

import type { IndexDatabase } from './db.ts';

export interface Transcript {
  text: string;
  language: string | null;
  engine: string;
  createdAt: string;
}

export interface TranscriptInput {
  text: string;
  language?: string | null;
  engine: string;
}

export function loadTranscript(db: IndexDatabase, messageId: string, index: number): Transcript | null {
  const row = db
    .prepare('SELECT text, language, engine, created_at FROM attachment_transcripts WHERE message_id = ? AND idx = ?')
    .get(messageId, index) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    text: String(row.text),
    language: row.language === null || row.language === undefined ? null : String(row.language),
    engine: String(row.engine),
    createdAt: String(row.created_at),
  };
}

/** Stores the transcript of one part; an empty text (silence) is stored too, so it is not asked for again. */
export function saveTranscript(
  db: IndexDatabase,
  messageId: string,
  index: number,
  transcript: TranscriptInput,
  now: Date = new Date(),
): void {
  db.prepare(
    `INSERT OR REPLACE INTO attachment_transcripts (message_id, idx, text, language, engine, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(messageId, index, transcript.text, transcript.language ?? null, transcript.engine, now.toISOString());
}

/** Removes the transcripts of messages that no longer exist; returns how many went. */
export function pruneTranscripts(db: IndexDatabase): number {
  const before = db.prepare('SELECT COUNT(*) AS n FROM attachment_transcripts').get() as { n: unknown };
  if (Number(before.n) === 0) return 0;
  db.prepare(
    'DELETE FROM attachment_transcripts WHERE message_id NOT IN (SELECT id FROM conversation_messages)',
  ).run();
  const after = db.prepare('SELECT COUNT(*) AS n FROM attachment_transcripts').get() as { n: unknown };
  return Number(before.n) - Number(after.n);
}
