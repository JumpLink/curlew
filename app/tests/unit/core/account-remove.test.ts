import { describe, expect, it } from '@gjsify/unit';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAccountRemoverBackend, type BackendContext, type MessageBackend } from '@curlew/protocol';
import { MatrixBackend } from '@curlew/matrix';
import { SignalBackend } from '@curlew/signal';
import { removeSecretFiles, SecretStore } from '@curlew/store';
import { TelegramBackend } from '@curlew/telegram';
import { WhatsAppBackend } from '@curlew/whatsapp';
import { XmppBackend } from '@curlew/xmpp';

import { removeAccountCopy } from '../../../src/window/account-remove-model.ts';

function withDir(body: (dir: string) => Promise<void> | void): Promise<void> | void {
  const dir = mkdtempSync(join(tmpdir(), 'curlew-remove-'));
  const done = () => rmSync(dir, { recursive: true, force: true });
  try {
    const result = body(dir);
    if (result) return result.finally(done);
  } catch (err) {
    done();
    throw err;
  }
  done();
}

function context(dir: string): BackendContext {
  return { settings: {}, env: {}, secretsDir: dir };
}

/** A session file as the backend would have written it: the one table, one row. */
function seed(path: string): void {
  const store = SecretStore.open(path);
  store.apply([{ namespace: 'account', key: 'identity', value: 'Test Person' }]);
  store.close();
}

const CASES: Array<{ name: string; id: string; make: (c: BackendContext) => MessageBackend }> = [
  { name: 'signal', id: 'signal-11111111-2222-3333-4444-555555555555', make: (c) => new SignalBackend(c) },
  { name: 'whatsapp', id: 'whatsapp-4915100000009', make: (c) => new WhatsAppBackend(c) },
  { name: 'telegram', id: 'telegram-123456', make: (c) => new TelegramBackend(c) },
  { name: 'matrix', id: 'matrix-0123456789abcd', make: (c) => new MatrixBackend(c) },
  { name: 'xmpp', id: 'xmpp-testperson', make: (c) => new XmppBackend(c) },
];

export default async () => {
  await describe('removing an account', async () => {
    await it('deletes the file and its SQLite companions, and leaves other accounts alone', async () => {
      withDir((dir) => {
        const target = join(dir, 'a.db');
        const other = join(dir, 'b.db');
        seed(target);
        seed(other);
        writeFileSync(`${target}-journal`, '');
        writeFileSync(join(dir, 'a.journal'), '');
        removeSecretFiles(target, [join(dir, 'a.journal')]);
        expect(readdirSync(dir).join(',')).toBe('b.db');
        expect(existsSync(other)).toBe(true);
      });
    });

    await it('refuses an account whose file is not there', async () => {
      withDir((dir) => {
        expect(() => removeSecretFiles(join(dir, 'missing.db'))).toThrow(/no such account file/);
      });
    });

    for (const { name, id, make } of CASES) {
      await it(`unlinks a ${name} account and lists it no more`, async () => {
        await withDir(async (dir) => {
          const backend = make(context(dir));
          expect(isAccountRemoverBackend(backend)).toBe(true);
          seed(join(dir, `${id}.db`));
          expect((await backend.listAccounts()).map((a) => a.id).join(',')).toBe(id);
          await backend.removeAccount!(id);
          expect(readdirSync(dir).length).toBe(0);
          expect((await backend.listAccounts()).length).toBe(0);
        });
      });

      await it(`refuses to unlink a ${name} account that is not there`, async () => {
        await withDir(async (dir) => {
          const backend = make(context(dir));
          let message = '';
          await backend.removeAccount!(id).catch((err: Error) => {
            message = err.message;
          });
          expect(message).toMatch(/no such account file/);
        });
      });

      await it(`refuses a ${name} account id that is a path`, async () => {
        await withDir(async (dir) => {
          const backend = make(context(dir));
          let failed = false;
          await backend.removeAccount!('../escape').catch(() => {
            failed = true;
          });
          expect(failed).toBe(true);
        });
      });
    }

    await it('tells the person what stays and what does not', async () => {
      const copy = removeAccountCopy('signal', 'Test Person');
      expect(copy.heading).toBe('Remove Test Person?');
      expect(copy.body).toMatch(/Messages already on this computer stay/);
      expect(copy.body).toMatch(/Signal/);
    });
  });
};
