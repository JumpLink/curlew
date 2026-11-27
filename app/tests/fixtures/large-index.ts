/**
 * A synthetic LARGE index for the responsiveness measurements (#501, #541): thousands of chat
 * conversations, one very long history with media, and a mail folder, written straight into the
 * index tables the window reads.
 *
 * Every account, name, address and body is made up (`example.invalid`, `Ana Rowan 17`);
 * nothing here reads, copies or resembles a real index. The real index is never an input to a
 * measurement — that is the whole point of this file.
 *
 * Runs on Node (`app/scripts/perf-index.ts`) and on GJS (the perf harnesses import it).
 */

import { migrate, openIndexDb, searchKey, withTransaction, type SqlValue } from '@curlew/store';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LargeIndexOptions {
  /** Chat conversations, spread over the five chat backends. */
  chats?: number;
  /** Mail conversations. */
  mails?: number;
  /** Messages in total, the long history included. */
  messages?: number;
  /** Messages in the one conversation with a long history. Defaults to a fifth of `messages`. */
  longHistory?: number;
  /** Attachment rows on the long history (pictures, a video, a voice note). */
  media?: number;
}

export interface LargeIndexSummary {
  conversations: number;
  messages: number;
  attachments: number;
  /** The conversation with the long history and the media. */
  longId: string;
  /** An ordinary conversation, for the second half of a chat switch. */
  shortId: string;
  /** A word that occurs in a few thousand bodies, for the search scenario. */
  searchWord: string;
}

const BACKENDS = [
  { name: 'signal', account: 'signal-perf1', kind: 'signal' },
  { name: 'telegram', account: 'telegram-perf1', kind: 'telegram' },
  { name: 'whatsapp', account: 'whatsapp-perf1', kind: 'whatsapp' },
  { name: 'matrix', account: 'matrix-perf1', kind: 'matrix' },
  { name: 'xmpp', account: 'xmpp-perf1', kind: 'jid' },
] as const;

const MAIL_ACCOUNT = 'mail-perf1';

