import { describe, expect, it } from '@gjsify/unit';

import type { BackendMessage } from '@curlew/protocol';
import { loadAttachments, syncIndex } from '@curlew/store';
import { AT, FakeBackend, freshDb, message } from './fixtures.ts';

// Delta Chat voice notes in the mail index: typed when the thread is an email chat, never otherwise.

const OGG = { section: '2', filename: 'voice.ogg', mimeType: 'audio/ogg', size: 5000 };

async function kindOf(extra: Partial<BackendMessage>) {
  const db = freshDb();
  const backend = new FakeBackend();
  backend.put('INBOX', [message(1, 'Voice', '', { hasAttachment: true, attachments: [OGG], ...extra })]);
  try {
    await syncIndex(db, backend, { now: AT('2026-08-06T12:00:00Z') });
    const [info] = loadAttachments(db, { backend: 'mail', accountId: 'acct', folder: 'INBOX', uid: 1 });
    return info;
  } finally {
    db.close();
  }
}

export default async () => {
  await describe('mail voice notes', async () => {
    await it('types the audio part of an email chat as a voice note with its duration', async () => {
      const info = await kindOf({ emailChat: true, chatContent: 'voice', durationMs: 4200 });
      expect(info?.kind).toBe('voice');
      expect(info?.durationMs).toBe(4200);
    });

    await it('accepts a voice note without a duration', async () => {
      const info = await kindOf({ emailChat: true, chatContent: 'voice' });
      expect(info?.kind).toBe('voice');
      expect(info?.durationMs).toBe(null);
    });

    await it('keeps audio of plain mail a plain audio file', async () => {
      const info = await kindOf({ emailChat: false, chatContent: 'voice', durationMs: 4200 });
      expect(info?.kind).toBe('audio');
      expect(info?.durationMs).toBe(null);
    });

    await it('shows a sticker as the image it is', async () => {
      const png = { section: '2', filename: 's.png', mimeType: 'image/png', size: 900 };
      const info = await kindOf({ emailChat: true, chatContent: 'sticker', attachments: [png] });
      expect(info?.kind).toBe('image');
    });
  });
};
