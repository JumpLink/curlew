import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SecretStore } from '@curlew/store';
import { accountIdFor, SET_ASIDE_LIMIT, type SetAsideEntry, SignalProtocolStore } from '@curlew/signal';

import { deliveriesSetAside } from '../../../src/core/actions/deliveries.ts';
import { saveConfig } from '../../../src/core/config.ts';
import { ALICE_ACI, LIB } from '../signal/world.ts';

/**
 * The set-aside listing, over a real config file and real session files: a Signal ledger written
 * through the store that keeps it, and a delivery backend that keeps no ledger at all. What has to
 * hold is the privacy rule — a listing is for finding a message on the phone, never for reading it
 * here — and the shape rule: a backend without a ledger is an empty list, not an error.
 *
 * The session files are written under `POSTBOTE_SECRETS_DIR`, the override the data layer already
 * documents, so the action takes the same path the real command does. All data is synthetic.
 */

const SIGNAL_ID = accountIdFor(ALICE_ACI);
const WHATSAPP_ID = 'whatsapp-123456789';
/** Base64 of `geheim` — the stand-in for a plaintext nobody could read. */
const SECRET = 'Z2VoZWlt';

const entry = (n: number): SetAsideEntry => ({
  senderAci: ALICE_ACI,
  sentAt: new Date(1_700_000_000_000 + n).toISOString(),
  reason: `content field(s) ${n} this postbote does not know`,
  plaintext: SECRET,
});

function tempWorld(backends: string[] = ['signal', 'whatsapp']): {
  dir: string;
  configPath: string;
  secrets: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'postbote-setaside-'));
  const configPath = join(dir, 'config.json');
  saveConfig(
    {
      backends: Object.fromEntries(
        backends.map((name) => [name, { enabled: true, termsAcceptedAt: '2026-09-01T00:00:00.000Z' }]),
      ),
      senders: {},
    },
    configPath,
  );
  return { dir, configPath, secrets: join(dir, 'secrets') };
}

/** Write a Signal account file holding `count` entries of the ledger, and return them. */
function signalSession(secrets: string, count: number): void {
  const file = SecretStore.open(join(secrets, 'signal', `${SIGNAL_ID}.db`));
  try {
    const store = SignalProtocolStore.open(LIB, file);
    for (let n = 0; n < count; n++) store.setAside(entry(n));
    store.flush();
  } finally {
    file.close();
  }
}

/** A WhatsApp account file. It holds Baileys' auth state and no ledger of unreadable plaintexts. */
function whatsappSession(secrets: string): void {
  SecretStore.open(join(secrets, 'whatsapp', `${WHATSAPP_ID}.db`)).close();
}

/** Run `body` with the secrets directory pointed at the test's own. */
async function withSecrets<T>(secrets: string, body: () => Promise<T>): Promise<T> {
  const before = process.env.POSTBOTE_SECRETS_DIR;
  process.env.POSTBOTE_SECRETS_DIR = secrets;
  try {
    return await body();
  } finally {
    if (before === undefined) delete process.env.POSTBOTE_SECRETS_DIR;
    else process.env.POSTBOTE_SECRETS_DIR = before;
  }
}

export default async () => {
  await describe('set-aside listing', async () => {
    await it('lists a backend’s ledger per account, and no plaintext at all', async () => {
      const { dir, configPath, secrets } = tempWorld();
      try {
        signalSession(secrets, 2);
        whatsappSession(secrets);
        const result = await withSecrets(secrets, () => deliveriesSetAside({ configPath }));
        expect(result.count).toBe(2);
        expect(result.dropped).toBe(0);
        const signal = result.accounts.find((a) => a.backend === 'signal');
        expect(signal?.accountId).toBe(SIGNAL_ID);
        expect(signal?.count).toBe(2);
        expect(signal?.dropped).toBe(0);
        expect(signal?.entries[0].sender).toBe(ALICE_ACI);
        expect(signal?.entries[0].sentAt).toBe(new Date(1_700_000_000_000).toISOString());
        expect(signal?.entries[0].reason).toBe('content field(s) 0 this postbote does not know');
        // The size of the plaintext, so the user knows which message they are looking for — the
        // content stays in the session file, where the phone's copy is the readable one.
        expect(signal?.entries[0].bytes).toBe(6);
        expect(JSON.stringify(result).includes(SECRET)).toBe(false);
        // A delivery backend that keeps no ledger lists an empty account, not an error.
        const whatsapp = result.accounts.find((a) => a.backend === 'whatsapp');
        expect(whatsapp?.accountId).toBe(WHATSAPP_ID);
        expect(whatsapp?.entries).toEqualArray([]);
        expect(whatsapp?.dropped).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('reports what the ledger’s own limit pushed out, which is really gone', async () => {
      const { dir, configPath, secrets } = tempWorld(['signal']);
      try {
        signalSession(secrets, SET_ASIDE_LIMIT + 3);
        const result = await withSecrets(secrets, () => deliveriesSetAside({ configPath }));
        expect(result.count).toBe(SET_ASIDE_LIMIT);
        expect(result.dropped).toBe(3);
        // The three oldest are the ones that fell out — the count is the diagnosis, not a guess.
        expect(result.accounts[0].entries[0].sentAt).toBe(new Date(1_700_000_000_000 + 3).toISOString());
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('--account picks one account, and no delivery backend lists nothing', async () => {
      const { dir, configPath, secrets } = tempWorld();
      try {
        signalSession(secrets, 2);
        whatsappSession(secrets);
        const one = await withSecrets(secrets, () =>
          deliveriesSetAside({ configPath, accountId: WHATSAPP_ID }),
        );
        expect(one.accounts.map((a) => a.backend)).toEqualArray(['whatsapp']);
        expect(one.count).toBe(0);
        // An id no enabled account answers to is the same empty answer, not a failure.
        const none = await withSecrets(secrets, () =>
          deliveriesSetAside({ configPath, accountId: 'signal-00000000-0000-4000-8000-000000000000' }),
        );
        expect(none.accounts).toEqualArray([]);
        // Mail is enabled by default and keeps no ledger either: the listing is about deliveries.
        const mail = tempWorld(['mail']);
        try {
          expect(
            (await withSecrets(mail.secrets, () => deliveriesSetAside({ configPath: mail.configPath })))
              .count,
          ).toBe(0);
        } finally {
          rmSync(mail.dir, { recursive: true, force: true });
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
