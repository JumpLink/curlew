import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listConversations, searchIndex } from '@curlew/store';
import { accountSetDeltaChat, accountSetPlainMail } from '../../../src/core/actions/accounts.ts';
import { conversationsList } from '../../../src/core/actions/conversations.ts';
import { indexSearch, openIndex } from '../../../src/core/actions/index-sync.ts';
import { defaultConfig, loadConfig, parseConfig, saveConfig } from '../../../src/core/config.ts';
import { carrierOf, chatOnlyAccountIds } from '../../../src/core/visibility.ts';
import { showAllEmailsSubtitle } from '../../../src/window/email-chat-model.ts';
import { loadConversationEntries } from '../../../src/window/conversation-list-store.ts';
import { applyPlainMailChoice, welcomeSummary } from '../../../src/window/welcome-model.ts';
import { freshDb } from '../store/fixtures.ts';

/** Switching ordinary email off per mail account: a read filter, nothing leaves the index. Synthetic data. */

type Db = ReturnType<typeof freshDb>;

function thread(db: Db, id: string, account: string, emailChat: boolean): void {
  db.prepare(
    `INSERT INTO conversations (id, backend, account_id, kind, title, classification, classification_reason, email_chat)
     VALUES (?, 'mail', ?, 'direct', ?, 'chat', 'synthetic', ?)`,
  ).run(id, account, `Thread ${id}`, emailChat ? 1 : 0);
}

function indexed(db: Db, uid: number, account: string, emailChat: boolean): void {
  db.prepare(
    `INSERT INTO messages (account_id, folder_path, uid, subject, sender, email_chat, indexed_at)
     VALUES (?, 'INBOX', ?, 'hello needle', 'a@example.org', ?, '2026-11-01T00:00:00Z')`,
  ).run(account, uid, emailChat ? 1 : 0);
}

export default async () => {
  await describe('plain mail switched off per account', async () => {
    await it('migrates the old list and keeps only non-default values', async () => {
      const config = parseConfig('{"deltaChatAccounts":["a","b"],"mailAccounts":{"b":{"deltaChat":false}}}');
      expect(config.mailAccounts).toStrictEqual({ a: { deltaChat: true } });
      expect(parseConfig('{"mailAccounts":{"a":{"plainMail":true,"deltaChat":false}}}').mailAccounts).toBe(
        undefined,
      );
      // Only email chats are listed, so the account has to send them.
      expect(parseConfig('{"mailAccounts":{"a":{"plainMail":false}}}').mailAccounts).toStrictEqual({
        a: { deltaChat: true, plainMail: false },
      });
    });

    await it('writes mailAccounts, drops the old key, and the switches move together', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-plain-'));
      try {
        const path = join(dir, 'config.json');
        writeFileSync(path, '{"deltaChatAccounts":["a"]}');
        saveConfig(loadConfig(path), path);
        const text = readFileSync(path, 'utf8');
        expect(text.includes('deltaChatAccounts')).toBe(false);
        expect(loadConfig(path).mailAccounts).toStrictEqual({ a: { deltaChat: true } });
        accountSetPlainMail('b', false, path);
        expect(loadConfig(path).mailAccounts?.b).toStrictEqual({ deltaChat: true, plainMail: false });
        accountSetDeltaChat('b', false, path);
        expect(loadConfig(path).mailAccounts?.b).toBe(undefined);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('names the chat-only accounts and shows the thread as Delta Chat', async () => {
      const config = defaultConfig();
      applyPlainMailChoice(config, 'a', false);
      expect(chatOnlyAccountIds(config)).toStrictEqual(['a']);
      expect(carrierOf('mail', 'a', false, config)).toBe('deltachat');
      expect(carrierOf('mail', 'b', false, config)).toBe('mail');
      expect(welcomeSummary(config, 1).find((r) => r.title === 'Ordinary email')?.value).toBe(
        'Off for 1 account',
      );
      expect(showAllEmailsSubtitle(1).includes('1 account')).toBe(true);
    });

    await it('leaves ordinary mail of the account out of a listing, others untouched', async () => {
      const db = freshDb();
      try {
        thread(db, 'c1', 'a', false);
        thread(db, 'c2', 'a', true);
        thread(db, 'c3', 'b', false);
        const ids = (chatOnlyAccounts: string[]) =>
          listConversations(db, { chatOnlyAccounts })
            .map((c) => c.id)
            .sort();
        expect(ids(['a'])).toStrictEqual(['c2', 'c3']);
        expect(ids([])).toStrictEqual(['c1', 'c2', 'c3']);
      } finally {
        db.close();
      }
    });

    await it('beats showAllEmails in the list and the action, and comes back when switched on', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-plain-'));
      try {
        const dbPath = join(dir, 'index.db');
        const cfg = join(dir, 'config.json');
        const db = openIndex(dbPath);
        try {
          thread(db, 'c1', 'a', false);
          thread(db, 'c2', 'a', true);
          thread(db, 'c3', 'b', false);
          indexed(db, 1, 'a', false);
          indexed(db, 2, 'a', true);
          indexed(db, 3, 'b', false);
        } finally {
          db.close();
        }
        const config = defaultConfig();
        config.ui.showAllEmails = true;
        saveConfig(config, cfg);
        expect(loadConversationEntries(dbPath, cfg).length).toBe(3);
        applyPlainMailChoice(config, 'a', false);
        saveConfig(config, cfg);
        expect(
          conversationsList({ dbPath, configPath: cfg })
            .conversations.map((c) => c.id)
            .sort(),
        ).toStrictEqual(['c2', 'c3']);
        expect(loadConversationEntries(dbPath, cfg).length).toBe(2);
        expect(indexSearch({ subject: 'needle' }, dbPath, cfg).messages.length).toBe(2);
        applyPlainMailChoice(config, 'a', true);
        saveConfig(config, cfg);
        expect(loadConversationEntries(dbPath, cfg).length).toBe(3);
        expect(indexSearch({ subject: 'needle' }, dbPath, cfg).messages.length).toBe(3);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('searches with the store criterion directly', async () => {
      const db = freshDb();
      try {
        indexed(db, 1, 'a', false);
        indexed(db, 2, 'a', true);
        expect(searchIndex(db, { chatOnlyAccounts: ['a'] }).length).toBe(1);
        expect(searchIndex(db, { chatOnlyAccounts: [] }).length).toBe(2);
      } finally {
        db.close();
      }
    });
  });
};
