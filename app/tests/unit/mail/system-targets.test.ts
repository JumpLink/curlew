import { describe, expect, it } from '@gjsify/unit';

import type {
  Account,
  Credentials,
  MailSettings,
  SystemAccounts,
  Unavailable,
} from '@gjsify/system-accounts';

import { systemMailTargets, systemSmtpTargets } from '../../../../packages/imap/src/system-targets.ts';

// Synthetic only: example.org addresses, a conspicuous secret, no account store behind it.
const SECRET = 'SECRET-pa55w0rd-for-tests';

function account(id: string, services: Account['services'] = ['mail']): Account {
  return {
    id,
    provider: 'imap_smtp',
    providerName: 'IMAP and SMTP',
    identity: `${id}@example.org`,
    label: id,
    services,
  };
}

interface Fake {
  accounts: SystemAccounts;
  asked: string[];
}

function fake(
  list: Account[],
  settings: Record<string, MailSettings | Unavailable>,
  credentials: Credentials = { kind: 'password', secret: SECRET },
): Fake {
  const asked: string[] = [];
  return {
    asked,
    accounts: {
      capabilities: () => ({ services: ['mail'], credentials: ['password'] }),
      listAccounts: async (service) => list.filter((a) => !service || a.services.includes(service)),
      getMailSettings: async (a) => settings[a.id] ?? { kind: 'unavailable', reason: 'not-supported' },
      getCredentials: async (a, purpose) => {
        asked.push(`${a.id}:${purpose}`);
        return credentials;
      },
    },
  };
}

const FULL: MailSettings = {
  sender: { address: 'ada@example.org' },
  imap: { host: 'imap.example.org', port: 993, security: 'tls', username: 'ada@example.org' },
  smtp: { host: 'smtp.example.org', port: 587, security: 'starttls', username: 'ada@example.org' },
};

async function rejection(promise: Promise<unknown>): Promise<Error | null> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  return null;
}

export default async () => {
  await describe('system mail targets', async () => {
    await it('turns an account into an IMAP and an SMTP target without reading a password', async () => {
      const { accounts, asked } = fake([account('a1')], { a1: FULL });
      const [imap] = await systemMailTargets(accounts);
      const [smtp] = await systemSmtpTargets(accounts);
      expect(imap.accountId).toBe('a1');
      expect(imap.host).toBe('imap.example.org');
      expect(imap.port).toBe(993);
      expect(imap.user).toBe('ada@example.org');
      expect(imap.implicitTls).toBe(true);
      expect(smtp.from).toBe('ada@example.org');
      expect(smtp.security).toBe('starttls');
      expect(asked.length).toBe(0);
    });

    await it('hands the password out per call, for the login it was asked for', async () => {
      const { accounts, asked } = fake([account('a1')], { a1: FULL });
      const [imap] = await systemMailTargets(accounts);
      const [smtp] = await systemSmtpTargets(accounts);
      expect(await imap.getPassword()).toBe(SECRET);
      expect(await smtp.getPassword()).toBe(SECRET);
      expect(asked.join(',')).toBe('a1:imap,a1:smtp');
    });

    await it('narrows to one account and skips accounts that are not mail', async () => {
      const { accounts } = fake([account('a1'), account('a2'), account('cal', ['calendar'])], {
        a1: FULL,
        a2: FULL,
      });
      expect((await systemMailTargets(accounts)).map((t) => t.accountId).join(',')).toBe('a1,a2');
      expect((await systemMailTargets(accounts, 'a2')).map((t) => t.accountId).join(',')).toBe('a2');
      expect((await systemMailTargets(accounts, 'nope')).length).toBe(0);
    });

    await it('offers STARTTLS on 143 as no TLS-from-the-first-byte target', async () => {
      const settings: MailSettings = {
        ...FULL,
        imap: { host: 'imap.example.org', port: 143, security: 'starttls', username: 'ada' },
      };
      const [target] = await systemMailTargets(fake([account('a1')], { a1: settings }).accounts);
      expect(target.port).toBe(143);
      expect(target.implicitTls).toBe(false);
    });

    await it('never lets an SMTP target fall back to plain text', async () => {
      const settings: MailSettings = {
        ...FULL,
        smtp: { host: 'smtp.example.org', port: 25, security: 'none', username: 'ada@example.org' },
      };
      const [target] = await systemSmtpTargets(fake([account('a1')], { a1: settings }).accounts);
      expect(target.security).toBe('starttls');
    });

    await it('leaves out accounts without the server, the login or the sender', async () => {
      const noSmtp: MailSettings = { sender: FULL.sender, imap: FULL.imap };
      const noLogin: MailSettings = {
        sender: { address: 'ada@example.org' },
        smtp: { host: 'smtp.example.org', port: 587, security: 'starttls' },
      };
      const noSender: MailSettings = {
        sender: { address: '' },
        smtp: { host: 'smtp.example.org', port: 587, security: 'starttls', username: 'ada' },
      };
      const { accounts } = fake([account('a'), account('b'), account('c'), account('d')], {
        a: noSmtp,
        b: noLogin,
        c: noSender,
      });
      expect((await systemSmtpTargets(accounts)).length).toBe(0);
      expect((await systemMailTargets(accounts)).map((t) => t.accountId).join(',')).toBe('a');
    });

    await it('uses the login name as sender when the store has no address', async () => {
      const settings: MailSettings = {
        sender: { address: '' },
        smtp: { host: 'smtp.example.org', port: 465, security: 'tls', username: 'ada@example.org' },
      };
      const [target] = await systemSmtpTargets(fake([account('a1')], { a1: settings }).accounts);
      expect(target.from).toBe('ada@example.org');
      expect(target.security).toBe('tls');
    });

    await it('reports an unavailable or OAuth2 login as an error that holds no secret', async () => {
      const oauth = fake([account('a1')], { a1: FULL }, { kind: 'oauth2', token: 'TOKEN-123', expiresAt: 0 });
      const [viaOAuth] = await systemMailTargets(oauth.accounts);
      const oauthError = await rejection(Promise.resolve(viaOAuth.getPassword()));
      expect((oauthError?.message ?? '').includes('OAuth2')).toBe(true);
      expect((oauthError?.message ?? '').includes('TOKEN-123')).toBe(false);

      const locked = fake(
        [account('a1')],
        { a1: FULL },
        { kind: 'unavailable', reason: 'credentials-unavailable' },
      );
      const [viaLocked] = await systemSmtpTargets(locked.accounts);
      const lockedError = await rejection(Promise.resolve(viaLocked.getPassword()));
      expect((lockedError?.message ?? '').includes('credentials-unavailable')).toBe(true);
    });

    await it('is empty on a host without an account store', async () => {
      const empty: SystemAccounts = {
        capabilities: () => ({ services: [], credentials: [] }),
        listAccounts: async () => [],
        getMailSettings: async () => ({ kind: 'unavailable', reason: 'no-account-store' }),
        getCredentials: async () => ({ kind: 'unavailable', reason: 'no-account-store' }),
      };
      expect((await systemMailTargets(empty)).length).toBe(0);
      expect((await systemSmtpTargets(empty)).length).toBe(0);
    });
  });
};
