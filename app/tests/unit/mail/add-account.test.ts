import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { addMailAccount, parseHostPort, smtpSecurityFor } from '../../../../packages/imap/src/add-account.ts';
import {
  ownAccountIdFor,
  readOwnAccounts,
  type OwnMailAccount,
} from '../../../../packages/imap/src/own-accounts.ts';
import { fakePrompter } from '../core/setup-fakes.ts';

// Synthetic only: example.org and a secret conspicuous enough to search a message for.
const PASSWORD = 'SECRET-pa55w0rd-for-tests';

const PUBLISHED = `<clientConfig version="1.1"><emailProvider id="example.org">
  <incomingServer type="imap"><hostname>imap.example.org</hostname><port>993</port>
    <socketType>SSL</socketType><username>%EMAILADDRESS%</username>
    <authentication>password-cleartext</authentication></incomingServer>
  <outgoingServer type="smtp"><hostname>smtp.example.org</hostname><port>587</port>
    <socketType>STARTTLS</socketType><username>%EMAILLOCALPART%</username>
    <authentication>password-cleartext</authentication></outgoingServer>
</emailProvider></clientConfig>`;

function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'curlew-add-'));
  return run(join(root, 'mail')).finally(() => rmSync(root, { recursive: true, force: true }));
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return (err as Error).message;
  }
  return '';
}

export default async () => {
  await describe('adding a mail account', async () => {
    await it('discovers the servers, proves the login and saves the account', () =>
      withDir(async (dir) => {
        const prompter = fakePrompter([' Ada@Example.org ', PASSWORD]);
        const logins: OwnMailAccount[] = [];
        const account = await addMailAccount(dir, prompter, {
          fetchText: async () => PUBLISHED,
          testLogin: async (a) => {
            logins.push(a);
          },
        });
        expect(account.id).toBe(ownAccountIdFor('ada@example.org'));
        expect(account.identity).toBe('ada@example.org');
        expect(logins.length).toBe(1);
        expect(logins[0].imap.user).toBe('ada@example.org');
        expect(logins[0].smtp.user).toBe('ada');
        const saved = readOwnAccounts(dir).get(account.id);
        expect(saved?.password).toBe(PASSWORD);
        expect(saved?.smtp.security).toBe('starttls');
        // The fake records each answer next to its question; only what the flow itself said counts.
        const said = prompter.notified.filter((m) => !prompter.asked.some((q) => m.startsWith(q)));
        expect(said.length > 0).toBe(true);
        expect(said.join('\n').includes(PASSWORD)).toBe(false);
      }));

    await it('asks for the servers when nothing is published, and picks the security by port', () =>
      withDir(async (dir) => {
        const prompter = fakePrompter([
          'ada@example.org',
          PASSWORD,
          'imap.example.net',
          'smtp.example.net:465',
        ]);
        const account = await addMailAccount(dir, prompter, {
          fetchText: async () => null,
          testLogin: async () => {},
        });
        const saved = readOwnAccounts(dir).get(account.id);
        expect(saved?.imap.host).toBe('imap.example.net');
        expect(saved?.imap.port).toBe(993);
        expect(saved?.smtp.port).toBe(465);
        expect(saved?.smtp.security).toBe('tls');
      }));

    await it('asks again for a server name that cannot be one', () =>
      withDir(async (dir) => {
        const prompter = fakePrompter([
          'ada@example.org',
          PASSWORD,
          'not a host',
          'imap.example.net',
          'smtp.example.net',
        ]);
        await addMailAccount(dir, prompter, { fetchText: async () => null, testLogin: async () => {} });
        expect(prompter.notified.some((m) => m.includes('not a server name'))).toBe(true);
      }));

    await it('says why a browser sign-in provider cannot be set up automatically', () =>
      withDir(async (dir) => {
        const oauth = PUBLISHED.replace(/password-cleartext/g, 'OAuth2');
        const prompter = fakePrompter(['ada@example.org', PASSWORD, 'imap.example.net', 'smtp.example.net']);
        await addMailAccount(dir, prompter, { fetchText: async () => oauth, testLogin: async () => {} });
        expect(prompter.notified.some((m) => m.includes('browser sign-in'))).toBe(true);
      }));

    await it('saves nothing when the login is refused, and the error holds no secret', () =>
      withDir(async (dir) => {
        const prompter = fakePrompter(['ada@example.org', PASSWORD]);
        const message = await failure(
          addMailAccount(dir, prompter, {
            fetchText: async () => PUBLISHED,
            testLogin: async () => {
              throw new Error(`LOGIN "ada@example.org" "${PASSWORD}" refused`);
            },
          }),
        );
        expect(message).toContain('could not log in to imap.example.org');
        expect(message.includes(PASSWORD)).toBe(false);
        expect(readOwnAccounts(dir).size).toBe(0);
      }));

    await it('refuses a bad address or an empty password before touching the network', () =>
      withDir(async (dir) => {
        let touched = 0;
        const deps = {
          fetchText: async () => {
            touched++;
            return null;
          },
          testLogin: async () => {
            touched++;
          },
        };
        expect(
          (await failure(addMailAccount(dir, fakePrompter(['nonsense', PASSWORD]), deps))).length > 0,
        ).toBe(true);
        expect(
          (await failure(addMailAccount(dir, fakePrompter(['ada@example.org', '']), deps))).length > 0,
        ).toBe(true);
        expect(touched).toBe(0);
      }));

    await it('parses host and host:port and nothing else', () => {
      expect(parseHostPort('imap.example.org', 993)?.port).toBe(993);
      expect(parseHostPort(' imap.example.org:143 ', 993)?.port).toBe(143);
      expect(parseHostPort('imap.example.org:0', 993)).toBe(null);
      expect(parseHostPort('imap.example.org:70000', 993)).toBe(null);
      expect(parseHostPort('a b', 993)).toBe(null);
      expect(parseHostPort('https://x.example.org', 993)).toBe(null);
      expect(parseHostPort('', 993)).toBe(null);
      expect(smtpSecurityFor(465)).toBe('tls');
      expect(smtpSecurityFor(587)).toBe('starttls');
    });
  });
};
