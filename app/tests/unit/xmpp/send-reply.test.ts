import { describe, expect, it } from '@gjsify/unit';

import type { SendPermit } from '@curlew/protocol';
import {
  chatMessage,
  encryptedChatMessage,
  type EncryptedStanza,
  GrantedXmppSession,
  type GrantedOmemo,
  XmppSender,
  type XmppLink,
} from '@curlew/xmpp';

// Synthetic only: users on example.org, a fake link that records the stanza arguments.

const ACCOUNT = 'xmpp-me-example-org';
const PEER = 'anna@example.org';
const ME = 'me@example.org';
const PERMIT: SendPermit = { account: ACCOUNT, addresses: [PEER] };

interface Sent {
  to: string;
  body?: string;
  reply?: { id: string; author: string };
  encrypted: boolean;
}

function fakeLink(sent: Sent[]): XmppLink {
  return {
    jid: ME,
    roster: async () => [],
    bookmarks: async () => [],
    features: async () => new Set(),
    mam: async () => ({ entries: [], complete: true }),
    close: async () => {},
    sendChat: async (to, _id, body, _oob, reply) => {
      sent.push({ to, body, ...(reply ? { reply } : {}), encrypted: false });
    },
    sendEncrypted: async (to, _id, _stanza, _fallback, reply) => {
      sent.push({ to, ...(reply ? { reply } : {}), encrypted: true });
    },
    uploadSlot: async () => {
      throw new Error('no upload in this test');
    },
    putFile: async () => {},
    goAvailable: async () => {},
    pepGet: async () => undefined,
    pepSet: async () => {},
    onArrival: () => () => {},
    onClosed: () => {},
  };
}

const omemo = (): GrantedOmemo =>
  ({
    decrypt: async () => [],
    encrypts: async () => true,
    encrypt: async () => ({ senderDeviceId: 1, keys: [], iv: new Uint8Array(12) }) as EncryptedStanza,
    close: () => {},
  }) as GrantedOmemo;

const senderOf = (sent: Sent[], withOmemo = false) =>
  new XmppSender(
    new GrantedXmppSession(fakeLink(sent), PERMIT, () => 'origin-1', withOmemo ? omemo() : undefined),
  );

async function failure(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export default async () => {
  await describe('XMPP replies (XEP-0461)', async () => {
    await it('puts <reply/> in the stanza, plain and encrypted', async () => {
      const reply = { id: 'their-id', author: PEER };
      const plain = chatMessage({ to: PEER, id: 'o1', body: 'Yes', reply }).getChild(
        'reply',
        'urn:xmpp:reply:0',
      );
      expect(plain?.attrs.id).toBe('their-id');
      expect(plain?.attrs.to).toBe(PEER);
      const sealed = encryptedChatMessage({
        to: PEER,
        id: 'o2',
        encrypted: { senderDeviceId: 1, keys: [], iv: new Uint8Array(12) } as EncryptedStanza,
        reply,
      });
      expect(sealed.getChild('reply', 'urn:xmpp:reply:0')?.attrs.id).toBe('their-id');
      expect(chatMessage({ to: PEER, id: 'o3', body: 'Plain' }).getChild('reply', 'urn:xmpp:reply:0')).toBe(
        undefined,
      );
    });

    await it('names the sender-given id and the author of the answered message', async () => {
      const sent: Sent[] = [];
      const sender = senderOf(sent);
      expect(sender.features.replies).toBe(true);
      await sender.send({ to: PEER, text: 'Yes', replyTo: { remoteId: 'archive-9', clientId: 'their-id' } });
      await sender.send({
        to: PEER,
        text: 'Again',
        replyTo: { remoteId: 'archive-10', clientId: 'my-id', fromSelf: true },
      });
      expect(sent[0].reply?.id).toBe('their-id');
      expect(sent[0].reply?.author).toBe(PEER);
      expect(sent[1].reply?.id).toBe('my-id');
      expect(sent[1].reply?.author).toBe(ME);
    });

    await it('replies inside an encrypted chat too', async () => {
      const sent: Sent[] = [];
      await senderOf(sent, true).send({
        to: PEER,
        text: 'Secret',
        replyTo: { remoteId: 'a', clientId: 'c' },
      });
      expect(sent[0].encrypted).toBe(true);
      expect(sent[0].reply?.id).toBe('c');
    });

    await it('refuses a target without the sender-given id, sending nothing', async () => {
      const sent: Sent[] = [];
      const why = await failure(
        senderOf(sent).send({ to: PEER, text: 'Yes', replyTo: { remoteId: 'archive-9' } }),
      );
      expect(why?.includes('no XMPP id')).toBe(true);
      expect(sent.length).toBe(0);
    });
  });
};
