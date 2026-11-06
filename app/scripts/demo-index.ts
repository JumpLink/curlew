/**
 * Writes a synthetic index for screenshots: `node --experimental-strip-types app/scripts/demo-index.ts <dir>`
 * creates `<dir>/index.db` and `<dir>/config.json` with a few agent-access rules. Then run the window with
 * `CURLEW_DB_PATH=<dir>/index.db CURLEW_CONFIG=<dir>/config.json` under `scripts/headless-run`.
 * Every name and address here is made up (`example.org`); never point this at a real index.
 */

import { migrate, openIndexDb } from '@curlew/store';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: demo-index.ts <dir>');
  process.exit(2);
}
mkdirSync(dir, { recursive: true });
// A few agent-access rules, so the dialog shows a contact rule and a whole-account rule.
const config = {
  agentAccess: {
    askWithoutRule: true,
    rules: [
      { account: 'xmpp-demo1', contact: 'jo@chat.example.org', read: 'allow', write: 'ask' },
      { account: 'mail-demo1', read: 'allow', write: 'deny' },
      { account: 'signal-demo1', write: 'ask' },
    ],
  },
};
writeFileSync(join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);

const ACCOUNTS: Array<[id: string, identity: string]> = [
  ['mail-demo1', 'robin@example.org'],
  ['xmpp-demo1', 'robin@chat.example.org'],
  ['signal-demo1', 'Robin (Signal)'],
  ['matrix-demo1', '@robin:example.org'],
  ['whatsapp-demo1', 'Robin (WhatsApp)'],
];

type Row = [
  id: string,
  backend: string,
  account: string,
  kind: string,
  title: string,
  minutesAgo: number,
  unread: number,
];
const CONVERSATIONS: Row[] = [
  ['c1', 'signal', 'signal-demo1', 'direct', 'Alex Weber', 4, 2],
  ['c2', 'matrix', 'matrix-demo1', 'group', 'GNOME Design', 18, 14],
  ['c3', 'mail', 'mail-demo1', 'direct', 'Sam Fischer', 52, 1],
  ['c4', 'whatsapp', 'whatsapp-demo1', 'group', 'Climbing Tuesday', 95, 0],
  ['c5', 'xmpp', 'xmpp-demo1', 'direct', 'Jo Klein', 180, 0],
  ['c6', 'signal', 'signal-demo1', 'group', 'Family', 60 * 20, 0],
  ['c7', 'mail', 'mail-demo1', 'direct', 'Kim Becker', 60 * 30, 0],
  ['c8', 'matrix', 'matrix-demo1', 'direct', 'Dana Wolf', 60 * 50, 0],
  ['c9', 'whatsapp', 'whatsapp-demo1', 'direct', 'Lee Hoffmann', 60 * 80, 0],
  ['c10', 'xmpp', 'xmpp-demo1', 'group', 'Book club', 60 * 120, 0],
  ['c11', 'mail', 'mail-demo1', 'direct', 'Monitoring Alerts', 60 * 200, 0],
];

