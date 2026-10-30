import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAIL_MANIFEST, MailSender } from '@curlew/imap';
import type { MessageBackend, SendPermit, SmtpTarget } from '@curlew/protocol';

import { sendMessage } from '../../../src/core/actions/send.ts';
import { startDummyServer } from '../smtp/dummy-server.ts';
import type { DummyServer } from '../smtp/dummy-server.ts';

// Synthetic only: a dummy server on 127.0.0.1 created and closed per case, example.invalid
// addresses, and a secret conspicuous enough to find with `includes`.
const ACCOUNT = 'goa-account-1';
const FROM = 'sender@example.invalid';
const OWNER = 'owner@example.invalid';
const OTHER = 'other@example.invalid';
const PASSWORD = 'SECRET-pa55w0rd-for-tests';

const PERMIT: SendPermit = { account: ACCOUNT, addresses: [OWNER] };

function targetFor(port: number): SmtpTarget {
  return {
    accountId: ACCOUNT,
    from: FROM,
    host: '127.0.0.1',
    port,
    user: FROM,
    security: 'none',
    getPassword: () => PASSWORD,
  };
}

function mailBackend(port: number, onOpen: () => void): MessageBackend {
  return {
    manifest: MAIL_MANIFEST,
    listAccounts: async () => [{ id: ACCOUNT, identity: FROM, provider: 'imap_smtp' }],
    openSender: async (_id: string, permit: SendPermit) => {
      onOpen();
      return new MailSender(targetFor(port), permit);
    },
  } as unknown as MessageBackend;
}

async function withServer<T>(body: (server: DummyServer) => Promise<T>): Promise<T> {
  const server = await startDummyServer();
  try {
    return await body(server);
  } finally {
    await server.close();
  }
}

/** A directory with a config the case writes, removed afterwards. */
async function withConfig<T>(
  config: unknown,
  body: (paths: { dir: string; configPath: string }) => Promise<T>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'curlew-mail-send-'));
  try {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify(config));
    return await body({ dir, configPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const granted = { grants: [{ capability: 'mail.send', target: `${ACCOUNT}/${OWNER}` }] };

export default async () => {
  await describe('the mail sender is behind the permit', async () => {
    await it('refuses an address the permit does not name, before connecting', async () => {
      await withServer(async (server) => {
        const sender = new MailSender(targetFor(server.port), PERMIT);
        let refused = false;
        try {
          await sender.send({ to: OTHER, text: 'Hallo' });
        } catch {
          refused = true;
        }
        expect(refused).toBe(true);
        expect(server.dialogue.commands.length).toBe(0);
        expect(server.dialogue.messages.length).toBe(0);
      });
    });

    await it('sends one plain-text message to the granted address and returns its id', async () => {
      await withServer(async (server) => {
        const sender = new MailSender(targetFor(server.port), PERMIT);
        const sent = await sender.send({ to: OWNER, text: 'Hallo\n', subject: 'Testbetreff' });

        expect(sent.target).toBe(OWNER);
        expect(/^<[0-9a-f]{32}@example\.invalid>$/.test(sent.id)).toBe(true);
        expect(sent.sentAt.length > 0).toBe(true);
        expect(server.dialogue.messages.length).toBe(1);

        const raw = server.dialogue.messages[0];
        expect(raw.includes('To: owner@example.invalid')).toBe(true);
        expect(raw.includes('Subject: Testbetreff')).toBe(true);
        expect(raw.includes('Hallo')).toBe(true);
        // The credential is a parameter of the connection, never part of what a caller sees.
        expect(JSON.stringify(sent).includes(PASSWORD)).toBe(false);
      });
    });

    await it('keeps the password out of an SMTP error', async () => {
      const server = await startDummyServer({ rejectAuthEchoing: PASSWORD });
      try {
        const sender = new MailSender(targetFor(server.port), PERMIT);
        let message = '';
        try {
          await sender.send({ to: OWNER, text: 'Hallo' });
        } catch (err) {
          message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
        }
        expect(message.length > 0).toBe(true);
        expect(message.includes(PASSWORD)).toBe(false);
        expect(server.dialogue.messages.length).toBe(0);
      } finally {
        await server.close();
      }
    });
  });

  await describe('the send action picks the backend from the account and the grant', async () => {
    await it('sends through mail.send and writes the log line without the text', async () => {
      await withServer(async (server) => {
        await withConfig(granted, async ({ dir, configPath }) => {
          let opened = 0;
          const out = await sendMessage({
            accountId: ACCOUNT,
            to: OWNER,
            text: 'Hallo',
            subject: 'Testbetreff',
            frontend: 'cli',
            dbPath: join(dir, 'index.db'),
            configPath,
            writeLogPath: join(dir, 'writes.log'),
            backend: mailBackend(server.port, () => opened++),
          });

          expect(opened).toBe(1);
          expect(out.backend).toBe('mail');
          expect(out.target).toBe(`${ACCOUNT}/${OWNER}`);
          expect(out.conversationId === undefined).toBe(true);
          expect(out.messageId === undefined).toBe(true);
          expect(server.dialogue.messages.length).toBe(1);

          const line = JSON.parse(readFileSync(join(dir, 'writes.log'), 'utf8').trim());
          expect(line.capability).toBe('mail.send');
          expect(line.target).toBe(`${ACCOUNT}/${OWNER}`);
          expect(line.id).toBe(out.originId);
          expect(line.text === undefined).toBe(true);
          expect(JSON.stringify(line).includes(PASSWORD)).toBe(false);
        });
      });
    });

    await it('refuses without a grant, before opening any sender', async () => {
      await withServer(async (server) => {
        for (const config of [
          { grants: [] },
          // A grant for another address of this account is not this address's grant.
          { grants: [{ capability: 'mail.send', target: `${ACCOUNT}/${OTHER}` }] },
        ]) {
          await withConfig(config, async ({ dir, configPath }) => {
            let opened = 0;
            let refused = false;
            try {
              await sendMessage({
                accountId: ACCOUNT,
                to: OWNER,
                text: 'Hallo',
                frontend: 'cli',
                dbPath: join(dir, 'index.db'),
                configPath,
                writeLogPath: join(dir, 'writes.log'),
                backend: mailBackend(server.port, () => opened++),
              });
            } catch {
              refused = true;
            }
            expect(refused).toBe(true);
            expect(opened).toBe(0);
          });
        }
        expect(server.dialogue.commands.length).toBe(0);
      });
    });

    await it('refuses a pair granted only for another backend’s send', async () => {
      await withServer(async (server) => {
        await withConfig(
          // Same account/address string, but the grant names XMPP: the mail backend may not use it.
          { grants: [{ capability: 'xmpp.send', target: `${ACCOUNT}/${OWNER}` }] },
          async ({ dir, configPath }) => {
            let opened = 0;
            let refused = false;
            try {
              await sendMessage({
                accountId: ACCOUNT,
                to: OWNER,
                text: 'Hallo',
                frontend: 'cli',
                dbPath: join(dir, 'index.db'),
                configPath,
                writeLogPath: join(dir, 'writes.log'),
                backend: mailBackend(server.port, () => opened++),
              });
            } catch {
              refused = true;
            }
            expect(refused).toBe(true);
            expect(opened).toBe(0);
          },
        );
        expect(server.dialogue.commands.length).toBe(0);
      });
    });
  });
};
