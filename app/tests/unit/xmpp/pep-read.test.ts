/**
 * `pepRead` through the real `@xmpp/iq` caller, against a server stub that answers like Prosody.
 *
 * Every other OMEMO suite fakes `PepPort`, one level above this function, so none of them could
 * see that `iq.get` already returns the `<pubsub>` child. The lab run against Gajim did: every
 * device list read as empty and curlew sent in the clear.
 */

import { describe, expect, it } from '@gjsify/unit';
import iqCaller from '@xmpp/iq/caller.js';
import xml, { type Element } from '@xmpp/xml';

import { deviceListQuery, NS, parseDeviceList, pepRead } from '@curlew/xmpp';

type Route = (ctx: { type: string; name: string; id: string; stanza: Element }, next: () => void) => void;

/** A caller wired to a "server" that turns each request into the reply `answer` builds. */
function callerAnswering(answer: (request: Element) => Element) {
  let route: Route | undefined;
  const middleware = { use: (fn: Route) => void (route = fn) };
  const entity = {
    send: async (request: Element) => {
      const reply = answer(request);
      reply.attrs.id = request.attrs.id;
      route?.(
        { type: String(reply.attrs.type), name: 'iq', id: String(reply.attrs.id), stanza: reply },
        () => {},
      );
    },
  };
  return iqCaller({ middleware, entity } as unknown as Parameters<typeof iqCaller>[0]);
}

const deviceListResult = (...ids: number[]) =>
  xml(
    'iq',
    { type: 'result', from: 'bob@example.org' },
    xml(
      'pubsub',
      { xmlns: NS.pubsub },
      xml(
        'items',
        { node: 'eu.siacs.conversations.axolotl.devicelist' },
        xml(
          'item',
          { id: 'current' },
          xml(
            'list',
            { xmlns: 'eu.siacs.conversations.axolotl' },
            ...ids.map((id) => xml('device', { id: String(id) })),
          ),
        ),
      ),
    ),
  );

const errorResult = (condition: string) =>
  xml(
    'iq',
    { type: 'error' },
    xml('error', { type: 'cancel' }, xml(condition, { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' })),
  );

export default async function pepReadSuite(): Promise<void> {
  await describe('pepRead', async () => {
    await it("returns the result's <pubsub>, so a peer's device list is read", async () => {
      const iq = callerAnswering(() => deviceListResult(376271920, 7));
      const pubsub = await pepRead(iq, 'bob@example.org', deviceListQuery());
      expect(parseDeviceList(pubsub)).toEqualArray([7, 376271920]);
    });

    await it('answers item-not-found and not-allowed with undefined', async () => {
      for (const condition of ['item-not-found', 'not-allowed']) {
        const iq = callerAnswering(() => errorResult(condition));
        expect(await pepRead(iq, 'bob@example.org', deviceListQuery())).toBeUndefined();
      }
    });

    await it('throws any other error, so the send path refuses instead of guessing', async () => {
      const iq = callerAnswering(() => errorResult('remote-server-not-found'));
      let thrown: unknown;
      try {
        await pepRead(iq, 'bob@example.org', deviceListQuery());
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
    });
  });
}
