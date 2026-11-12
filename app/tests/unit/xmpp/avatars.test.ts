import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import iqCaller from '@xmpp/iq/caller.js';
import xml, { type Element } from '@xmpp/xml';
import parse from '@xmpp/xml/lib/parse.js';

import type { AccountPrompter, BackendContext, ByteSink } from '@curlew/protocol';
import { accountIdFor, parseVcardPhoto, XMPP_MANIFEST, XmppBackend, XmppConnection } from '@curlew/xmpp';

import { ANNA, fakeFactory, fakeServer, ME } from './fake-api.ts';

// Synthetic only: made-up bytes, a fake server, a temporary directory per case.
const PICTURE = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const BASE64 = btoa(String.fromCharCode(...PICTURE));
const OPTIONS = { maxBytes: 1000 };

const vcard = (inner: string) => parse(`<vCard xmlns='vcard-temp'>${inner}</vCard>`);
const photo = (type: string, binval: string) =>
  `<PHOTO><TYPE>${type}</TYPE><BINVAL>${binval}</BINVAL></PHOTO>`;

class MemorySink implements ByteSink {
  readonly chunks: Uint8Array[] = [];
  write(chunk: Uint8Array): void {
    this.chunks.push(chunk);
  }
  close(): void {}
}

const prompter = (answers: string[]): AccountPrompter => {
  const queue = [...answers];
  return { ask: async () => queue.shift() ?? '', notify: () => {} };
};

const context = (dir: string): BackendContext => ({
  settings: {},
  env: {},
  secretsDir: join(dir, 'secrets', 'xmpp'),
});

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

const connection = (answer: (request: Element) => Element) =>
  new XmppConnection(ME, { on: () => {} } as never, callerAnswering(answer) as never);

export default async () => {
  await describe('XMPP avatars', async () => {
    await it('claims avatars in its manifest', async () => {
      expect(XMPP_MANIFEST.capabilities.avatars).toBe(true);
    });

    await it('reads the picture and its type from a vCard', async () => {
      const got = parseVcardPhoto(vcard(photo('image/png', BASE64)));
      expect(got?.mimeType).toBe('image/png');
      expect(got?.bytes).toStrictEqual(PICTURE);
    });

    await it('copes with wrapped lines and a missing padding', async () => {
      const wrapped = `${BASE64.slice(0, 4)}\n   ${BASE64.slice(4).replace(/=+$/, '')}\n`;
      expect(parseVcardPhoto(vcard(photo('image/png', wrapped)))?.bytes).toStrictEqual(PICTURE);
    });

    await it('has no picture in a vCard without one, or with garbage', async () => {
      expect(parseVcardPhoto(vcard('<FN>Anna</FN>'))).toBe(null);
      expect(parseVcardPhoto(vcard(photo('image/png', '')))).toBe(null);
      expect(parseVcardPhoto(vcard(photo('image/png', '***')))).toBe(null);
      expect(parseVcardPhoto(undefined)).toBe(null);
    });

    await it('asks the contact for the vCard and returns the picture', async () => {
      const asked: Array<string | undefined> = [];
      const link = connection((request) => {
        asked.push(request.attrs.to);
        return xml(
          'iq',
          { type: 'result' },
          parse(`<vCard xmlns='vcard-temp'>${photo('image/jpeg', BASE64)}</vCard>`),
        );
      });
      const got = await link.avatar(ANNA);
      expect(asked).toStrictEqual([ANNA]);
      expect(got?.mimeType).toBe('image/jpeg');
      expect(got?.bytes.byteLength).toBe(PICTURE.byteLength);
    });

    await it('treats "no vCard" and "not allowed" as no picture, other errors as failures', async () => {
      const errorReply = (condition: string) =>
        xml(
          'iq',
          { type: 'error' },
          xml('error', { type: 'cancel' }, xml(condition, { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' })),
        );
      expect(await connection(() => errorReply('item-not-found')).avatar(ANNA)).toBe(null);
      expect(await connection(() => errorReply('forbidden')).avatar(ANNA)).toBe(null);
      let message: string | null = null;
      try {
        await connection(() => errorReply('internal-server-error')).avatar(ANNA);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toContain('internal-server-error');
    });

    await it('streams the picture of a contact and null for one without, on one connection', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-xmpp-avatar-'));
      try {
        await new XmppBackend(context(dir), fakeFactory(fakeServer())).addAccount(
          prompter([ME, 'correct horse', '']),
        );
        const server = fakeServer({ avatars: new Map([[ANNA, { bytes: PICTURE, mimeType: 'image/png' }]]) });
        const factory = fakeFactory(server);
        const source = await new XmppBackend(context(dir), factory).openAvatars(accountIdFor(ME));
        const sink = new MemorySink();
        const got = await source.fetchAvatar(ANNA, sink, OPTIONS);
        expect(got?.size).toBe(PICTURE.byteLength);
        expect(got?.mimeType).toBe('image/png');
        expect(await source.fetchAvatar('bob@example.org', new MemorySink(), OPTIONS)).toBe(null);
        expect(await source.fetchAvatar('not-an-address', new MemorySink(), OPTIONS)).toBe(null);
        expect(factory.logins).toBe(1);
        await source.close();
        expect(server.closed).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('refuses a picture over the limit', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-xmpp-avatar-'));
      try {
        await new XmppBackend(context(dir), fakeFactory(fakeServer())).addAccount(
          prompter([ME, 'correct horse', '']),
        );
        const server = fakeServer({ avatars: new Map([[ANNA, { bytes: PICTURE, mimeType: 'image/png' }]]) });
        const source = await new XmppBackend(context(dir), fakeFactory(server)).openAvatars(accountIdFor(ME));
        let message: string | null = null;
        try {
          await source.fetchAvatar(ANNA, new MemorySink(), { maxBytes: 2 });
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        expect(message).toContain('larger than the limit');
        await source.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
