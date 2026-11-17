import { describe, expect, it } from '@gjsify/unit';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SecretStore } from '@curlew/store';
import {
  accountIdFor,
  connectMatrixClient,
  IDB_SCHEMA_NAMESPACE,
  claimAccount,
  isKeyUploadConflict,
  MatrixKeysOutOfSyncError,
} from '@curlew/matrix';

const ME = '@me:example.org';
const UPLOAD = 'https://matrix.example.org/_matrix/client/v3/keys/upload';
const CONFLICT =
  '{"errcode":"M_UNKNOWN","error":"One time key signed_curve25519:AAAAAAAAAA0 already exists. Old key: {} new key: {}"}';

export default async () => {
  await describe('Matrix account guard', async () => {
    await it('refuses a second live client for the same account until the first is released', async () => {
      const release = claimAccount('matrix-guard-a');
      let message = '';
      try {
        claimAccount('matrix-guard-a');
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message.length > 0).toBe(true);
      // Another account is independent.
      claimAccount('matrix-guard-b')();
      release();
      release();
      claimAccount('matrix-guard-a')();
    });
  });

  await describe('Matrix key upload conflict', async () => {
    await it('recognises the one-time-key refusal and nothing else', async () => {
      expect(isKeyUploadConflict(UPLOAD, 400, CONFLICT)).toBe(true);
      expect(isKeyUploadConflict(UPLOAD, 500, CONFLICT)).toBe(false);
      expect(isKeyUploadConflict(UPLOAD, 400, '{"errcode":"M_LIMIT_EXCEEDED"}')).toBe(false);
      expect(isKeyUploadConflict('https://matrix.example.org/_matrix/client/v3/sync', 400, CONFLICT)).toBe(
        false,
      );
    });

    await it('maps to an error that ends the account without naming a command', async () => {
      const err = new MatrixKeysOutOfSyncError();
      expect(err.loggedOut).toBe(true);
      expect(err.message.includes('out of sync')).toBe(true);
      expect(err.message.includes('curlew')).toBe(false);
    });
  });

  await describe('Matrix crypto store save', async () => {
    await it('is on disk before the first /sync is asked for', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-matrix-keysave-'));
      const store = SecretStore.open(join(dir, 'keysave.db'));
      let savedBeforeSync = false;
      const json = (status: number, body: unknown): Response =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      const fetch = (async (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/sync')) {
          savedBeforeSync = (store.loadAll().get(IDB_SCHEMA_NAMESPACE)?.size ?? 0) > 0;
          return json(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'gone' });
        }
        if (url.endsWith('/filter')) return json(200, { filter_id: 'f1' });
        if (url.includes('/pushrules')) return json(200, { global: {} });
        if (url.includes('/capabilities')) return json(200, { capabilities: {} });
        if (url.endsWith('/versions')) return json(200, { versions: ['v1.11'] });
        if (url.includes('/keys/upload'))
          return json(200, { one_time_key_counts: { signed_curve25519: 50 } });
        return json(404, { errcode: 'M_NOT_FOUND', error: 'not found' });
      }) as typeof globalThis.fetch;
      try {
        let failed = false;
        try {
          await connectMatrixClient({
            homeserver: 'https://matrix.example.org',
            userId: ME,
            deviceId: 'DEVICE',
            accessToken: 'synthetic-token',
            store,
            accountId: accountIdFor(ME),
            fetch,
          });
        } catch {
          failed = true;
        }
        expect(failed).toBe(true);
        expect(savedBeforeSync).toBe(true);
        // A failed connect released the account.
        claimAccount(accountIdFor(ME))();
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('leaves no unhandled rejection behind when the token is refused', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-matrix-unhandled-'));
      const store = SecretStore.open(join(dir, 'unhandled.db'));
      const json = (status: number, body: unknown): Response =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      const fetch = (async (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/sync')) return json(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'gone' });
        if (url.endsWith('/filter')) return json(200, { filter_id: 'f1' });
        if (url.includes('/pushrules')) return json(200, { global: {} });
        if (url.includes('/capabilities')) return json(200, { capabilities: {} });
        if (url.endsWith('/versions')) return json(200, { versions: ['v1.11'] });
        if (url.includes('/keys/upload'))
          return json(200, { one_time_key_counts: { signed_curve25519: 50 } });
        return json(404, { errcode: 'M_NOT_FOUND', error: 'not found' });
      }) as typeof globalThis.fetch;
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        let failed = false;
        try {
          await connectMatrixClient({
            homeserver: 'https://matrix.example.org',
            userId: ME,
            deviceId: 'DEVICE',
            accessToken: 'synthetic-token',
            store,
            accountId: accountIdFor(ME),
            fetch,
          });
        } catch {
          failed = true;
        }
        expect(failed).toBe(true);
        await new Promise((r) => setTimeout(r, 200));
        expect(unhandled.length).toBe(0);
        claimAccount(accountIdFor(ME))();
      } finally {
        process.off('unhandledRejection', onUnhandled);
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
