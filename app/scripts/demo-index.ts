/**
 * Writes a synthetic index for screenshots: `node --experimental-strip-types app/scripts/demo-index.ts <dir>`
 * creates `<dir>/index.db` and an empty `<dir>/config.json`. Then run the window with
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
writeFileSync(join(dir, 'config.json'), '{}\n');

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
} finally {
  db.close();
}
