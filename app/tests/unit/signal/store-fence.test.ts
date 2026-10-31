import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type DecryptResult,
  encodeEnvelope,
  EnvelopeType,
  type EventJournal,
  NS,
  SignalMapper,
  SignalProtocolStore,
  SignalReceiver,
} from '@curlew/signal';
import { SecretStore } from '@curlew/store';

import type { ChatConnector, ChatListenerLike } from '@curlew/signal';

import { ALICE_ACI, FakeServer, groupIdOf, LIB, OWN_ACI } from './world.ts';

/**
 * The fence that keeps a send and the receive loop off one ratchet — `SignalReceiver.exclusive`,
 * which an in-session send runs inside (ADR 0004, amendment 2026-10-30), and the store rewind it
 * ends with.
 *
 * Signal's protocol store is one file with no lock, and both sides write it: the receive loop
 * takes a ratchet step per decrypt, a send takes one per recipient device. Interleaved, each
 * one's `flush()` would carry half of the other's step, and a forked ratchet is not repaired by
 * retrying — the session is dead and the messages in it are unreadable. So the ordering is the
 * thing under test here, not a shape: every case below measures WHEN a piece of work ran
 * relative to the other side's decrypt and commit.
 *
 * Nothing real is reached. The decryptor is scripted (it parks on a gate instead of touching
 * libsignal), the journal and the store's write step only record that they were called, and the
 * one real store in the last case lives in a temporary directory.
 */

/** A promise under the test's control, to park a decrypt or a send in flight. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for something the test is expecting, by milliseconds rather than by turns: under GJS a
 * `setTimeout(0)` comes back inside the same millisecond, so counting turns would race past a
 * scripted delivery one millisecond away and "it did not happen" would mean "not yet".
 */
async function until(done: () => boolean, ms = 500): Promise<void> {
  for (let i = 0; i < ms && !done(); i++) await sleep(1);
}

/** Long enough that work which was going to happen has happened — for asserting it did not. */
const settled = (): Promise<void> => sleep(25);

const journal = (log: string[]): EventJournal => ({
  recovered: [],
  append: () => log.push('journal'),
  size: () => 0,
  release: () => undefined,
  close: () => undefined,
});

/** The store's write step, recorded — the fence exists so these never interleave. */
const flushable = (log: string[]) => ({ setAside: () => 0, flush: () => log.push('flush') });

/**
 * A decrypt that parks on `hold` and then skips. A skip is enough: what the drain does with the
 * plaintext is `signal.test.ts`'s subject, and the ratchet step is taken by the decrypt itself —
 * which is exactly the part this test holds open.
 */
const decryptor = (log: string[], hold: Promise<void> | null) => ({
  decrypt: async (): Promise<DecryptResult> => {
    log.push('decrypt-start');
    if (hold) await hold;
    log.push('decrypt');
    return { kind: 'skip', reason: 'server-receipt' };
  },
});

let guid = 0;

/** A well-formed envelope the scripted decryptor never looks inside. */
const envelope = (): Uint8Array =>
  encodeEnvelope({
    type: EnvelopeType.SERVER_DELIVERY_RECEIPT,
    sourceServiceId: ALICE_ACI,
    sourceDevice: 1,
    destinationServiceId: OWN_ACI,
    clientTimestamp: 9000 + ++guid,
    serverTimestamp: 9000 + guid,
    serverGuid: `guid-fence-${guid}`,
  });

/**
 * The scripted server's connector, with the moment an envelope reached the receiver written down.
 *
 * That line is what makes "it arrived and was NOT decrypted" a measurement: without it, a test
 * asserting the absence of a decrypt could just be looking before the delivery.
 */
const connectorOver = (server: FakeServer, log: string[]): ChatConnector => {
  const connect = server.connector();
  return (listener: ChatListenerLike) =>
    connect({
      ...listener,
      onIncomingMessage: (bytes, timestamp, ack) => {
        log.push('arrived');
        listener.onIncomingMessage(bytes, timestamp, ack);
      },
    });
};

function receiverOver(server: FakeServer, log: string[], hold: Promise<void> | null = null): SignalReceiver {
  return new SignalReceiver(
    connectorOver(server, log),
    decryptor(log, hold),
    new SignalMapper(OWN_ACI, groupIdOf),
    flushable(log),
    { mode: 'follow', journal: journal(log) },
  );
}

async function rejected(promise: Promise<unknown>): Promise<boolean> {
  try {
    await promise;
    return false;
  } catch {
    return true;
  }
}

