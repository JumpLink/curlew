import { describe, expect, it } from '@gjsify/unit';

import type { ByteSink } from '@curlew/protocol';
import { WHATSAPP_MANIFEST, WhatsAppAvatars } from '@curlew/whatsapp';

// Synthetic only: a fake picture view and a fake download, no socket.
const CHAT = '4915000000000@s.whatsapp.net';
const URL_OK = 'https://pps.example.org/pic.jpg';
const OPTIONS = { maxBytes: 1000 };

class MemorySink implements ByteSink {
  readonly chunks: Uint8Array[] = [];
  write(chunk: Uint8Array): void {
    this.chunks.push(chunk);
  }
  close(): void {}
}

function source(urls: Record<string, string | null>, body = new Uint8Array([1, 2, 3]), status = 200) {
  const asked: string[] = [];
  const downloads: string[] = [];
  const avatars = new WhatsAppAvatars(
    {
      profilePictureUrl: async (jid) => {
        asked.push(jid);
        return urls[jid] ?? null;
      },
    },
    (async (input: RequestInfo | URL) => {
      downloads.push(String(input));
      return new Response(body as BodyInit, { status, headers: { 'content-type': 'image/jpeg' } });
    }) as typeof globalThis.fetch,
  );
  return { avatars, asked, downloads };
}

export default async () => {
  await describe('WhatsApp avatars', async () => {
    await it('claims avatars in its manifest', async () => {
      expect(WHATSAPP_MANIFEST.capabilities.avatars).toBe(true);
    });

    await it('downloads the picture the server names', async () => {
      const { avatars, downloads } = source({ [CHAT]: URL_OK });
      const sink = new MemorySink();
      const got = await avatars.fetchAvatar(CHAT, sink, OPTIONS);
      expect(got?.size).toBe(3);
      expect(got?.mimeType).toBe('image/jpeg');
      expect(downloads).toStrictEqual([URL_OK]);
    });

    await it('has no picture for a chat the server has none for, or a failed download', async () => {
      const none = source({});
      expect(await none.avatars.fetchAvatar(CHAT, new MemorySink(), OPTIONS)).toBe(null);
      expect(none.downloads.length).toBe(0);
      expect(
        await source({ [CHAT]: URL_OK }, new Uint8Array(), 404).avatars.fetchAvatar(
          CHAT,
          new MemorySink(),
          OPTIONS,
        ),
      ).toBe(null);
      expect(await none.avatars.fetchAvatar('not-a-jid', new MemorySink(), OPTIONS)).toBe(null);
      expect(none.asked.length).toBe(1);
    });

    await it('never follows a plain-http URL, and refuses a picture over the limit', async () => {
      const plain = source({ [CHAT]: 'http://pps.example.org/pic.jpg' });
      expect(await plain.avatars.fetchAvatar(CHAT, new MemorySink(), OPTIONS)).toBe(null);
      expect(plain.downloads.length).toBe(0);
      let message: string | null = null;
      try {
        await source({ [CHAT]: URL_OK }).avatars.fetchAvatar(CHAT, new MemorySink(), { maxBytes: 2 });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toContain('larger than the limit');
    });
  });
};
