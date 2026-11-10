import { describe, expect, it } from '@gjsify/unit';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SendPermit } from '@curlew/protocol';
import { isSendBackend } from '@curlew/protocol';
import {
  chatConversationId,
  getConversation,
  rebuildConversations,
  receiveDeliveries,
  takeReceiveLease,
} from '@curlew/store';
import {
  guardedSendSocket,
  journalPath,
  sendRefusal,
  SendViolation,
  WHATSAPP_MANIFEST,
  WHATSAPP_MAX_CAPTION_CHARS,
  WHATSAPP_MAX_MESSAGE_BYTES,
  WhatsAppBackend,
} from '@curlew/whatsapp';

import { openIndex } from '../../../src/core/actions/index.ts';
import { sendAsAgent } from '../../../src/core/actions/send.ts';
import {
  ANNA_LID,
  ANNA_PN,
  BEN_LID,
  fakeFactory,
  FakeSendSocket,
  fakeSendFactory,
  type FakeSocket,
  GROUP,
} from './fake-socket.ts';
import { ACCOUNT, context, link, OWN_LID, tempDir } from './world.ts';

/**
 * The WhatsApp send path without WhatsApp: the grant, the two handle shapes that keep a sync from
 * writing, the per-permit gate, the address forms curlew refuses, the byte limit, the
 * acknowledgement it waits for, the echo that replaces the local row, and the receive lease that
 * keeps a send and the daemon off the same linked device.
 *
 * There is no fan-out to assert here, and that is the point: Baileys enumerates the recipient's
 * and this account's devices, fetches pre-keys and encrypts one copy each, all inside the one
 * `sendMessage` call this package wraps. So what a test can pin is the argument curlew passes,
 * what it does with the answer, and what it refuses before the call — not a device list curlew
 * never assembles.
 *
 * Every id, number and message is synthetic; nothing reads the real WhatsApp session.
 */

/** A sync that finds nothing: enough to open, drain the journal and report caught up. */
function syncScript(socket: FakeSocket): void {
  socket.emit('connection.update', { connection: 'open' });
  socket.emit('connection.update', { receivedPendingNotifications: true });
  socket.emit('creds.update', { accountSyncCounter: 1 });
}

interface RigOptions {
  /** Script each send socket before it opens — `ack`, `echo`, `failWith`, `keyFor`. */
  onSend?: (socket: FakeSendSocket, index: number) => void;
  /** How long a send waits for `SERVER_ACK`. Short, so the timeout case costs no real wait. */
  ackMs?: number;
}

interface Rig {
  dir: string;
  configPath: string;
  dbPath: string;
  accountId: string;
  backend: WhatsAppBackend;
  /** The sockets `openSender` built, in order. */
  senders: FakeSendSocket[];
  /** The sockets `connect` built — a send may never appear among these. */
  syncs: FakeSocket[];
}

const grant = (capability: string, address: string) => ({
  capability,
  target: `${ACCOUNT}/${address}`,
});

const GRANTED = { grants: [grant('whatsapp.send', ANNA_LID)] };
const GRANTED_SELF = { grants: [grant('whatsapp.send', OWN_LID)] };