const db = openIndexDb(join(dir, 'index.db'));
try {
  migrate(db);
  const account = db.prepare('INSERT OR REPLACE INTO accounts (id, identity, provider) VALUES (?, ?, ?)');
  for (const [id, identity] of ACCOUNTS) account.run(id, identity, id.split('-')[0]);
  const conversation = db.prepare(
    `INSERT OR REPLACE INTO conversations (id, backend, account_id, kind, title, classification,
       classification_reason, first_message_at, last_message_at, message_count, unread_count)
     VALUES (?, ?, ?, ?, ?, 'conversational', 'default', ?, ?, 10, ?)`,
  );
  const now = Date.now();
  for (const [id, backend, acc, kind, title, minutesAgo, unread] of CONVERSATIONS) {
    const at = new Date(now - minutesAgo * 60_000).toISOString();
    conversation.run(id, backend, acc, kind, title, at, at, unread);
  }

  // Two conversations with a person and a history, so the conversation view has something to show:
  // an email chat (Delta Chat's `Chat-Version` marker) and an XMPP chat.
  const participant = db.prepare('INSERT OR REPLACE INTO participants (id, display_name) VALUES (?, ?)');
  const address = db.prepare('INSERT OR REPLACE INTO participant_addresses (participant_id, kind, value) VALUES (?, ?, ?)');
  const member = db.prepare('INSERT OR REPLACE INTO conversation_participants (conversation_id, participant_id) VALUES (?, ?)');
  for (const [conversationId, id, name, kind, value] of [
    ['c3', 'p-sam', 'Sam Fischer', 'email', 'sam@example.org'],
    ['c5', 'p-jo', 'Jo Klein', 'jid', 'jo@chat.example.org'],
  ]) {
    participant.run(id, name);
    address.run(id, kind, value);
    member.run(conversationId, id);
  }
  db.prepare(`UPDATE conversations SET email_chat = 1 WHERE id = 'c3'`).run();

  type Line = [conversation: string, fromSelf: boolean, minutesAgo: number, text: string, subject: string | null];
  const HISTORY: Line[] = [
    ['c3', false, 60 * 26, 'Are we still on for the garden day on Saturday?', 'Chat: Garden day'],
    ['c3', true, 60 * 25, 'Yes! I will bring the seedlings and some coffee.', 'Chat: Garden day'],
    ['c3', false, 70, 'Great. Could you also bring the long ladder?', 'Chat: Garden day'],
    ['c3', true, 60, 'Sure, it fits in the car.', 'Chat: Garden day'],
    ['c3', false, 52, 'Perfect, see you at ten.', 'Chat: Garden day'],
    ['c5', false, 200, 'Did the new release build on your machine?', null],
    ['c5', true, 190, 'It did, the tests are green on both runtimes.', null],
    ['c5', false, 180, 'Nice, then I will tag it tonight.', null],
  ];
  const message = db.prepare(
    `INSERT OR REPLACE INTO conversation_messages (id, conversation_id, backend, account_id, presentation,
       sender_participant_id, from_self, sent_at, subject, seen, classification, classification_reason,
       remote_id, body, email_chat, folder_path, uid, remote_seq)
     VALUES (?, ?, ?, ?, 'bubble', ?, ?, ?, ?, 1, 'conversational', 'default', ?, ?, ?, ?, ?, ?)`,
  );
  // A mail body lives once, in the FTS table, and a chat body on its row with a sequence —
  // the same split a real sync writes, so the view reads both the way it does in use.
  const mailRow = db.prepare(
    `INSERT OR REPLACE INTO messages (id, account_id, folder_path, uid, subject, date, seen, indexed_at)
     VALUES (?, ?, 'INBOX', ?, ?, ?, 1, ?)`,
  );
  const mailBody = db.prepare('INSERT OR REPLACE INTO messages_fts (rowid, subject, body) VALUES (?, ?, ?)');
  HISTORY.forEach(([conversationId, fromSelf, minutesAgo, text, subject], i) => {
    const [, backend, acc] = CONVERSATIONS.find(([id]) => id === conversationId)!;
    const sender = fromSelf ? null : conversationId === 'c3' ? 'p-sam' : 'p-jo';
    const at = new Date(now - minutesAgo * 60_000).toISOString();
    const mail = backend === 'mail';
    const n = i + 1;
    if (mail) {
      mailRow.run(n, acc, n, subject, at, at);
      mailBody.run(n, subject, text);
    }
    message.run(`m${n}`, conversationId, backend, acc, sender, fromSelf ? 1 : 0, at, subject, `r${n}`,
      mail ? null : text, mail ? 1 : 0, mail ? 'INBOX' : null, mail ? n : null, mail ? null : n);
  });

  // A long mail conversation (130 messages over several days, some with multi-paragraph bodies)
  // for the paging and the faded long body of the conversation view.
  participant.run('p-alerts', 'Monitoring Alerts');
  address.run('p-alerts', 'email', 'alerts@example.org');
  member.run('c11', 'p-alerts');
  db.prepare(`UPDATE conversations SET message_count = 130 WHERE id = 'c11'`).run();
  const paragraph = (k: number) =>
    `Paragraph ${k}: the nightly check of service ${k % 7} on host-${k}.example.org finished with warnings. ` +
    'The queue depth stayed above the soft limit for several minutes and the retry counter rose twice. ' +
    'No action is required unless the same warning appears again within the next hour.';
  for (let i = 0; i < 130; i++) {
    const n = 1000 + i;
    const long = i % 9 === 0 || i % 13 === 0;
    const text = long
      ? Array.from({ length: i % 13 === 0 ? 14 : 6 }, (_, k) => paragraph(i + k)).join('\n\n')
      : `Check ${i} on host-${i % 12}.example.org: all services healthy.`;
    const subject = i % 20 < 10 ? 'Nightly report' : 'Disk usage warning';
    const at = new Date(now - (60 * 200 + (129 - i) * 55) * 60_000).toISOString();
    mailRow.run(n, 'mail-demo1', n, subject, at, at);
    mailBody.run(n, subject, text);
    message.run(`m${n}`, 'c11', 'mail', 'mail-demo1', 'p-alerts', 0, at, subject, `r${n}`, null, 0, 'INBOX', n, null);
  }
} finally {
  db.close();
}
