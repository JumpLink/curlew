import { describe, expect, it } from '@gjsify/unit';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SecretStore } from '@curlew/store';
import type { Account, MailSettings, SystemAccounts } from '@gjsify/system-accounts';

import {
  listOwnAccounts,
  ownAccountIdFor,
  ownAccountPath,
  readOwnAccounts,
  removeOwnAccount,
  writeOwnAccount,
  type OwnMailAccount,
} from '../../../../packages/imap/src/own-accounts.ts';
import { resolveMailTargets, resolveSmtpTargets } from '../../../../packages/imap/src/targets.ts';

// Synthetic only: example.org addresses and a secret conspicuous enough to search a file for.
const PASSWORD = 'SECRET-pa55w0rd-for-tests';

const ACCOUNT: OwnMailAccount = {
  address: 'Ada@Example.org',
  imap: { host: 'imap.example.org', port: 993, user: 'ada@example.org' },
  smtp: { host: 'smtp.example.org', port: 465, user: 'ada@example.org', security: 'tls' },
  password: PASSWORD,
};

function withDir(run: (dir: string) => Promise<void> | void): Promise<void> | void {
  const dir = join(mkdtempSync(join(tmpdir(), 'curlew-mail-')), 'mail');
  const done = () => rmSync(join(dir, '..'), { recursive: true, force: true });
  try {
    const result = run(dir);
    return result instanceof Promise ? result.finally(done) : done();
  } catch (err) {
    done();
    throw err;
  }
}

function systemStore(addresses: string[]): () => Promise<SystemAccounts> {
  const accounts: Account[] = addresses.map((address, i) => ({
    id: `goa-${i}`,
    provider: 'imap_smtp',
    providerName: 'IMAP and SMTP',
    identity: address,
    label: address,
    services: ['mail'],
  }));
  const settings = (a: Account): MailSettings => ({
    sender: { address: a.identity },
    imap: { host: 'imap.example.net', port: 993, security: 'tls', username: a.identity },
    smtp: { host: 'smtp.example.net', port: 587, security: 'starttls', username: a.identity },
  });
  const store: SystemAccounts = {
    capabilities: () => ({ services: ['mail'], credentials: ['password'] }),
    listAccounts: async () => accounts,
    getMailSettings: async (a) => settings(a),
    getCredentials: async () => ({ kind: 'password', secret: 'system-secret' }),
  };
  return async () => store;
}

const noStore = async (): Promise<SystemAccounts> => ({
  capabilities: () => ({ services: [], credentials: [] }),
  listAccounts: async () => [],
  getMailSettings: async () => ({ kind: 'unavailable', reason: 'no-account-store' }),
  getCredentials: async () => ({ kind: 'unavailable', reason: 'no-account-store' }),
});