/** Deterministic, so two runs of the generator produce the same index. */
function pseudo(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

const WORDS = [
  'harbour',
  'ladder',
  'seedling',
  'coffee',
  'invoice',
  'lighthouse',
  'rehearsal',
  'bicycle',
  'allotment',
  'timetable',
  'postcard',
  'kettle',
];

/** The word the search scenario looks for; frequent enough to make the match list real work. */
const SEARCH_WORD = 'lighthouse';

// Made-up names, combined into "<given> <family> <n>". The variety is not decoration: the merge
// assistant buckets rows by their first word, so a fixture where every row reads "Test Person N"
// puts all 10 000 into one bucket and measures a quadratic scan that no real address book has.
const GIVEN = [
  'Ana',
  'Bo',
  'Caro',
  'Dana',
  'Emil',
  'Faye',
  'Gero',
  'Hana',
  'Ivo',
  'Juno',
  'Kai',
  'Lior',
  'Mara',
  'Nils',
  'Oona',
  'Pia',
  'Quin',
  'Rune',
  'Sora',
  'Tove',
  'Udo',
  'Vera',
  'Wim',
  'Xenia',
  'Yann',
  'Zola',
];
const FAMILY = [
  'Alder',
  'Birch',
  'Cedar',
  'Dahlia',
  'Elm',
  'Fern',
  'Gorse',
  'Hazel',
  'Iris',
  'Juniper',
  'Kelp',
  'Larch',
  'Myrtle',
  'Nettle',
  'Olive',
  'Poplar',
  'Quince',
  'Rowan',
  'Sorrel',
  'Thistle',
];

/** A made-up person name for row `n`; the trailing number keeps every row distinct. */
function personName(n: number): string {
  return `${GIVEN[n % GIVEN.length]!} ${FAMILY[(n * 7 + 3) % FAMILY.length]!} ${n}`;
}

function body(n: number): string {
  const a = WORDS[n % WORDS.length]!;
  const b = WORDS[(n * 7 + 3) % WORDS.length]!;
  const long = n % 23 === 0;
  const line = `Message ${n} about the ${a} and the ${b}.`;
  return long ? Array.from({ length: 8 }, (_, k) => `${line} Paragraph ${k + 1}.`).join('\n\n') : line;
}

const LONG_ID = 'perf-chat-long';

/**
 * Write the whole fixture into `dir`, replacing an earlier one: `<dir>/index.db` and
 * `<dir>/config.json`. Never touches anything outside `dir`.
 */
export function generateLargeIndex(dir: string, options: LargeIndexOptions = {}): LargeIndexSummary {
  const chats = options.chats ?? 10_000;
  const mails = options.mails ?? 500;
  const total = options.messages ?? 100_000;
  // A fifth of the messages in one conversation: enough that opening it is real work, while a
  // smaller `messages` (the CI size) stays smaller everywhere rather than only in the tail.
  const longHistory = Math.min(options.longHistory ?? Math.floor(total / 5), total);
  const media = options.media ?? 200;

  mkdirSync(dir, { recursive: true });
  for (const name of ['index.db', 'index.db-wal', 'index.db-shm', 'config.json'])
    rmSync(join(dir, name), { force: true });

  const terms = new Date().toISOString();
  writeFileSync(
    join(dir, 'config.json'),
    `${JSON.stringify(
      {
        backends: {
          mail: { enabled: true },
          xmpp: { enabled: true },
          signal: { enabled: true, termsAcceptedAt: terms },
          matrix: { enabled: true, termsAcceptedAt: terms },
          telegram: { enabled: true, termsAcceptedAt: terms },
          whatsapp: { enabled: true, termsAcceptedAt: terms },
        },
        ui: { welcomeDone: true, showAllEmails: true, notifications: 'off' },
      },
      null,
      2,
    )}\n`,
  );

  const now = Date.now();
  const at = (minutesAgo: number): string => new Date(now - minutesAgo * 60_000).toISOString();

  const summary: LargeIndexSummary = {
    conversations: chats + mails,
    messages: 0,
    attachments: 0,
    longId: LONG_ID,
    shortId: 'perf-chat-000001',
    searchWord: SEARCH_WORD,
  };

  const db = openIndexDb(join(dir, 'index.db'));
  try {
    migrate(db);
    withTransaction(db, () => {
      const accounts: SqlValue[][] = [
        ...BACKENDS.map((b) => [b.account, `@me_${b.name}`, b.name] as SqlValue[]),
        [MAIL_ACCOUNT, 'me@example.invalid', 'mail'],
      ];
      insertRows(db, 'INSERT OR REPLACE INTO accounts (id, identity, provider)', accounts);

      // ── the conversations ────────────────────────────────────────────
      const convRows: SqlValue[][] = [];
      const participantRows: SqlValue[][] = [];
      const addressRows: SqlValue[][] = [];
      const memberRows: SqlValue[][] = [];
      const cursorRows: SqlValue[][] = [];
      const flagRows: SqlValue[][] = [];
      /** conversation id → [backend, account, isGroup]. */
      const plan: Array<[string, string, string, boolean]> = [];

      // A handful of people who are in many groups, as a real address book has.
      for (let i = 0; i < 24; i++) {
        participantRows.push([`perf-shared-${i}`, personName(900_000 + i), null]);
        addressRows.push([`perf-shared-${i}`, 'signal', `shared-${i}@example.invalid`]);
      }

      for (let i = 0; i < chats; i++) {
        const b = BACKENDS[i % BACKENDS.length]!;
        const id = i === 0 ? LONG_ID : `perf-chat-${String(i).padStart(6, '0')}`;
        const group = i % 9 === 0;
        plan.push([id, b.name, b.account, group]);
        // The two chats the switch scenario opens are the NEWEST, so they are inside the list the
        // window loads: switching between two chats that are both on screen is the move that
        // froze the window (#541), and a chat outside the loaded list takes a different path.
        const minutes = i < 2 ? 3 + i : Math.floor(pseudo(i) * 60 * 24 * 400);
        const unread = i % 13 === 0 ? 1 + (i % 7) : 0;
        convRows.push([
          id,
          b.name,
          b.account,
          group ? 'group' : 'direct',
          group ? `${FAMILY[i % FAMILY.length]!} group ${i}` : personName(i),
          'conversational',
          'default',
          at(minutes + 10_000),
          at(minutes),
          0,
          unread,
          0,
        ]);
        if (group) {
          for (let k = 0; k < 3; k++) memberRows.push([id, `perf-shared-${(i + k * 5) % 24}`]);
          if (b.name === 'matrix' || b.name === 'telegram')
            cursorRows.push([id, b.name, b.account, `!room-${i}:example.invalid`, 'group', 2 + (i % 40)]);
        } else {
          const pid = `perf-person-${i}`;
          participantRows.push([pid, personName(i), null]);
          addressRows.push([pid, b.kind, `person-${i}@example.invalid`]);
          memberRows.push([id, pid]);
        }
        if (i % 97 === 0) flagRows.push([id, 1, at(minutes), 0, null]);
        else if (i % 101 === 0) flagRows.push([id, 0, null, 1, at(minutes)]);
      }
      for (let i = 0; i < mails; i++) {
        const id = `perf-mail-${String(i).padStart(5, '0')}`;
        plan.push([id, 'mail', MAIL_ACCOUNT, false]);
        const minutes = Math.floor(pseudo(i + 500_000) * 60 * 24 * 400);
        convRows.push([
          id,
          'mail',
          MAIL_ACCOUNT,
          'direct',
          personName(500_000 + i),
          'conversational',
          'default',
          at(minutes + 20_000),
          at(minutes),
          0,
          i % 11 === 0 ? 1 : 0,
          0,
        ]);
        const pid = `perf-mailer-${i}`;
        participantRows.push([pid, personName(500_000 + i), null]);
        addressRows.push([pid, 'email', `sender-${i}@example.invalid`]);
        memberRows.push([id, pid]);
      }

      insertRows(
        db,
        `INSERT OR REPLACE INTO conversations (id, backend, account_id, kind, title, classification,
           classification_reason, first_message_at, last_message_at, message_count, unread_count, has_attachments)`,
        convRows,
      );
      insertRows(db, 'INSERT OR REPLACE INTO participants (id, display_name, contact_uid)', participantRows);
      insertRows(
        db,
        'INSERT OR REPLACE INTO participant_addresses (participant_id, kind, value)',
        addressRows,
      );
      insertRows(
        db,
        'INSERT OR REPLACE INTO conversation_participants (conversation_id, participant_id)',
        memberRows,
      );
      insertRows(
        db,
        `INSERT OR REPLACE INTO chat_cursors (conversation_id, backend, account_id, chat_id, kind, room_members)`,
        cursorRows,
      );
      insertRows(
        db,
        `INSERT OR REPLACE INTO conversation_flags (conversation_id, muted, muted_at, favourite, favourite_at)`,
        flagRows,
      );

      // ── the messages ─────────────────────────────────────────────────
      // The long history first, then the rest spread over every other conversation.
      let seq = 0;
      const attachmentRows: SqlValue[][] = [];
      const messageRows: SqlValue[][] = [];
      const flush = (): void => {
        if (messageRows.length === 0) return;
        insertRows(
          db,
          `INSERT OR REPLACE INTO conversation_messages (id, conversation_id, backend, account_id, presentation,
             sender_participant_id, sender_name, sender_kind, sender_address, from_self, sent_at, subject, seen,
             classification, classification_reason, remote_id, body, email_chat, remote_seq, has_attachments,
             search_key)`,
          messageRows,
        );
        messageRows.length = 0;
      };
      const addMessage = (
        conv: string,
        backend: string,
        account: string,
        minutesAgo: number,
        text: string,
        attachments: number,
      ): void => {
        const n = ++seq;
        const mail = backend === 'mail';
        const fromSelf = n % 3 === 0;
        const subject = mail ? `Test subject ${n}` : null;
        messageRows.push([
          `perf-m${n}`,
          conv,
          backend,
          account,
          'bubble',
          fromSelf ? null : `perf-sender-${n % 24}`,
          fromSelf ? null : personName(900_000 + (n % 24)),
          fromSelf ? null : 'signal',
          fromSelf ? null : `shared-${n % 24}@example.invalid`,
          fromSelf ? 1 : 0,
          at(minutesAgo),
          subject,
          1,
          'conversational',
          'default',
          `perf-r${n}`,
          mail ? null : text,
          0,
          mail ? null : n,
          attachments > 0 ? 1 : 0,
          searchKey(subject, mail ? null : text),
        ]);
        summary.messages++;
        for (let k = 0; k < attachments; k++) {
          const picture = k % 3 !== 2;
          attachmentRows.push([
            `perf-m${n}`,
            k,
            picture ? `picture-${n}-${k}.png` : `clip-${n}-${k}.mp4`,
            picture ? 'image/png' : 'video/mp4',
            picture ? 180_000 : 1_400_000,
            picture ? 'image' : 'video',
            480,
            320,
            picture ? null : 3000,
          ]);
          summary.attachments++;
        }
        if (messageRows.length >= 2000) flush();
      };

      for (let i = 0; i < longHistory; i++) {
        const mediaHere = i >= longHistory - media * 4 && i % 4 === 0 ? 1 + (i % 3) : 0;
        addMessage(
          LONG_ID,
          BACKENDS[0]!.name,
          BACKENDS[0]!.account,
          (longHistory - i) * 7,
          body(i),
          mediaHere,
        );
      }
      const rest = Math.max(0, total - longHistory);
      const others = plan.slice(1);
      for (let n = 0; n < rest; n++) {
        const [id, backend, account] = others[n % others.length]!;
        addMessage(id, backend, account, 10 + Math.floor(n / others.length) * 90, body(n + longHistory), 0);
      }
      flush();
      insertRows(
        db,
        `INSERT OR REPLACE INTO message_attachments (message_id, idx, filename, mime_type, size, kind,
           width, height, duration_ms)`,
        attachmentRows,
      );

      db.exec(
        `UPDATE conversations SET
           message_count = (SELECT COUNT(*) FROM conversation_messages WHERE conversation_id = conversations.id),
           has_attachments = (SELECT MAX(has_attachments) FROM conversation_messages WHERE conversation_id = conversations.id)
         WHERE EXISTS (SELECT 1 FROM conversation_messages WHERE conversation_id = conversations.id)`,
      );
    });
  } finally {
    db.close();
  }
  return summary;
}

/**
 * Multi-row insert with a wide budget. `insertMany`'s 120-value budget is tuned for the sync
 * engine's narrow rows; a 21-column message row would be four rows a statement, which is 25 000
 * statements for this fixture. Measured here: 600 values a statement writes it in a third of
 * the time. Fixture code only — the sync engine keeps its measured budget.
 */
function insertRows(db: ReturnType<typeof openIndexDb>, head: string, rows: readonly SqlValue[][]): void {
  if (rows.length === 0) return;
  const perChunk = Math.max(1, Math.floor(600 / rows[0]!.length));
  for (let i = 0; i < rows.length; i += perChunk) {
    const chunk = rows.slice(i, i + perChunk);
    const tuple = `(${chunk[0]!.map(() => '?').join(', ')})`;
    db.prepare(`${head} VALUES ${chunk.map(() => tuple).join(', ')}`).run(...chunk.flat());
  }
}
