/**
 * A PEP service in a Map, and the accounts that announce themselves on it.
 *
 * Shared by the OMEMO send and archive suites: both need real devices whose bundles the other
 * side can fetch, which is all PEP is used for in XEP-0384. Nothing here is a fixture — the keys
 * are generated and the stanzas are built by our own code, so what a case gets handed is what a
 * server would have handed it.
 */

import xml from '@xmpp/xml';

import { MemoryOmemoStorage, type OmemoStorage } from '@curlew/omemo';
import { NS, XmppQueryError, announceDevice, type OwnDevice, type PepPort } from '@curlew/xmpp';

/** When the devices in these suites announced themselves. */
export const START = new Date('2026-01-01T00:00:00Z');
/** Past the device-list TTL, so a plan asks the server instead of reading the cache. */
export const LATER = new Date(START.getTime() + 2 * 60 * 60 * 1000);

/** What `xml()` builds — the elements the fake PEP service stores and hands back. */
type Node = ReturnType<typeof xml>;

export interface FakeNetwork {
  /** The PEP port of one account: it reads every JID's nodes and writes only its own. */
  port(selfJid: string): PepPort;
  /** Make a JID's nodes — or one of them — answer with a server error instead of an item. */
  fail(jid: string, node?: string): void;
}

/**
 * Enough for both suites because OMEMO uses PEP for exactly two things, and both are "last item
 * of a node". A failure is an `XmppQueryError`, which is what the real `pepGet` throws for a
 * condition that is not `item-not-found` — the distinction the send policy rests on.
 */
export function fakeNetwork(): FakeNetwork {
  const items = new Map<string, Node>();
  const failing = new Set<string>();
  const key = (jid: string, node: string) => `${jid}\u0000${node}`;
  return {
    port: (selfJid) => ({
      pepGet: async (jid, payload) => {
        const node = payload.getChild('items')?.attrs.node ?? '';
        if (failing.has(jid) || failing.has(key(jid, node))) {
          throw new XmppQueryError('internal-server-error');
        }
        const item = items.get(key(jid, node));
        if (item === undefined) return undefined;
        return xml('pubsub', { xmlns: NS.pubsub }, xml('items', { node }, item));
      },
      pepSet: async (payload) => {
        const publish = payload.getChild('publish');
        const node = publish?.attrs.node;
        const item = publish?.getChild('item');
        if (node === undefined || item === undefined) throw new Error('fake pep: not a publish');
        // The parsers take the structural `XmlElement`; putting one back into `xml()` needs the
        // builder's own type, and an element that came out of `xml()` is one.
        items.set(key(selfJid, node), item as unknown as Node);
      },
    }),
    fail: (jid, node) => {
      failing.add(node === undefined ? jid : key(jid, node));
    },
  };
}

/** One account's device on the fake network, announced like the real thing announces. */
export interface Participant<S extends OmemoStorage = OmemoStorage> {
  readonly jid: string;
  readonly storage: S;
  readonly pep: PepPort;
  readonly device: OwnDevice;
}

/** Announce a device for `jid` and hand back everything a case needs to send as it. */
export async function join(net: FakeNetwork, jid: string): Promise<Participant<MemoryOmemoStorage>> {
  return joinWith(net, jid, new MemoryOmemoStorage());
}

/**
 * The same, on a storage the case brings: one that watches what the send path writes, or the
 * `SecretStore`-backed one, which is the only storage that also journals plaintext.
 */
export async function joinWith<S extends OmemoStorage>(
  net: FakeNetwork,
  jid: string,
  storage: S,
): Promise<Participant<S>> {
  const pep = net.port(jid);
  const { device } = await announceDevice(pep, storage, jid, { now: () => START });
  return { jid, storage, pep, device };
}
