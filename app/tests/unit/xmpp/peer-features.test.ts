import { describe, expect, it } from '@gjsify/unit';

import {
  threadCapabilitiesOf,
  XMPP_CORRECT_NS,
  XMPP_REACTIONS_NS,
  XMPP_RETRACT_NS,
  type ThreadFacts,
} from '@curlew/protocol';
import { XMPP_MANIFEST, XmppChatSession } from '@curlew/xmpp';

import { ANNA, BEN, entry, fakeApi, fakeServer, ROOM } from './fake-api.ts';

// Per-JID gating of reactions, corrections and retractions (XEP-0444/0308/0424). Synthetic only.

const at = (minute: number): string => new Date(Date.UTC(2026, 0, 1, 10, minute)).toISOString();
const of = (facts: Partial<ThreadFacts>) =>
  threadCapabilitiesOf(XMPP_MANIFEST.capabilities, { backend: 'xmpp', kind: 'direct', ...facts });

export default async () => {
  await describe('XMPP peer features', async () => {
    await it('records which message XEPs each direct peer advertises', async () => {
      const server = fakeServer({
        roster: [
          { jid: ANNA, name: 'Anna', subscription: 'both' },
          { jid: BEN, name: 'Ben', subscription: 'both' },
        ],
        bookmarks: [{ jid: ROOM, name: 'Orga', nick: 'me', autojoin: true }],
        own: [entry({ id: 'a1', at: at(1), from: ANNA, body: 'x' })],
        peerFeatures: new Map([[ANNA, new Set([XMPP_REACTIONS_NS, XMPP_CORRECT_NS, 'urn:other'])]]),
      });
      const chats = await new XmppChatSession(fakeApi(server)).listChats();
      const byId = new Map(chats.map((c) => [c.remoteId, c]));
      expect(byId.get(ANNA)?.peerFeatures).toStrictEqual([XMPP_REACTIONS_NS, XMPP_CORRECT_NS]);
      expect(byId.get(BEN)?.peerFeatures).toStrictEqual([]);
      expect(byId.get(ROOM)?.peerFeatures).toBe(undefined);
    });

    await it('treats a peer that does not answer as unknown', async () => {
      const server = fakeServer({ roster: [{ jid: ANNA, name: 'Anna', subscription: 'both' }] });
      const api = { ...fakeApi(server), features: async () => Promise.reject(new Error('timeout')) };
      const chats = await new XmppChatSession(api).listChats();
      expect(chats[0].peerFeatures).toBe(undefined);
    });

    await it('offers each action only when the peer advertises its XEP', async () => {
      expect(of({ peerFeatures: [XMPP_REACTIONS_NS] })).toMatchObject({
        reactions: true,
        edits: false,
        deletes: false,
      });
      expect(of({ peerFeatures: [XMPP_CORRECT_NS, XMPP_RETRACT_NS] })).toMatchObject({
        reactions: false,
        edits: true,
        deletes: true,
      });
    });

    await it('offers nothing to a peer of unknown capabilities, and keeps replies and files', async () => {
      const result = of({});
      expect(result.reactions || result.edits || result.deletes).toBe(false);
      expect(result.replies).toBe(true);
      expect(result.attachments).toBe(true);
    });

    await it('leaves a room at the manifest', async () => {
      expect(of({ kind: 'group' })).toMatchObject({ reactions: true, edits: true, deletes: true });
    });
  });
};
