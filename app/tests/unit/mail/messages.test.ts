import { describe, expect, it } from '@gjsify/unit';

import { ImapBackend, fetchPart, getMessage, listFolders, listParts, searchMail } from '@curlew/imap';
import { BufferSink, type MailStreamOpener, type MailTarget } from '@curlew/protocol';
import { createMemoryDriver, useSecretStoreDriver } from '@gjsify/secret-store';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeOwnAccount, type OwnMailAccount } from '../../../../packages/imap/src/own-accounts.ts';
import { ScriptedStream } from './scripted-stream.ts';

// Synthetic only: an example.org account and a scripted server, no socket. The point is that the
// mail functions and the backend take their transport from the caller (ADR 0018).
function target(accountId: string, getPassword: MailTarget['getPassword'] = () => 'synthetic'): MailTarget {
  return {
    accountId,
    host: 'imap.example.org',
    port: 993,
    user: `${accountId}@example.org`,
    implicitTls: true,
    getPassword,
  };
}

const GREETING = '* OK [CAPABILITY IMAP4rev1] ready\r\n';
const ENVELOPE =
  '("Mon, 2 Nov 2026 10:00:00 +0000" "Hello" (("Ada" NIL "ada" "example.org")) NIL NIL (("Bob" NIL "bob" "example.org")) NIL NIL NIL "<m1@example.org>")';
const STRUCTURE = '("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 5 1)';

const tagOf = (written: string) => written.split(' ')[0];

/** A server that logs in anyone and answers the commands the mail functions send. */
function server(extra: (written: string, tag: string) => string | undefined) {
  const streams: ScriptedStream[] = [];
  const opened: MailTarget[] = [];
  const opener: MailStreamOpener = async (t) => {
    opened.push(t);
    const stream = new ScriptedStream(GREETING, (w) => {
      const tag = tagOf(w);
      if (w.includes(' LOGIN ')) return `${tag} OK logged in\r\n`;
      if (w.includes(' LOGOUT')) return `* BYE\r\n${tag} OK bye\r\n`;
      if (w.includes(' EXAMINE ')) return `* 1 EXISTS\r\n${tag} OK done\r\n`;
      return extra(w, tag);
    });
    streams.push(stream);
    return stream;
  };
  return { opener, streams, opened };
}