/** A linked account in a temporary directory, a config, and a backend over both socket factories. */
async function withRig<T>(
  config: unknown,
  body: (rig: Rig) => Promise<T>,
  options: RigOptions = {},
): Promise<T> {
  const dir = tempDir('curlew-whatsapp-send-');
  try {
    await link(dir);
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify(config));

    const senders = fakeSendFactory(options.onSend);
    const syncs = fakeFactory(syncScript);
    const backend = new WhatsAppBackend(context(dir), {
      createSocket: syncs.create,
      createSendSocket: senders.create,
      receiver: { quietMs: 20, coalesceMs: 0, maxMs: 5_000 },
      flushDelayMs: 10,
      sendAckMs: options.ackMs ?? 200,
    });
    return await body({
      dir,
      configPath,
      dbPath: join(dir, 'index.db'),
      accountId: ACCOUNT,
      backend,
      senders: senders.sockets,
      syncs: syncs.sockets,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const send = (rig: Rig, to: string, text: string) =>
  sendAsAgent({
    accountId: rig.accountId,
    to,
    text,
    frontend: 'cli',
    dbPath: rig.dbPath,
    configPath: rig.configPath,
    writeLogPath: join(rig.dir, 'writes.log'),
    backend: rig.backend,
  });

async function refused(promise: Promise<unknown>): Promise<boolean> {
  try {
    await promise;
    return false;
  } catch {
    return true;
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

/** The chat as the index files it, bodies included. */
function chatOf(dbPath: string, remoteId: string) {
  const db = openIndex(dbPath);
  try {
    return getConversation(db, chatConversationId('whatsapp', ACCOUNT, remoteId), { includeBodies: true });
  } finally {
    db.close();
  }
}

export default async () => {
  await describe('WhatsApp sending', async () => {
    await it('is a send backend whose handle talks to nobody until it sends', async () => {
      await withRig(GRANTED, async (rig) => {
        expect(isSendBackend(rig.backend)).toBe(true);
        // One connection per linked device, and the auth state is one file with no lock between
        // the daemon and a send — so the app has to serialise them.
        expect(WHATSAPP_MANIFEST.sendSharesReceiveState).toBe(true);

        const permit: SendPermit = { account: rig.accountId, addresses: [ANNA_LID] };
        const sender = await rig.backend.openSender(rig.accountId, permit);
        // WhatsApp's body is plain text; files are the one thing it carries besides.
        expect(sender.features.markdown).toBe(false);
        expect(sender.features.attachments).toBe(true);
        expect(sender.sendImage === undefined).toBe(true);
        await sender.close();

        expect(rig.senders.length).toBe(1);
        expect(rig.senders[0].sent.length).toBe(0);
        expect(rig.senders[0].ended).toBe(true);
        // A second close is what the app's `finally` plus an abort amount to.
        await sender.close();
      });
    });

    await it('keeps the receive session unable to send', async () => {
      await withRig(GRANTED, async (rig) => {
        const session = await rig.backend.connect(rig.accountId, { mode: 'catch-up' });
        expect('send' in session).toBe(false);
        expect('sendText' in session).toBe(false);
        await session.close();

        // The handle a sync is handed has no write at all — not a send method behind a flag.
        expect(rig.syncs.length).toBe(1);
        expect('sendText' in rig.syncs[0]).toBe(false);
        // And a sync builds no send socket, whatever the grants say.
        expect(rig.senders.length).toBe(0);
      });
    });

    await it('gates the one write fail-closed, per permit', async () => {
      // The permitted list is normalized, so a grant naming a device or a number matches nothing.
      expect(sendRefusal(ANNA_LID, [ANNA_LID])).toBe(null);
      expect(sendRefusal(ANNA_PN, [ANNA_PN])).toBe(null);
      for (const jid of [GROUP, 'status@broadcast', '+4915100000001', `${ANNA_LID.split('@')[0]}:3@lid`]) {
        expect(sendRefusal(jid, [ANNA_LID])).toBe('an address that is not a WhatsApp chat id');
      }
      // Somebody no grant names is refused — without the refusal repeating their JID.
      const reason = sendRefusal(BEN_LID, [ANNA_LID]);
      expect(reason).toBe('a chat no grant names');
      expect(reason?.includes(BEN_LID)).toBe(false);

      // The wrapped handle is what `openSender` hands on, and it refuses before Baileys sees it.
      const bare = new FakeSendSocket({ auth: null as never });
      bare.open();
      const gated = guardedSendSocket(bare, [ANNA_LID]);
      let violation: unknown = null;
      try {
        await gated.sendText(BEN_LID, 'Hallo');
      } catch (err) {
        violation = err;
      }
      expect(violation instanceof SendViolation).toBe(true);
      expect(bare.sent.length).toBe(0);
      await gated.sendText(ANNA_LID, 'Hallo');
      expect(bare.sent.map((s) => s.jid).join()).toBe(ANNA_LID);

      // A file passes the same gate.
      const file = { bytes: new Uint8Array([1]), fileName: 'a.pdf', mimeType: 'application/pdf' };
      let fileViolation: unknown = null;
      try {
        await gated.sendFile(BEN_LID, file);
      } catch (err) {
        fileViolation = err;
      }
      expect(fileViolation instanceof SendViolation).toBe(true);
      expect(bare.files.length).toBe(0);
      await gated.sendFile(ANNA_LID, file);
      expect(bare.files.map((f) => f.jid).join()).toBe(ANNA_LID);
    });

    await it('sends files one message each, with the text as the caption of the first', async () => {
      await withRig(GRANTED, async (rig) => {
        const photo = join(rig.dir, 'photo.png');
        const doc = join(rig.dir, 'notes.pdf');
        writeFileSync(photo, new Uint8Array([1, 2, 3]));
        writeFileSync(doc, new Uint8Array([4, 5]));
        const permit: SendPermit = { account: rig.accountId, addresses: [ANNA_LID] };
        const sender = await rig.backend.openSender(rig.accountId, permit);
        try {
          const result = await sender.send({
            to: ANNA_LID,
            text: 'Hier',
            attachments: [{ path: photo }, { path: doc }],
          });
          const [socket] = rig.senders;
          expect(socket.sent.length).toBe(0);
          expect(socket.files.map((f) => f.file.fileName).join()).toBe('photo.png,notes.pdf');
          expect(socket.files.map((f) => f.file.mimeType).join()).toBe('image/png,application/pdf');
          expect(socket.files[0].file.caption).toBe('Hier');
          expect(socket.files[1].file.caption === undefined).toBe(true);
          expect(socket.files[0].file.bytes.length).toBe(3);
          expect(result.attachments?.map((a) => `${a.filename}:${a.size}`).join()).toBe(
            'photo.png:3,notes.pdf:2',
          );
          expect(result.warning === undefined).toBe(true);
        } finally {
          await sender.close();
        }
      });
    });

    await it('sends a text too long for a caption as a message of its own', async () => {
      await withRig(GRANTED, async (rig) => {
        const doc = join(rig.dir, 'notes.pdf');
        writeFileSync(doc, new Uint8Array([4]));
        const long = 'x'.repeat(WHATSAPP_MAX_CAPTION_CHARS + 1);
        const permit: SendPermit = { account: rig.accountId, addresses: [ANNA_LID] };
        const sender = await rig.backend.openSender(rig.accountId, permit);
        try {
          await sender.send({ to: ANNA_LID, text: long, attachments: [{ path: doc }] });
          const [socket] = rig.senders;
          expect(socket.files[0].file.caption === undefined).toBe(true);
          expect(socket.sent.map((s) => s.text.length).join()).toBe(String(long.length));
        } finally {
          await sender.close();
        }
      });
    });

    await it('quotes the message it answers, with its id, author and content', async () => {
      await withRig(GRANTED, async (rig) => {
        const permit: SendPermit = { account: rig.accountId, addresses: [ANNA_LID] };
        const sender = await rig.backend.openSender(rig.accountId, permit);
        expect(sender.features.replies).toBe(true);
        try {
          await sender.send({
            to: ANNA_LID,
            text: 'Antwort',
            replyTo: { remoteId: 'WAMSG1', text: 'Treffen wir uns?' },
          });
          await sender.send({
            to: ANNA_LID,
            text: 'Nochmal',
            replyTo: { remoteId: 'WAMSG2', fromSelf: true },
          });
          await sender.send({ to: ANNA_LID, text: 'Ohne' });
          const [socket] = rig.senders;
          expect(socket.sent[0].quote).toStrictEqual({
            id: 'WAMSG1',
            fromMe: false,
            text: 'Treffen wir uns?',
          });
          expect(socket.sent[1].quote).toStrictEqual({ id: 'WAMSG2', fromMe: true, text: '' });
          expect(socket.sent[2].quote === undefined).toBe(true);
        } finally {
          await sender.close();
        }
      });
    });

    await it('reacts to a message by its key, takes the reaction back, and gates the chat', async () => {
      await withRig(GRANTED, async (rig) => {
        const permit: SendPermit = { account: rig.accountId, addresses: [ANNA_LID] };
        const sender = await rig.backend.openSender(rig.accountId, permit);
        expect(sender.features.reactions).toBe(true);
        try {
          await sender.react?.({ to: ANNA_LID, target: { remoteId: 'WAMSG1' }, emoji: '👍' });
          await sender.react?.({ to: ANNA_LID, target: { remoteId: 'WAMSG2', fromSelf: true }, emoji: null });
          const [socket] = rig.senders;
          expect(socket.reactions.map((r) => r.reaction)).toStrictEqual([
            { id: 'WAMSG1', fromMe: false, emoji: '👍' },
            { id: 'WAMSG2', fromMe: true, emoji: '' },
          ]);
          expect(socket.sent.length + socket.files.length).toBe(0);
          expect(
            (
              await reasonOf(
                sender.react?.({ to: BEN_LID, target: { remoteId: 'x' }, emoji: '👍' }) as Promise<unknown>,
              )
            ).includes('is not granted'),
          ).toBe(true);
          expect(
            (
              await reasonOf(
                sender.react?.({ to: GROUP, target: { remoteId: 'x' }, emoji: '👍' }) as Promise<unknown>,
              )
            ).includes('group'),
          ).toBe(true);
          expect(socket.reactions.length).toBe(2);
        } finally {
          await sender.close();
        }
      });
    });

    await it('refuses a reply that carries files, sending nothing', async () => {
      await withRig(GRANTED, async (rig) => {
        const doc = join(rig.dir, 'notes.pdf');
        writeFileSync(doc, new Uint8Array([4]));
        const permit: SendPermit = { account: rig.accountId, addresses: [ANNA_LID] };
        const sender = await rig.backend.openSender(rig.accountId, permit);
        try {
          const reason = await reasonOf(
            sender.send({
              to: ANNA_LID,
              text: 'Hier',
              attachments: [{ path: doc }],
              replyTo: { remoteId: 'WAMSG1' },
            }),
          );
          expect(reason.includes('cannot carry files')).toBe(true);
          expect(rig.senders[0].files.length + rig.senders[0].sent.length).toBe(0);
        } finally {
          await sender.close();
        }
      });
    });

    await it('refuses a file it cannot send before anything goes out', async () => {
      await withRig(GRANTED, async (rig) => {
        const permit: SendPermit = { account: rig.accountId, addresses: [ANNA_LID] };
        const sender = await rig.backend.openSender(rig.accountId, permit);
        try {
          const reason = await reasonOf(
            sender.send({ to: ANNA_LID, text: 'Hier', attachments: [{ path: join(rig.dir, 'gone.pdf') }] }),
          );
          expect(reason.includes('cannot be read')).toBe(true);
          expect(
            await reasonOf(sender.send({ to: ANNA_LID, text: '', attachments: [{ path: 'rel.pdf' }] })),
          ).toMatch(/not an absolute path/);
          expect(rig.senders[0].files.length).toBe(0);
          expect(rig.senders[0].sent.length).toBe(0);
        } finally {
          await sender.close();
        }
      });
    });

    await it('refuses without a whatsapp.send grant, before anything is opened', async () => {
      for (const config of [{ grants: [] }]) {
        await withRig(config, async (rig) => {
          expect(await refused(send(rig, ANNA_LID, 'Hallo'))).toBe(true);
          expect(rig.senders.length).toBe(0);
        });
      }
    });

    await it('refuses a group, a broadcast, a device, a number and an address no grant names', async () => {
      await withRig(GRANTED, async (rig) => {
        expect(await refused(send(rig, BEN_LID, 'Hallo'))).toBe(true);
        expect(rig.senders.length).toBe(0);

        const permit: SendPermit = { account: rig.accountId, addresses: [ANNA_LID] };
        const sender = await rig.backend.openSender(rig.accountId, permit);
        try {
          const refusals = [
            // A group message is encrypted for every member, from a list curlew does not keep.
            { to: GROUP, says: 'cannot send to a WhatsApp group' },
            { to: 'status@broadcast', says: 'does not send status updates' },
            // One device of a person is not the person; the fan-out is the protocol's job.
            { to: `${ANNA_LID.split('@')[0]}:3@lid`, says: 'names one device of a person' },
            // A chat is filed under the LID, so a number names no chat curlew can read back.
            { to: '+4915100000001', says: 'is a phone number' },
            { to: 'anna', says: 'is not a WhatsApp chat id' },
            { to: BEN_LID, says: 'is not granted' },
          ];
          for (const { to, says } of refusals) {
            expect((await reasonOf(sender.send({ to, text: 'Hallo' }))).includes(says)).toBe(true);
          }
        } finally {
          await sender.close();
        }
        expect(rig.senders[0].sent.length).toBe(0);
      });
    });

    await it('sends the text to the granted chat, logs the write and indexes the message', async () => {
      await withRig(GRANTED, async (rig) => {
        const out = await send(rig, ANNA_LID, 'Hallo Anna');
        expect(out.backend).toBe('whatsapp');
        expect(out.target).toBe(`${ACCOUNT}/${ANNA_LID}`);
        // The chat as the INDEX files it, resolved from the key Baileys answered with.
        expect(out.chatJid).toBe(ANNA_LID);
        expect(out.sendWarning === undefined).toBe(true);

        const socket = rig.senders[0];
        expect(socket.sent.map((s) => `${s.jid} ${s.text}`).join()).toBe(`${ANNA_LID} Hallo Anna`);
        // The id the receive path uses for our own messages, so the echo can replace the row.
        expect(out.originId).toBe(socket.sent[0].id);
        expect(out.sentAt).toBe(new Date(socket.sent[0].seconds * 1000).toISOString());
        // The handle is closed with the message, not kept open for the next one.
        expect(socket.ended).toBe(true);

        const lines = readFileSync(join(rig.dir, 'writes.log'), 'utf8').trim().split('\n');
        expect(lines.length).toBe(1);
        const line = JSON.parse(lines[0]);
        expect(line.capability).toBe('whatsapp.send');
        expect(line.target).toBe(`${ACCOUNT}/${ANNA_LID}`);
        expect(line.id).toBe(out.originId);
        // The write log records that something was sent, never the text of it.
        expect(line.text === undefined).toBe(true);

        const view = chatOf(rig.dbPath, ANNA_LID);
        expect(view?.messages.length).toBe(1);
        expect(view?.messages[0].fromSelf).toBe(true);
        expect(view?.messages[0].bodyText).toBe('Hallo Anna');

        // A second send proves the lease was given back, and gets its own connection.
        const again = await send(rig, ANNA_LID, 'Noch etwas');
        expect(again.originId).toBe(rig.senders[1].sent[0].id);
        expect(again.originId === out.originId).toBe(false);
        expect(rig.senders.length).toBe(2);
        expect(chatOf(rig.dbPath, ANNA_LID)?.messages.length).toBe(2);
      });
    });

    await it('refuses a message over the byte limit instead of splitting it', async () => {
      await withRig(GRANTED, async (rig) => {
        // Measured in bytes, not characters: two bytes per 'ä' is one byte over the limit.
        const long = 'ä'.repeat(WHATSAPP_MAX_MESSAGE_BYTES / 2 + 1);
        expect((await reasonOf(send(rig, ANNA_LID, long))).includes('at most')).toBe(true);
        expect(rig.senders[0].sent.length).toBe(0);
      });

      await withRig(GRANTED, async (rig) => {
        await send(rig, ANNA_LID, 'x'.repeat(WHATSAPP_MAX_MESSAGE_BYTES));
        expect(rig.senders[0].sent.length).toBe(1);
      });
    });

    await it('reports a missing acknowledgement as a warning, not as a failed send', async () => {
      await withRig(
        GRANTED,
        async (rig) => {
          const out = await send(rig, ANNA_LID, 'Hallo Anna');
          // The stanza is on the wire. Failing the call would get it sent twice on the retry, so
          // the delivery stands and the gap is named in the answer.
          expect(out.sendWarning?.includes('did not confirm')).toBe(true);
          expect(rig.senders[0].sent.length).toBe(1);
          expect(chatOf(rig.dbPath, ANNA_LID)?.messages.length).toBe(1);
        },
        {
          ackMs: 20,
          onSend: (socket) => {
            socket.ack = false;
          },
        },
      );
    });

    await it('sends nothing and indexes nothing when the stanza does not go out', async () => {
      await withRig(
        GRANTED,
        async (rig) => {
          expect((await reasonOf(send(rig, ANNA_LID, 'Hallo'))).includes('went nowhere')).toBe(true);
          expect(rig.senders[0].sent.length).toBe(0);
          expect(chatOf(rig.dbPath, ANNA_LID)?.messages.length ?? 0).toBe(0);
        },
        {
          onSend: (socket) => {
            socket.failWith = new Error('the stanza went nowhere');
          },
        },
      );
    });

    await it('replaces the local echo when the sent message comes back', async () => {
      await withRig(GRANTED, async (rig) => {
        const out = await send(rig, ANNA_LID, 'Hallo Anna');
        expect(out.messageId !== null).toBe(true);
        // The send socket receives like any other connection, so its own echo was written down
        // rather than acknowledged to WhatsApp and dropped on close.
        const journal = journalPath(join(context(rig.dir).secretsDir, `${ACCOUNT}.db`));
        expect(readFileSync(journal, 'utf8').includes(`"${out.originId}"`)).toBe(true);

        const db = openIndex(rig.dbPath);
        try {
          const result = await receiveDeliveries(db, rig.backend);
          expect(result.errors).toBe(0);
          rebuildConversations(db);
          const view = getConversation(db, chatConversationId('whatsapp', ACCOUNT, ANNA_LID), {
            includeBodies: true,
          });
          // One message, not the local echo plus the copy that came back.
          expect(view?.messages.length).toBe(1);
          expect(view?.messages[0].ref.remoteId).toBe(out.originId);
          expect(view?.messages[0].fromSelf).toBe(true);
          expect(view?.messages[0].bodyText).toBe('Hallo Anna');
        } finally {
          db.close();
        }
      });
    });

    await it('sends a note to self into the own chat, and files it as our own message', async () => {
      await withRig(GRANTED_SELF, async (rig) => {
        const out = await send(rig, OWN_LID, 'Notiz an mich');
        expect(out.chatJid).toBe(OWN_LID);
        expect(rig.senders[0].sent.map((s) => s.jid).join()).toBe(OWN_LID);

        const db = openIndex(rig.dbPath);
        try {
          await receiveDeliveries(db, rig.backend);
          rebuildConversations(db);
          const view = getConversation(db, chatConversationId('whatsapp', ACCOUNT, OWN_LID), {
            includeBodies: true,
          });
          expect(view?.messages.length).toBe(1);
          // `fromMe` on the key the server answered with, not a guess from the address.
          expect(view?.messages[0].fromSelf).toBe(true);
          expect(view?.messages[0].bodyText).toBe('Notiz an mich');
        } finally {
          db.close();
        }
      });
    });

    await it('files the echo under the chat id the index uses, not the address that was granted', async () => {
      // A grant may name the phone-number JID while the chat is filed under the LID. The message
      // goes to the address the grant names — curlew rewrites nothing — but the echo belongs in
      // the chat a caller can read back.
      await withRig(
        { grants: [grant('whatsapp.send', ANNA_PN)] },
        async (rig) => {
          const out = await send(rig, ANNA_PN, 'Hallo Anna');
          expect(rig.senders[0].sent.map((s) => s.jid).join()).toBe(ANNA_PN);
          expect(out.chatJid).toBe(ANNA_LID);
          expect(chatOf(rig.dbPath, ANNA_LID)?.messages[0].bodyText).toBe('Hallo Anna');
        },
        {
          // The server answers with both halves of the pair, as it does once it knows them.
          onSend: (socket) => {
            socket.keyFor = (jid, id) => ({
              remoteJid: jid,
              remoteJidAlt: ANNA_LID,
              fromMe: true,
              id,
            });
          },
        },
      );
    });

    await it('refuses to send while the daemon is receiving this account', async () => {
      await withRig(GRANTED, async (rig) => {
        // WhatsApp allows ONE connection per linked device, and a second socket on the same
        // credentials can get the daemon's replaced (status 440). Refused rather than risked.
        const db = openIndex(rig.dbPath);
        try {
          takeReceiveLease(db, 'whatsapp', ACCOUNT, 'daemon-4242', new Date());
        } finally {
          db.close();
        }

        const reason = await reasonOf(send(rig, ANNA_LID, 'Hallo'));
        expect(reason.includes('daemon-4242')).toBe(true);
        expect(reason.includes('curlew daemon stop')).toBe(true);
        // Refused before the handle exists, so it costs no connection and no relink risk.
        expect(rig.senders.length).toBe(0);
      });
    });
  });
};
