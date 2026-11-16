import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';

import { removeSecretFiles, type SecretFiles, SecretStore } from '@curlew/store';

// The point of SecretFiles: the store asks the platform to protect the file instead of calling
// chmod itself, so a sandbox shell can plug in its own without the store knowing.
export default async () => {
  await describe('SecretStore file protection', async () => {
    await it('creates the file 0600 in a 0700 directory by default', async () => {
      const root = mkdtempSync(join(tmpdir(), 'curlew-secret-'));
      try {
        const path = join(root, 'sub', 'a.db');
        SecretStore.open(path).close();
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(statSync(join(root, 'sub')).mode & 0o777).toBe(0o700);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    await it('routes every file operation through an injected implementation', async () => {
      const root = mkdtempSync(join(tmpdir(), 'curlew-secret-'));
      const calls: string[] = [];
      const files: SecretFiles = {
        exists: (p) => existsSync(p),
        prepareDir: (d) => calls.push(`dir ${d}`),
        create: (p) => {
          calls.push('create');
          writeFileSync(p, '');
        },
        restrict: () => calls.push('restrict'),
        remove: () => calls.push('remove'),
      };
      try {
        const path = join(root, 'b.db');
        const store = SecretStore.open(path, files);
        store.apply([{ namespace: 'n', key: 'k', value: 'v' }]);
        expect(store.get('n', 'k')).toBe('v');
        store.close();
        expect(calls[0]).toBe(`dir ${root}`);
        expect(calls.includes('create')).toBe(true);
        expect(calls.includes('restrict')).toBe(true);
        removeSecretFiles(path, [], files);
        expect(calls.filter((c) => c === 'remove').length).toBe(4);
        expect(existsSync(path)).toBe(true); // the fake did not delete: remove() was the only route
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    await it('refuses to remove an account that is not there', async () => {
      let message = '';
      try {
        removeSecretFiles(join(tmpdir(), 'curlew-nope-', 'x.db'));
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message.startsWith('no such account file')).toBe(true);
    });
  });
};
