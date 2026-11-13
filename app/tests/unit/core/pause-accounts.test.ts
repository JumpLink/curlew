import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChangeRow } from '@curlew/store';
import { listConversations } from '@curlew/store';
import { openIndex } from '../../../src/core/actions/index-sync.ts';
import { conversationsList } from '../../../src/core/actions/conversations.ts';
import { accountConversationCount } from '../../../src/core/actions/accounts.ts';
import { createDaemonSendHandler } from '../../../src/core/actions/daemon.ts';
import { refuseIfPaused } from '../../../src/core/actions/send.ts';
import { defaultConfig, saveConfig } from '../../../src/core/config.ts';
import { DAEMON_WIRE_VERSION, type DaemonSendRequest } from '../../../src/core/lib/daemon-bus.ts';
import { newNoticeState, planNotices } from '../../../src/core/lib/message-notices.ts';
import { hiddenAccountIds, isAccountPaused } from '../../../src/core/visibility.ts';
import { pauseBody } from '../../../src/window/account-pause-model.ts';
import { loadConversationEntries } from '../../../src/window/conversation-list-store.ts';
import { freshDb } from '../store/fixtures.ts';

/** Pausing an account is a read filter: the rows stay, nothing shows, nothing sends. Synthetic data. */

type Db = ReturnType<typeof freshDb>;

function conversation(db: Db, id: string, backend: string, account: string, title: string): void {
  db.prepare(
    `INSERT INTO conversations (id, backend, account_id, kind, title, classification, classification_reason)
     VALUES (?, ?, ?, 'direct', ?, 'chat', 'synthetic')`,
  ).run(id, backend, account, title);
}

function world(): { dir: string; db: string; cfg: string } {
  const dir = mkdtempSync(join(tmpdir(), 'curlew-pause-'));
  const db = join(dir, 'index.db');
  const handle = openIndex(db);
  try {
    conversation(handle, 'c1', 'xmpp', 'xmpp-a', 'Alex Example');
    conversation(handle, 'c2', 'mail', 'mail-a', 'Thread one');
    conversation(handle, 'c3', 'xmpp', 'xmpp-b', 'Robin Example');
  } finally {
    handle.close();
  }
  return { dir, db, cfg: join(dir, 'config.json') };
}

export default async () => {
  await describe('pausing an account', async () => {
    await it('names the paused account ids once, whatever the backend', async () => {
      const config = defaultConfig();
      config.disabledAccounts = ['xmpp/xmpp-a', 'mail/mail-a', 'telegram/xmpp-a'];
      expect(hiddenAccountIds(config).join(',')).toBe('xmpp-a,mail-a');
      expect(isAccountPaused(config, 'mail', 'mail-a')).toBe(true);
      expect(isAccountPaused(config, 'xmpp', 'mail-a')).toBe(false);
      expect(hiddenAccountIds(defaultConfig()).length).toBe(0);
    });

    await it('leaves the excluded accounts out of a conversation listing', async () => {
      const db = freshDb();
      try {
        conversation(db, 'c1', 'xmpp', 'a', 'One');
        conversation(db, 'c2', 'mail', 'b', 'Two');
        conversation(db, 'c3', 'xmpp', 'c', 'Three');
        expect(listConversations(db, { excludeAccounts: ['a', 'b'] }).map((c) => c.id)).toStrictEqual(['c3']);
        expect(listConversations(db, { excludeAccounts: [] }).length).toBe(3);
      } finally {
        db.close();
      }
    });

    await it('hides paused chats and mail from the list, the MCP/CLI action and the count', async () => {
      const w = world();
      try {
        const config = defaultConfig();
        config.ui.showAllEmails = true;
        saveConfig(config, w.cfg);
        expect(conversationsList({ dbPath: w.db, configPath: w.cfg }).count).toBe(3);
        expect(loadConversationEntries(w.db, w.cfg).length).toBe(3);
        config.disabledAccounts = ['xmpp/xmpp-a', 'mail/mail-a'];
        saveConfig(config, w.cfg);
        const listed = conversationsList({ dbPath: w.db, configPath: w.cfg });
        expect(listed.conversations.map((c) => c.id)).toStrictEqual(['c3']);
        expect(loadConversationEntries(w.db, w.cfg).length).toBe(1);
        // Pausing deletes nothing: the rows are still counted, and come back when switched on.
        expect(accountConversationCount('xmpp-a', w.db)).toBe(1);
        saveConfig({ ...config, disabledAccounts: [] }, w.cfg);
        expect(conversationsList({ dbPath: w.db, configPath: w.cfg }).count).toBe(3);
      } finally {
        rmSync(w.dir, { recursive: true, force: true });
      }
    });

    await it('announces nothing for a paused account', async () => {
      const db = freshDb();
      try {
        conversation(db, 'c1', 'telegram', 'acct', 'Alex Example');
        db.prepare(
          `INSERT INTO conversation_messages
             (id, conversation_id, backend, account_id, presentation, sender_name, from_self, sent_at, seen,
              has_attachments, classification, classification_reason, remote_id, remote_seq, body)
           VALUES ('m1', 'c1', 'telegram', 'acct', 'bubble', 'Alex Example', 0, '2026-11-08T10:05:00Z', 0, 0,
                   'chat', 'synthetic', 'm1', 1, 'Hello there')`,
        ).run();
        const changes: ChangeRow[] = [
          { seq: 1, at: '', kind: 'messages', backend: 'telegram', accountId: 'acct', conversationId: 'c1' },
        ];
        const since = new Date('2026-11-08T10:00:00Z');
        expect(planNotices(db, changes, 'preview', newNoticeState(since), ['acct']).length).toBe(0);
        expect(planNotices(db, changes, 'preview', newNoticeState(since), []).length).toBe(1);
      } finally {
        db.close();
      }
    });

    await it('refuses a send from a paused account instead of failing silently', async () => {
      const config = defaultConfig();
      config.disabledAccounts = ['xmpp/xmpp-a'];
      expect(() => refuseIfPaused(config, 'xmpp-a')).toThrow(/paused/);
      expect(() => refuseIfPaused(config, 'xmpp-b')).not.toThrow();

      const lines: string[] = [];
      let paused = true;
      const handler = createDaemonSendHandler({
        sessions: new Map(),
        log: (line) => lines.push(line),
        isPaused: () => paused,
      });
      const request = {
        v: DAEMON_WIRE_VERSION,
        backend: 'xmpp',
        account: 'xmpp-a',
        capability: 'xmpp.send',
        to: 'alex@example.org',
        text: 'hi',
      } as DaemonSendRequest;
      const reply = await handler(request);
      expect(reply.kind).toBe('refused');
      expect(lines.some((l) => l.includes('paused'))).toBe(true);
      paused = false;
      expect((await handler(request)).kind).toBe('not-followed');
    });

    await it('says how many conversations the pause hides', async () => {
      expect(pauseBody(24).includes('24 conversations')).toBe(true);
      expect(pauseBody(1).includes('1 conversation ')).toBe(true);
      expect(pauseBody(0).includes('Nothing is deleted')).toBe(true);
    });
  });
};