export default async () => {
  await describe('own mail accounts', async () => {
    await it('stores one account in one private file and lists it without the password', () =>
      withDir((dir) => {
        const entry = writeOwnAccount(dir, ACCOUNT);
        expect(entry.id).toBe(ownAccountIdFor('ada@example.org'));
        expect(entry.identity).toBe('ada@example.org');
        expect(JSON.stringify(listOwnAccounts(dir)).includes(PASSWORD)).toBe(false);
        const path = ownAccountPath(dir, entry.id);
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(statSync(dir).mode & 0o777).toBe(0o700);
      }));

    await it('keeps the same id for the same address however it was typed, and replaces on rewrite', () =>
      withDir((dir) => {
        writeOwnAccount(dir, ACCOUNT);
        writeOwnAccount(dir, { ...ACCOUNT, address: ' ada@example.org ', password: 'changed' });
        const all = readOwnAccounts(dir);
        expect(all.size).toBe(1);
        expect([...all.values()][0].password).toBe('changed');
      }));

    await it('reads back what it wrote', () =>
      withDir((dir) => {
        const { id } = writeOwnAccount(dir, ACCOUNT);
        const read = readOwnAccounts(dir).get(id);
        expect(read?.address).toBe('ada@example.org');
        expect(read?.imap.port).toBe(993);
        expect(read?.smtp.security).toBe('tls');
      }));

    await it('refuses an address, a port, a server or a password that cannot work', () =>
      withDir((dir) => {
        const bad = (change: Partial<OwnMailAccount>) => () =>
          writeOwnAccount(dir, { ...ACCOUNT, ...change });
        expect(bad({ address: 'not-an-address' })).toThrow();
        expect(bad({ password: '' })).toThrow();
        expect(bad({ imap: { ...ACCOUNT.imap, port: 0 } })).toThrow();
        expect(bad({ smtp: { ...ACCOUNT.smtp, port: 70000 } })).toThrow();
        expect(bad({ imap: { ...ACCOUNT.imap, host: ' ' } })).toThrow();
        expect(existsSync(dir) ? readOwnAccounts(dir).size : 0).toBe(0);
      }));

    await it('refuses an account id that is not one of ours', () =>
      withDir((dir) => {
        expect(() => ownAccountPath(dir, '../etc/passwd')).toThrow();
        expect(() => removeOwnAccount(dir, 'goa-1')).toThrow();
      }));

    await it('removes the account together with its file', () =>
      withDir((dir) => {
        const { id } = writeOwnAccount(dir, ACCOUNT);
        removeOwnAccount(dir, id);
        expect(readOwnAccounts(dir).size).toBe(0);
        expect(existsSync(ownAccountPath(dir, id))).toBe(false);
      }));

    await it('skips a file that is not an account and an account that is incomplete', () =>
      withDir((dir) => {
        const { id } = writeOwnAccount(dir, ACCOUNT);
        writeFileSync(join(dir, 'notes.txt'), 'not an account');
        const half = SecretStore.open(ownAccountPath(dir, 'mail-incomplete'));
        half.apply([{ namespace: 'mail.account', key: 'address', value: 'half@example.org' }]);
        half.close();
        expect([...readOwnAccounts(dir).keys()].join(',')).toBe(id);
      }));

    await it('never writes the password anywhere but its own file', () =>
      withDir((dir) => {
        const { id } = writeOwnAccount(dir, ACCOUNT);
        expect(readFileSync(ownAccountPath(dir, id)).includes(PASSWORD)).toBe(true);
        expect(JSON.stringify(listOwnAccounts(dir)).includes(PASSWORD)).toBe(false);
      }));
  });

  await describe('mail targets from both sources', async () => {
    await it('serves own accounts with the password read from the file at connect time', () =>
      withDir(async (dir) => {
        const { id } = writeOwnAccount(dir, ACCOUNT);
        const [imap] = await resolveMailTargets(undefined, dir, noStore);
        const [smtp] = await resolveSmtpTargets(undefined, dir, noStore);
        expect(imap.accountId).toBe(id);
        expect(imap.implicitTls).toBe(true);
        expect(smtp.from).toBe('ada@example.org');
        expect(smtp.security).toBe('tls');
        expect(await imap.getPassword()).toBe(PASSWORD);
        writeOwnAccount(dir, { ...ACCOUNT, password: 'rotated' });
        expect(await smtp.getPassword()).toBe('rotated');
      }));

    await it('lists own accounts first and the system ones after, once per address', () =>
      withDir(async (dir) => {
        writeOwnAccount(dir, ACCOUNT);
        const store = systemStore(['ada@example.org', 'bob@example.org']);
        const imap = await resolveMailTargets(undefined, dir, store);
        expect(imap.map((t) => t.host).join(',')).toBe('imap.example.org,imap.example.net');
        expect(imap.map((t) => t.user).join(',')).toBe('ada@example.org,bob@example.org');
        const smtp = await resolveSmtpTargets(undefined, dir, store);
        expect(smtp.map((t) => t.from).join(',')).toBe('ada@example.org,bob@example.org');
      }));

    await it('finds one account by id in either source', () =>
      withDir(async (dir) => {
        const { id } = writeOwnAccount(dir, ACCOUNT);
        const store = systemStore(['bob@example.org']);
        expect((await resolveMailTargets(id, dir, store)).map((t) => t.accountId).join(',')).toBe(id);
        expect((await resolveMailTargets('goa-0', dir, store)).map((t) => t.accountId).join(',')).toBe(
          'goa-0',
        );
        expect((await resolveSmtpTargets('goa-0', dir, store)).length).toBe(1);
        expect((await resolveMailTargets('missing', dir, store)).length).toBe(0);
      }));

    await it('carries on with own accounts when the system store breaks', () =>
      withDir(async (dir) => {
        writeOwnAccount(dir, ACCOUNT);
        const broken = async (): Promise<SystemAccounts> => {
          throw new Error('no session bus');
        };
        expect((await resolveMailTargets(undefined, dir, broken)).length).toBe(1);
        expect((await resolveSmtpTargets(undefined, dir, broken)).length).toBe(1);
      }));

    await it('reports a broken system store when it is all there is, and nothing when it is merely empty', () =>
      withDir(async (dir) => {
        const broken = async (): Promise<SystemAccounts> => {
          throw new Error('no session bus');
        };
        let message = '';
        try {
          await resolveMailTargets(undefined, dir, broken);
        } catch (err) {
          message = (err as Error).message;
        }
        expect(message).toBe('no session bus');
        expect((await resolveMailTargets(undefined, dir, noStore)).length).toBe(0);
      }));
  });
};
