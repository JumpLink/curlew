import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import parse from '@xmpp/xml/lib/parse.js';

import { aesGcmDecrypt } from '@curlew/omemo';
import type { SendPermit } from '@curlew/protocol';
import {
  type EncryptedStanza,
  GrantedXmppSession,
  type GrantedOmemo,
  parseAttachmentLink,
  parseDiscoItems,
  parseUploadService,
  parseUploadSlot,
  type SlotRequest,
  type UploadBody,
  type UploadSlot,
  uploadSlotRequest,
  XMPP_MAX_FILES,
  XmppSender,
  type XmppLink,
} from '@curlew/xmpp';

// Synthetic only: a fake upload service, a fake OMEMO, users on example.org, a temp directory.

const ACCOUNT = 'xmpp-me-example-org';
const PEER = 'anna@example.org';
const PERMIT: SendPermit = { account: ACCOUNT, addresses: [PEER] };
const PLAIN = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

const SLOT_XML = `<slot xmlns='urn:xmpp:http:upload:0'>
  <put url='https://upload.example.org/put/abc/pic.png'>
    <header name='Authorization'>Basic c2VjcmV0</header>
    <header name='Cookie'>a=b</header>
    <header name='X-Evil'>1</header>
    <header name='Expires'>Fri, 01 Jan 2027 00:00:00 GMT</header>
  </put>
  <get url='https://upload.example.org/get/abc/pic.png'/>
</slot>`;

interface Log {
  sent: Array<{ to: string; id: string; body: string; oob?: string }>;
  encrypted: Array<{ to: string; fallback?: string }>;
  slots: SlotRequest[];
  puts: Array<{ slot: UploadSlot; file: UploadBody }>;
}

function fakeLink(log: Log): XmppLink {
  return {
    jid: 'me@example.org',
    roster: async () => [],
    bookmarks: async () => [],
    features: async () => new Set(),
    mam: async () => ({ entries: [], complete: true }),
    close: async () => {},
    sendChat: async (to, id, body, oob) => {
      log.sent.push({ to, id, body, ...(oob === undefined ? {} : { oob }) });
    },
    sendReaction: async () => {},
    sendCorrection: async () => {},
    sendRetraction: async () => {},
    sendEncrypted: async (to, _id, _stanza, fallback) => {
      log.encrypted.push({ to, ...(fallback === undefined ? {} : { fallback }) });
    },
    uploadSlot: async (request) => {
      log.slots.push(request);
      const slot = parseUploadSlot(parse(SLOT_XML));
      return { ...slot!, getUrl: `https://upload.example.org/get/${log.slots.length}/${request.filename}` };
    },
    putFile: async (slot, file) => {
      log.puts.push({ slot, file });
    },
    goAvailable: async () => {},
    pepGet: async () => undefined,
    pepSet: async () => {},
    onArrival: () => () => {},
    onClosed: () => {},
  };
}

const newLog = (): Log => ({ sent: [], encrypted: [], slots: [], puts: [] });

/** An OMEMO that records what it was asked to encrypt; `null` from `encrypt` models a peer who lost it. */
function fakeOmemo(
  texts: Array<string | null>,
  options: { encrypts?: boolean; refuse?: boolean; encryptNull?: boolean } = {},
): GrantedOmemo {
  return {
    decrypt: async () => [],
    encrypts: async () => {
      if (options.refuse) throw new Error('nothing was sent: omemo refused');
      return options.encrypts ?? true;
    },
    encrypt: async (_to, text) => {
      texts.push(text);
      return options.encryptNull
        ? null
        : ({ senderDeviceId: 1, keys: [], iv: new Uint8Array(12) } as EncryptedStanza);
    },
    close: () => {},
  } as GrantedOmemo;
}

