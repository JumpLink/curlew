import { describe, expect, it } from '@gjsify/unit';

import type { SendPermit } from '@curlew/protocol';
import {
  chatMessage,
  encryptedChatMessage,
  correctionMessage,
  reactionMessage,
  retractionMessage,
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
  reaction?: { target: string; emojis: readonly string[] };
  correction?: { target: string; body: string };
  retraction?: { target: string };
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
    sendReaction: async (to, _id, target, emojis) => {
      sent.push({ to, reaction: { target, emojis }, encrypted: false });
    },
    sendCorrection: async (to, _id, target, body) => {
      sent.push({ to, correction: { target, body }, encrypted: false });
    },
    sendRetraction: async (to, _id, target) => {
      sent.push({ to, retraction: { target }, encrypted: false });
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

    await it('builds a XEP-0444 reaction with the whole set, empty to take it back', async () => {
      const set = reactionMessage({ to: PEER, id: 'r1', target: 'their-id', emojis: ['👍'] });
      const reactions = set.getChild('reactions', 'urn:xmpp:reactions:0');
      expect(reactions?.attrs.id).toBe('their-id');
      expect(reactions?.getChildren('reaction').map((r) => r.text())).toStrictEqual(['👍']);
      const none = reactionMessage({ to: PEER, id: 'r2', target: 'their-id', emojis: [] });
      expect(none.getChild('reactions', 'urn:xmpp:reactions:0')?.getChildren('reaction').length).toBe(0);
    });

    await it('reacts by the sender-given id, and takes the reaction back with an empty set', async () => {
      const sent: Sent[] = [];
      const sender = senderOf(sent);
      expect(sender.features.reactions).toBe(true);
      await sender.react!({ to: PEER, target: { remoteId: 'archive-9', clientId: 'their-id' }, emoji: '🎉' });
      await sender.react!({
        to: PEER,
        target: { remoteId: 'archive-9', clientId: 'their-id' },
        emoji: null,
        previous: '🎉',
      });
      expect(sent[0].reaction).toStrictEqual({ target: 'their-id', emojis: ['🎉'] });
      expect(sent[1].reaction).toStrictEqual({ target: 'their-id', emojis: [] });
    });

    await it('refuses a reaction without the sender-given id and one in an encrypted chat', async () => {
      const sent: Sent[] = [];
      const noId = await failure(
        senderOf(sent).react!({ to: PEER, target: { remoteId: 'archive-9' }, emoji: '👍' }),
      );
      expect(noId?.includes('no XMPP id')).toBe(true);
      const sealed = await failure(
        senderOf(sent, true).react!({ to: PEER, target: { remoteId: 'a', clientId: 'c' }, emoji: '👍' }),
      );
      expect(sealed?.includes('unencrypted')).toBe(true);
      expect(sent.length).toBe(0);
    });

    await it('builds a XEP-0308 correction and a XEP-0424 retraction naming the original', async () => {
      const fix = correctionMessage({ to: PEER, id: 'c1', target: 'my-id', body: 'Fixed' });
      expect(fix.getChild('replace', 'urn:xmpp:message-correct:0')?.attrs.id).toBe('my-id');
      expect(fix.getChildText('body')).toBe('Fixed');
      expect(fix.getChild('origin-id', 'urn:xmpp:sid:0')?.attrs.id).toBe('c1');
      const gone = retractionMessage({ to: PEER, id: 'r1', target: 'my-id' });
      expect(gone.getChild('retract', 'urn:xmpp:message-retract:1')?.attrs.id).toBe('my-id');
      expect(gone.getChild('fallback', 'urn:xmpp:fallback:0')?.attrs.for).toBe('urn:xmpp:message-retract:1');
      expect(gone.getChild('store', 'urn:xmpp:hints') !== undefined).toBe(true);
    });

    await it('edits and deletes by the sender-given id, own messages only', async () => {
      const sent: Sent[] = [];
      const sender = senderOf(sent);
      expect(sender.features.edits).toBe(true);
      expect(sender.features.deletes).toBe(true);
      const mine = { remoteId: 'archive-9', clientId: 'my-id', fromSelf: true };
      await sender.edit!({ to: PEER, target: mine, text: 'Fixed' });
      await sender.delete!({ to: PEER, target: mine });
      expect(sent[0].correction).toStrictEqual({ target: 'my-id', body: 'Fixed' });
      expect(sent[1].retraction).toStrictEqual({ target: 'my-id' });
      const theirs = { remoteId: 'a', clientId: 'their-id', fromSelf: false };
      const noId = { remoteId: 'a', fromSelf: true };
      for (const attempt of [
        sender.edit!({ to: PEER, target: theirs, text: 'x' }),
        sender.delete!({ to: PEER, target: theirs }),
        sender.edit!({ to: PEER, target: noId, text: 'x' }),
        sender.delete!({ to: PEER, target: noId }),
        sender.edit!({ to: PEER, target: mine, text: '  ' }),
        sender.edit!({ to: PEER, target: mine, text: 'x'.repeat(8001) }),
        sender.edit!({ to: 'bob@example.org', target: mine, text: 'x' }),
      ]) {
        expect((await failure(attempt)) !== null).toBe(true);
      }
      expect(sent.length).toBe(2);
    });

    await it('refuses to edit or delete in an encrypted chat', async () => {
      const sent: Sent[] = [];
      const sender = senderOf(sent, true);
      const mine = { remoteId: 'a', clientId: 'c', fromSelf: true };
      expect(
        (await failure(sender.edit!({ to: PEER, target: mine, text: 'x' })))?.includes('unencrypted'),
      ).toBe(true);
      expect((await failure(sender.delete!({ to: PEER, target: mine })))?.includes('unencrypted')).toBe(true);
      expect(sent.length).toBe(0);
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
