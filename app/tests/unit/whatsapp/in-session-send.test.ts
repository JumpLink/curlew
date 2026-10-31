import { describe, expect, it } from '@gjsify/unit';
import { rmSync } from 'node:fs';

import type { SendPermit } from '@curlew/protocol';
import { guardedSendSocket, SendViolation, WhatsAppBackend } from '@curlew/whatsapp';

import { tick } from '../clock.ts';
import {
  ANNA_LID,
  BEN_LID,
  type FakeConnection,
  fakeConnectionFactory,
  fakeFactory,
  text,
  waMessage,
} from './fake-socket.ts';
import { ACCOUNT, context, link, tempDir } from './world.ts';

/**
 * Sending on the connection the daemon is already receiving on (ADR 0004, amendment 2026-10-30).
 *
 * WhatsApp allows ONE connection per linked device, so this path is not a second socket but a
 * second VIEW of the daemon's — and what these tests pin is that the view costs the receive path
 * nothing it had before: the receiver is still handed a handle with no write method, no send view
 * is opened unless someone asked for one behind a permit, the permit fence still sits between the
 * sender and Baileys, a sender's `close()` does not take the connection down, and the sender adds
 * no second mapped subscription that would journal every incoming message twice.
 *
 * Every id and message is synthetic; nothing reads the real WhatsApp session, and nothing here
 * opens a socket.
 */

const PERMIT: SendPermit = { account: ACCOUNT, addresses: [ANNA_LID] };

/** Open the connection at once: `ready()` follows this, so it is what lets a send through. */
const openScript = (connection: FakeConnection) => {
  connection.handle.emit('connection.update', { connection: 'open' });
};

/** A drop that is not a logout — the receiver answers it with a fresh connection. */
const DROPPED = {
  connection: 'close' as const,
  lastDisconnect: { error: Object.assign(new Error('lost'), { output: { statusCode: 408 } }) },
};

interface Rig {
  accountId: string;
  backend: WhatsAppBackend;
  /** The connections `connect()` built, in order — one per (re)open. */
  connections: FakeConnection[];
}

/**
 * A linked account and a backend over the two-view connection factory — the daemon's case.
 * `receiveOnly` overrides `createSocket` instead, which is the no-daemon fallback: a session that
 * cannot send at all.
 */
async function withRig<T>(body: (rig: Rig) => Promise<T>, receiveOnly = false): Promise<T> {
  const dir = tempDir('curlew-whatsapp-in-session-');
  try {
    await link(dir);
    const connections = fakeConnectionFactory(openScript);
    const sockets = fakeFactory((socket) => socket.emit('connection.update', { connection: 'open' }));
    const backend = new WhatsAppBackend(context(dir), {
      ...(receiveOnly ? { createSocket: sockets.create } : { createConnection: connections.create }),
      receiver: { quietMs: 20, coalesceMs: 0, maxMs: 5_000 },
      flushDelayMs: 10,
      sendAckMs: 200,
    });
    return await body({ accountId: ACCOUNT, backend, connections: connections.connections });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return '';
  } catch (err) {
    return (err as Error).message;
  }
}