async function failure(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export default async () => {
  await describe('XMPP HTTP File Upload — stanzas', async () => {
    await it('reads the upload service from disco#info, with its size limit', async () => {
      const info = parse(`<query xmlns='http://jabber.org/protocol/disco#info'>
        <feature var='urn:xmpp:http:upload:0'/>
        <x xmlns='jabber:x:data' type='result'>
          <field var='FORM_TYPE' type='hidden'><value>urn:xmpp:http:upload:0</value></field>
          <field var='max-file-size'><value>5242880</value></field>
        </x></query>`);
      expect(parseUploadService(info)?.maxBytes).toBe(5242880);
      const noForm = parse(
        `<query xmlns='http://jabber.org/protocol/disco#info'><feature var='urn:xmpp:http:upload:0'/></query>`,
      );
      expect(parseUploadService(noForm)?.maxBytes).toBe(null);
      const other = parse(
        `<query xmlns='http://jabber.org/protocol/disco#info'><feature var='urn:xmpp:mam:2'/></query>`,
      );
      expect(parseUploadService(other)).toBe(null);
      expect(parseUploadService(undefined)).toBe(null);
    });

    await it('lists the items of a domain', async () => {
      const items = parse(`<query xmlns='http://jabber.org/protocol/disco#items'>
        <item jid='upload.example.org'/><item jid='muc.example.org' name='Rooms'/><item/></query>`);
      expect(parseDiscoItems(items).join()).toBe('upload.example.org,muc.example.org');
    });

    await it('builds the slot request with name, size and type', async () => {
      const request = uploadSlotRequest({ filename: 'pic.png', size: 10, contentType: 'image/png' });
      expect(request.attrs.xmlns).toBe('urn:xmpp:http:upload:0');
      expect(request.attrs.filename).toBe('pic.png');
      expect(request.attrs.size).toBe('10');
      expect(request.attrs['content-type']).toBe('image/png');
    });

    await it('keeps only the three headers the XEP allows', async () => {
      const slot = parseUploadSlot(parse(SLOT_XML));
      expect(slot?.putUrl).toBe('https://upload.example.org/put/abc/pic.png');
      expect(slot?.getUrl).toBe('https://upload.example.org/get/abc/pic.png');
      expect(
        Object.keys(slot?.headers ?? {})
          .sort()
          .join(),
      ).toBe('Authorization,Cookie,Expires');
      expect(slot?.headers.Authorization).toBe('Basic c2VjcmV0');
    });

    await it('refuses a slot that is not https, carries credentials or points at a LAN host', async () => {
      const slotOf = (put: string, get = 'https://upload.example.org/g') =>
        parse(`<slot xmlns='urn:xmpp:http:upload:0'><put url='${put}'/><get url='${get}'/></slot>`);
      expect(parseUploadSlot(slotOf('http://upload.example.org/p'))).toBe(null);
      expect(parseUploadSlot(slotOf('https://user:pw@upload.example.org/p'))).toBe(null);
      expect(parseUploadSlot(slotOf('https://192.168.1.5/p'))).toBe(null);
      expect(parseUploadSlot(slotOf('https://upload.example.org/p', 'http://upload.example.org/g'))).toBe(
        null,
      );
      expect(parseUploadSlot(slotOf('https://upload.example.org/p'))?.getUrl).toBe(
        'https://upload.example.org/g',
      );
      expect(parseUploadSlot(undefined)).toBe(null);
    });

    await it('drops a fragment from the get URL, which would end up in front of an aesgcm key', async () => {
      const slot = parseUploadSlot(
        parse(
          `<slot xmlns='urn:xmpp:http:upload:0'><put url='https://u.example.org/p'/><get url='https://u.example.org/g#frag'/></slot>`,
        ),
      );
      expect(slot?.getUrl).toBe('https://u.example.org/g');
    });

    await it('refuses a header value with a line break', async () => {
      const slot = parse(
        `<slot xmlns='urn:xmpp:http:upload:0'><put url='https://u.example.org/p'><header name='Cookie'>a=b&#13;&#10;X: 1</header></put><get url='https://u.example.org/g'/></slot>`,
      );
      expect(parseUploadSlot(slot)).toBe(null);
    });
  });

  await describe('XMPP send a file', async () => {
    await it('uploads to the slot and sends the link as body and out-of-band reference', async () => {
      const log = newLog();
      const session = new GrantedXmppSession(fakeLink(log), PERMIT, () => 'id-1');
      const sent = await session.sendFile(PEER, {
        bytes: PLAIN,
        filename: 'pic.png',
        contentType: 'image/png',
      });
      expect(log.slots[0].filename).toBe('pic.png');
      expect(log.slots[0].size).toBe(10);
      expect(log.slots[0].contentType).toBe('image/png');
      expect(log.puts.length).toBe(1);
      expect(log.puts[0].file.bytes).toStrictEqual(PLAIN);
      expect(log.sent.length).toBe(1);
      expect(log.sent[0].body).toBe('https://upload.example.org/get/1/pic.png');
      expect(log.sent[0].oob).toBe(log.sent[0].body);
      expect(sent.encrypted).toBe(false);
    });

    await it('sends nothing, and uploads nothing, to an address the grant does not name', async () => {
      const log = newLog();
      const session = new GrantedXmppSession(fakeLink(log), PERMIT);
      const reason = await failure(
        session.sendFile('eve@example.org', { bytes: PLAIN, filename: 'a.txt', contentType: 'text/plain' }),
      );
      expect(reason !== null).toBe(true);
      expect(log.slots.length).toBe(0);
      expect(log.puts.length).toBe(0);
    });

    await it('encrypts for a peer with OMEMO: opaque upload, key only inside the payload', async () => {
      const log = newLog();
      const texts: Array<string | null> = [];
      const session = new GrantedXmppSession(fakeLink(log), PERMIT, () => 'id-1', fakeOmemo(texts));
      const sent = await session.sendFile(PEER, {
        bytes: PLAIN,
        filename: 'Secret Plan.PDF',
        contentType: 'application/pdf',
      });
      expect(sent.encrypted).toBe(true);
      // Nothing in the clear: no chat message, no out-of-band link.
      expect(log.sent.length).toBe(0);
      expect(log.encrypted.length).toBe(1);
      // The server hears a random name with the extension, a generic type, and the ciphertext size.
      expect(log.slots[0].filename.includes('Secret')).toBe(false);
      expect(log.slots[0].filename.endsWith('.pdf')).toBe(true);
      expect(log.slots[0].contentType).toBe('application/octet-stream');
      expect(log.slots[0].size).toBe(PLAIN.length + 16);
      expect(log.puts[0].file.bytes.length).toBe(PLAIN.length + 16);
      // The link inside the payload is the one a receiver reads, and its key opens the upload.
      const link = parseAttachmentLink(texts[0] ?? '');
      expect(link?.aesgcm !== null && link?.aesgcm !== undefined).toBe(true);
      expect(link?.fetchUrl.startsWith('https://upload.example.org/get/1/')).toBe(true);
      const opened = await aesGcmDecrypt(link!.aesgcm!.key, link!.aesgcm!.iv, log.puts[0].file.bytes);
      expect(opened).toStrictEqual(PLAIN);
    });

    await it('refuses before uploading when OMEMO refuses the peer', async () => {
      const log = newLog();
      const session = new GrantedXmppSession(
        fakeLink(log),
        PERMIT,
        undefined,
        fakeOmemo([], { refuse: true }),
      );
      const reason = await failure(
        session.sendFile(PEER, { bytes: PLAIN, filename: 'a.txt', contentType: 'text/plain' }),
      );
      expect(reason?.includes('omemo refused')).toBe(true);
      expect(log.slots.length).toBe(0);
      expect(log.sent.length + log.encrypted.length).toBe(0);
    });

    await it('sends a plain link to a peer whose OMEMO says there is none', async () => {
      const log = newLog();
      const session = new GrantedXmppSession(
        fakeLink(log),
        PERMIT,
        undefined,
        fakeOmemo([], { encrypts: false }),
      );
      const sent = await session.sendFile(PEER, {
        bytes: PLAIN,
        filename: 'a.txt',
        contentType: 'text/plain',
      });
      expect(sent.encrypted).toBe(false);
      expect(log.sent.length).toBe(1);
      expect(log.encrypted.length).toBe(0);
    });

    await it('sends no link at all when the encryption vanishes after the upload', async () => {
      const log = newLog();
      const session = new GrantedXmppSession(
        fakeLink(log),
        PERMIT,
        undefined,
        fakeOmemo([], { encryptNull: true }),
      );
      const reason = await failure(
        session.sendFile(PEER, { bytes: PLAIN, filename: 'a.txt', contentType: 'text/plain' }),
      );
      expect(reason?.includes('stopped offering encryption')).toBe(true);
      expect(log.sent.length + log.encrypted.length).toBe(0);
    });
  });

  await describe('XMPP sender with files', async () => {
    function withDir(body: (dir: string) => Promise<void>): Promise<void> {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-xmpp-files-'));
      return body(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
    }

    await it('sends the files first, one message each, then the text', async () => {
      await withDir(async (dir) => {
        const a = join(dir, 'a.png');
        const b = join(dir, 'b.txt');
        writeFileSync(a, 'png');
        writeFileSync(b, 'txt');
        const log = newLog();
        let n = 0;
        const sender = new XmppSender(new GrantedXmppSession(fakeLink(log), PERMIT, () => `id-${++n}`));
        expect(sender.features.attachments).toBe(true);
        const sent = await sender.send({
          to: PEER,
          text: 'Zwei Dateien',
          attachments: [{ path: a }, { path: b }],
        });
        expect(log.puts.length).toBe(2);
        expect(log.sent.map((m) => m.body).join('|')).toBe(
          'https://upload.example.org/get/1/a.png|https://upload.example.org/get/2/b.txt|Zwei Dateien',
        );
        expect(sent.id).toBe('id-1');
        expect(sent.attachments?.map((f) => f.filename).join()).toBe('a.png,b.txt');
      });
    });

    await it('sends no text message after a file-only send', async () => {
      await withDir(async (dir) => {
        const a = join(dir, 'a.png');
        writeFileSync(a, 'png');
        const log = newLog();
        const sender = new XmppSender(new GrantedXmppSession(fakeLink(log), PERMIT));
        await sender.send({ to: PEER, text: '  ', attachments: [{ path: a }] });
        expect(log.sent.length).toBe(1);
      });
    });

    await it('refuses too many files and a missing file before anything is uploaded', async () => {
      await withDir(async (dir) => {
        const a = join(dir, 'a.txt');
        writeFileSync(a, 'x');
        const log = newLog();
        const sender = new XmppSender(new GrantedXmppSession(fakeLink(log), PERMIT));
        const many = Array.from({ length: XMPP_MAX_FILES + 1 }, () => ({ path: a }));
        expect((await failure(sender.send({ to: PEER, text: '', attachments: many }))) !== null).toBe(true);
        expect(
          (await failure(sender.send({ to: PEER, text: '', attachments: [{ path: join(dir, 'nope') }] }))) !==
            null,
        ).toBe(true);
        expect(log.slots.length).toBe(0);
      });
    });
  });
};