export default async () => {
  await describe('mail functions over an injected opener', async () => {
    await it('searchMail connects through the opener of the source and returns summaries', async () => {
      const { opener, opened, streams } = server((w, tag) => {
        if (w.includes('UID SEARCH')) return `* SEARCH 5\r\n${tag} OK done\r\n`;
        if (w.includes('UID FETCH 5'))
          return `* 1 FETCH (UID 5 FLAGS (\\Seen) RFC822.SIZE 120 ENVELOPE ${ENVELOPE})\r\n${tag} OK done\r\n`;
        return undefined;
      });
      const found = await searchMail({ opener, resolveTargets: async () => [target('acc')] }, { limit: 5 });
      expect(opened.length).toBe(1);
      expect(opened[0].accountId).toBe('acc');
      expect(found.length).toBe(1);
      expect(found[0].uid).toBe('5');
      expect(found[0].folder).toBe('INBOX');
      expect(found[0].subject).toBe('Hello');
      expect(found[0].seen).toBe(true);
      // Read-only: no command of the whole conversation writes a flag.
      expect(streams[0].written.some((w) => /STORE|SELECT|EXPUNGE/.test(w))).toBe(false);
      expect(streams[0].closed > 0).toBe(true);
    });

    await it('searchMail keeps the other account when one cannot connect', async () => {
      const { opener } = server((w, tag) => {
        if (w.includes('UID SEARCH')) return `* SEARCH 5\r\n${tag} OK done\r\n`;
        if (w.includes('UID FETCH 5'))
          return `* 1 FETCH (UID 5 FLAGS () RFC822.SIZE 120 ENVELOPE ${ENVELOPE})\r\n${tag} OK done\r\n`;
        return undefined;
      });
      const failing: MailStreamOpener = (t) =>
        t.accountId === 'down' ? Promise.reject(new Error('connection refused')) : opener(t);
      const found = await searchMail(
        { opener: failing, resolveTargets: async () => [target('down'), target('up')] },
        {},
      );
      expect(found.map((m) => m.accountId)).toStrictEqual(['up']);
    });

    await it('searchMail fails with the cause when no account connects', async () => {
      const failing: MailStreamOpener = () => Promise.reject(new Error('connection refused'));
      await expect(
        searchMail({ opener: failing, resolveTargets: async () => [target('down')] }, {}),
      ).rejects.toThrow(/connection refused/);
    });

    await it('says what to do when there is no account', async () => {
      const { opener } = server(() => undefined);
      await expect(searchMail({ opener, resolveTargets: async () => [] }, {})).rejects.toThrow(
        /no mail account configured/,
      );
      await expect(listFolders({ opener, resolveTargets: async () => [] }, 'nope')).rejects.toThrow(
        /no mail account with id nope/,
      );
    });

    await it('listFolders reads the mailboxes through the opener', async () => {
      const { opener } = server((w, tag) =>
        w.includes(' LIST ')
          ? `* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\Sent) "/" "Sent"\r\n${tag} OK done\r\n`
          : undefined,
      );
      const folders = await listFolders({ opener, resolveTargets: async () => [target('acc')] });
      expect(folders.map((f) => f.path)).toStrictEqual(['INBOX', 'Sent']);
      expect(folders[0].accountId).toBe('acc');
    });

    await it('getMessage returns the body and logs out afterwards', async () => {
      const raw = 'Subject: Hello\r\nContent-Type: text/plain\r\n\r\nhello';
      const { opener, streams } = server((w, tag) =>
        w.includes('UID FETCH 9')
          ? `* 1 FETCH (UID 9 FLAGS () RFC822.SIZE ${raw.length} ENVELOPE ${ENVELOPE} BODY[] {${raw.length}}\r\n${raw})\r\n${tag} OK done\r\n`
          : undefined,
      );
      const source = { opener, resolveTargets: async () => [target('acc')] };
      const message = await getMessage(source, { accountId: 'acc', uid: '9' });
      expect(message.bodyText?.trim()).toBe('hello');
      expect(message.folder).toBe('INBOX');
      expect(streams[0].written.some((w) => w.includes('LOGOUT'))).toBe(true);
    });

    await it('listParts and fetchPart stream through the same opener', async () => {
      const { opener } = server((w, tag) => {
        if (w.includes('BODYSTRUCTURE'))
          return `* 1 FETCH (UID 9 BODYSTRUCTURE ${STRUCTURE})\r\n${tag} OK done\r\n`;
        if (w.includes('BODY.PEEK[1]')) return `* 1 FETCH (BODY[1] {5}\r\nhello)\r\n${tag} OK done\r\n`;
        return undefined;
      });
      const source = { opener, resolveTargets: async () => [target('acc')] };
      const parts = await listParts(source, { accountId: 'acc', uid: '9' });
      expect(parts.map((p) => p.section)).toStrictEqual(['1']);

      const sink = new BufferSink();
      const saved = await fetchPart(
        source,
        { accountId: 'acc', uid: '9', section: '1', maxBytes: 100 },
        () => sink,
      );
      expect(saved.bytes).toBe(5);
      expect(sink.closed).toBe(true);
    });
  });

  await describe('ImapBackend over an injected opener', async () => {
    await it('connects an own account through the opener, logs in and opens read-only', async () => {
      useSecretStoreDriver(createMemoryDriver());
      const dir = join(mkdtempSync(join(tmpdir(), 'curlew-mail-')), 'mail');
      try {
        const account: OwnMailAccount = {
          address: 'ada@example.org',
          imap: { host: 'imap.example.org', port: 993, user: 'ada@example.org' },
          smtp: { host: 'smtp.example.org', port: 465, user: 'ada@example.org', security: 'tls' },
          password: 'synthetic-pw',
        };
        const id = (await writeOwnAccount(dir, account)).id;
        const { opener, opened, streams } = server(() => undefined);
        const backend = new ImapBackend(opener, { secretsDir: dir });

        const session = await backend.connect(id);
        expect(opened.length).toBe(1);
        expect(opened[0].host).toBe('imap.example.org');
        expect(streams[0].written[0]).toBe('a1 LOGIN "ada@example.org" "synthetic-pw"\r\n');
        await session.openFolder('INBOX');
        expect(streams[0].written[1]).toBe('a2 EXAMINE "INBOX"\r\n');
        await session.close();
        expect(streams[0].written.some((w) => w.includes('LOGOUT'))).toBe(true);

        await expect(backend.connect('missing')).rejects.toThrow(/no mail account with id missing/);
      } finally {
        rmSync(join(dir, '..'), { recursive: true, force: true });
      }
    });
  });
};