export default async () => {
  await describe('WhatsApp sending on the receive connection', async () => {
    await it('leaves a receive-only session with no way to open a sender', async () => {
      await withRig(async (rig) => {
        const session = await rig.backend.connect(rig.accountId, { mode: 'follow' });
        // What the app runs when no daemon holds the device: the send takes the receive lease and
        // opens a connection of its own instead, and this session is handed no sender to begin with.
        expect(session.openSender === undefined).toBe(true);
        expect('sendText' in session).toBe(false);
        await session.close();
        expect(rig.connections.length).toBe(0);
      }, true);
    });

    await it('sends on the connection it is receiving on, without opening a second one', async () => {
      await withRig(async (rig) => {
        const session = await rig.backend.connect(rig.accountId, { mode: 'follow' });
        expect(typeof session.openSender).toBe('function');
        await tick();
        expect(rig.connections.length).toBe(1);
        const connection = rig.connections[0];
        // The receive loop was handed the receive view, which has no write of any kind, and it
        // opened no send view of its own.
        expect('sendText' in connection.handle).toBe(false);
        expect(connection.sends.length).toBe(0);

        const sender = await session.openSender!(PERMIT);
        const sent = await sender.send({ to: ANNA_LID, text: 'Moin' });
        // One connection, one send view on it, and the text went out on that view.
        expect(rig.connections.length).toBe(1);
        expect(connection.sends.length).toBe(1);
        expect(JSON.stringify(connection.sends[0].sent.map((s) => [s.jid, s.text]))).toBe(
          JSON.stringify([[ANNA_LID, 'Moin']]),
        );
        expect(sent.target).toBe(ANNA_LID);
        expect(sent.warning === undefined).toBe(true);
        await sender.close();
        await session.close();
      });
    });

    await it('keeps the connection receiving after a sender closed', async () => {
      await withRig(async (rig) => {
        const session = await rig.backend.connect(rig.accountId, { mode: 'follow' });
        await tick();
        const connection = rig.connections[0];
        const sender = await session.openSender!(PERMIT);
        const sent = await sender.send({ to: ANNA_LID, text: 'Moin' });
        await sender.close();

        // The send view's `end()` ran and did nothing: whoever opened the connection owns its
        // lifetime, and a sender that closed it would take the daemon's receive loop with it.
        expect(connection.sendViewEnds).toBe(1);
        expect(connection.handle.ended).toBe(false);

        // The copy WhatsApp echoes back of our own send arrives on the connection, and it is the
        // DAEMON'S receive loop that takes it — which is why the in-session sender journals
        // nothing itself: one subscription, one write, exactly as for a message somebody else
        // sent. The echo carries the id the send returned, so it replaces the local echo instead
        // of adding a second row.
        const echo = await session.nextBatch();
        expect((echo ?? []).some((e) => e.type === 'message' && e.message.remoteId === sent.id)).toBe(true);

        // Still receiving — the connection delivers the next message as before.
        const pending = session.nextBatch();
        connection.handle.emit('messages.upsert', {
          type: 'notify',
          messages: [waMessage(ANNA_LID, 'IS1', 1_767_280_000, text('und?'))],
        });
        const batch = await pending;
        expect((batch ?? []).some((e) => e.type === 'message' && e.message.remoteId === 'IS1')).toBe(true);
        await session.close();
        expect(connection.handle.ended).toBe(true);
      });
    });

    await it('opens the send view off the connection the receiver reconnected to', async () => {
      await withRig(async (rig) => {
        const session = await rig.backend.connect(rig.accountId, { mode: 'follow' });
        await tick();
        expect(rig.connections.length).toBe(1);
        // A dropped connection is answered with a fresh one, and the one it replaced is gone —
        // so a send view may only ever be opened off the connection the receiver is on NOW.
        rig.connections[0].handle.emit('connection.update', DROPPED);
        await tick();
        expect(rig.connections.length).toBe(2);

        const sender = await session.openSender!(PERMIT);
        await sender.send({ to: ANNA_LID, text: 'nach dem Abriss' });
        expect(rig.connections[0].sends.length).toBe(0);
        expect(rig.connections[1].sends.length).toBe(1);
        expect(rig.connections[1].sends[0].sent.length).toBe(1);
        await sender.close();
        await session.close();
      });
    });

    await it('puts the permit fence between the send view and Baileys', async () => {
      await withRig(async (rig) => {
        const session = await rig.backend.connect(rig.accountId, { mode: 'follow' });
        await tick();
        const connection = rig.connections[0];

        // The sender re-checks the permit itself, exactly as on a connection of its own, and the
        // refusal means nothing reached the view.
        const sender = await session.openSender!(PERMIT);
        expect(await reasonOf(sender.send({ to: BEN_LID, text: 'Hallo' }))).toMatch(/is not granted/);
        expect(connection.sends[0].sent.length).toBe(0);
        await sender.close();

        // And behind it the same per-permit gate the direct path has: `inSessionSender` hands the
        // send view straight to `guardedSendSocket`, so this is the composition it builds.
        const gated = guardedSendSocket(connection.openSend(), [ANNA_LID]);
        let violation: unknown = null;
        try {
          await gated.sendText(BEN_LID, 'Hallo');
        } catch (err) {
          violation = err;
        }
        expect(violation instanceof SendViolation).toBe(true);
        expect(connection.sends[1].sent.length).toBe(0);
        await gated.sendText(ANNA_LID, 'Hallo');
        expect(connection.sends[1].sent.length).toBe(1);
        // The gate forwards `end()` — and on this view that is still a no-op.
        gated.end();
        expect(connection.handle.ended).toBe(false);
        await session.close();
      });
    });

    await it('adds nothing to the connection but its own acknowledgement listener', async () => {
      await withRig(async (rig) => {
        const session = await rig.backend.connect(rig.accountId, { mode: 'follow' });
        await tick();
        const connection = rig.connections[0];
        const receiving = connection.handle.listenerCount();
        expect(receiving > 0).toBe(true);

        const sender = await session.openSender!(PERMIT);
        // Exactly one: `messages.update`, where the server's ack for THIS send arrives. No second
        // mapped subscription — the daemon's receive loop is journalling this connection already,
        // and a sender that mapped it too would journal every incoming message twice.
        expect(connection.handle.listenerCount() - receiving).toBe(1);
        await sender.send({ to: ANNA_LID, text: 'Moin' });
        await sender.close();
        expect(connection.handle.listenerCount()).toBe(receiving);
        await session.close();
      });
    });
  });
};