export default async () => {
  await describe('Signal store fence', async () => {
    await it('holds a send until the envelope being decrypted is committed', async () => {
      const log: string[] = [];
      const held = gate();
      const server = new FakeServer();
      server.push(envelope());
      const receiver = receiverOver(server, log, held.wait);
      await receiver.start();
      await until(() => log.includes('decrypt-start'));

      // The drain is inside a decrypt, so the store is mid-ratchet-step. A send queued now has
      // to wait: encrypting on top of a half-finished step is how the ratchet forks.
      let ran = false;
      const send = receiver.exclusive(async () => {
        log.push('send');
        ran = true;
      });
      await settled();
      expect(ran).toBe(false);

      held.open();
      await send;
      // The decrypt's step reached disk BEFORE the send touched the store — and the envelope was
      // acknowledged, which only happens after that flush.
      expect(log.join()).toBe('arrived,decrypt-start,decrypt,journal,flush,send');
      expect(server.acked.length).toBe(1);
      await receiver.close();
    });

    await it('holds an arriving envelope until the send in flight is done', async () => {
      const log: string[] = [];
      const held = gate();
      const server = new FakeServer();
      server.push(envelope());
      const receiver = receiverOver(server, log);
      // The send takes the fence before the connection exists, so it is ahead of the drain.
      const send = receiver.exclusive(async () => {
        log.push('send-start');
        await held.wait;
        log.push('send');
      });
      await receiver.start();
      await until(() => log.includes('arrived'));
      await settled();

      // The envelope has arrived — and is not being decrypted, because the send holds the store.
      expect(log.includes('decrypt-start')).toBe(false);
      expect(server.acked.length).toBe(0);

      held.open();
      await send;
      await until(() => log.includes('flush'));
      expect(log.join()).toBe('send-start,arrived,send,decrypt-start,decrypt,journal,flush');
      await receiver.close();
    });

    await it('closes behind a send instead of flushing underneath it', async () => {
      const log: string[] = [];
      const held = gate();
      const server = new FakeServer();
      const receiver = receiverOver(server, log);
      await receiver.start();

      const send = receiver.exclusive(async () => {
        await held.wait;
        log.push('send');
      });
      let closed = false;
      const closing = receiver.close().then(() => {
        closed = true;
      });
      await settled();
      // `stop()`'s final commit goes through the same queue: a session that ended while a message
      // was still on its way out would write that message's ratchet step as if it had gone.
      expect(closed).toBe(false);
      expect(log.includes('send')).toBe(false);

      held.open();
      await send;
      await closing;
      expect(closed).toBe(true);
      expect(log.join()).toBe('send');
    });

    await it('keeps the queue usable after a send that threw', async () => {
      const log: string[] = [];
      const server = new FakeServer();
      server.push(envelope());
      const receiver = receiverOver(server, log);
      // A failed send is ordinary — no network, a refusal, a safety number. The envelopes behind
      // it in the queue still have to be received.
      const failed = receiver.exclusive(async () => {
        log.push('send-failed');
        throw new Error('synthetic send failure');
      });
      expect(await rejected(failed)).toBe(true);

      await receiver.start();
      await until(() => log.includes('flush'));
      expect(log.join()).toBe('send-failed,arrived,decrypt-start,decrypt,journal,flush');
      expect(server.acked.length).toBe(1);
      await receiver.close();
    });

    await it('rewinds the store from the file, which discarding does not', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-signal-fence-'));
      try {
        const file = SecretStore.open(join(dir, 'session.db'));
        try {
          const store = SignalProtocolStore.open(LIB, file);
          store.set(NS.session, `${ALICE_ACI}.1`, 'committed');
          store.flush();

          // What a send that never reached the network leaves behind.
          store.set(NS.session, `${ALICE_ACI}.1`, 'unsent');
          expect(store.pending).toBe(1);

          // `discard()` forgets only that it is unwritten: the receiver sharing this store would
          // go on using the unsent value, and the next step on that key would write it after all.
          store.discard();
          expect(store.pending).toBe(0);
          expect(store.get(NS.session, `${ALICE_ACI}.1`)).toBe('unsent');

          // `reload()` is the rewind the in-session send ends with — memory holds what disk holds.
          store.reload();
          expect(store.pending).toBe(0);
          expect(store.get(NS.session, `${ALICE_ACI}.1`)).toBe('committed');
        } finally {
          file.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
