import { describe, expect, it } from '@gjsify/unit';
import type { ConversationMessage } from '@curlew/protocol';

import {
  attachmentLines,
  bubbleText,
  chatSubject,
  composeMailReply,
  cursorOf,
  dayStarts,
  newOlder,
  replySubject,
  senderName,
  senderRunStarts,
  subjectLabels,
} from '../../../src/window/conversation-model.ts';

function message(over: Partial<ConversationMessage> & { id: string }): ConversationMessage {
  return {
    conversationId: 'c',
    backend: 'mail',
    presentation: 'document',
    senderId: null,
    senderName: null,
    senderAddress: null,
    fromSelf: false,
    sentAt: null,
    subject: null,
    seen: true,
    hasAttachments: false,
    emailChat: false,
    classification: 'conversational',
    classificationReason: 'known-contact',
    ref: { accountId: 'a' },
    ...over,
  };
}

export default async () => {
  await describe('mail chat presentation', async () => {
    await it('uses a generic excerpt for chat mail and Re for ordinary replies', async () => {
      expect(chatSubject('  Hallo\n Welt  ')).toBe('Chat: Hallo Welt');
      expect(chatSubject('')).toBe('Chat');
      expect(replySubject('Frage')).toBe('Re: Frage');
      expect(replySubject('Re: Frage')).toBe('Re: Frage');
      expect(composeMailReply(message({ id: 'a', emailChat: true }), null, 'Hallo').subject).toBe('Chat: Hallo');
      expect(composeMailReply(message({ id: 'a', subject: 'Frage' }), null, 'Hallo').subject).toBe('Re: Frage');
    });

    await it('threads onto the parent Message-ID without duplicating References', async () => {
      const reply = composeMailReply(message({ id: 'a', emailChat: true }), {
        messageId: '<child@example.org>',
        references: ['<root@example.org>', '<child@example.org>'],
      }, 'Hallo');
      expect(reply.inReplyTo).toBe('<child@example.org>');
      expect(reply.references).toEqualArray(['<root@example.org>', '<child@example.org>']);
      expect(reply.emailChat).toBe(true);
    });

    await it('labels ordinary subject changes but never generic chat subjects', async () => {
      const labels = subjectLabels([
        message({ id: 'a', subject: 'First' }),
        message({ id: 'b', subject: 'Re: First' }),
        message({ id: 'c', subject: 'Chat: Hello', emailChat: true }),
        message({ id: 'd', subject: 'Second' }),
        message({ id: 'e', subject: 'Re: Second' }),
      ]);
      expect([...labels.entries()]).toStrictEqual([['a', 'First'], ['d', 'Second']]);
    });
  });

  await describe('bubbleText', async () => {
    await it('keeps a short body whole', async () => {
      expect(bubbleText('hello\nthere', 600, 12)).toStrictEqual({ text: 'hello\nthere', clipped: false });
    });
    await it('clips at the character limit', async () => {
      expect(bubbleText('x'.repeat(20), 8, 12)).toStrictEqual({ text: 'x'.repeat(8), clipped: true });
    });
    await it('clips at the line limit', async () => {
      expect(bubbleText('a\nb\nc\nd', 600, 2)).toStrictEqual({ text: 'a\nb', clipped: true });
    });
    await it('does not clip a body that ends exactly at the limit', async () => {
      expect(bubbleText('a\nb', 600, 2)).toStrictEqual({ text: 'a\nb', clipped: false });
    });
  });

  await describe('paging helpers', async () => {
    await it('takes the cursor from the oldest message, missing time included', async () => {
      expect(cursorOf(message({ id: 'a', sentAt: '2026-08-01T10:00:00Z' }))).toStrictEqual({
        sentAt: '2026-08-01T10:00:00Z',
        id: 'a',
      });
      expect(cursorOf(message({ id: 'b' }))).toStrictEqual({ sentAt: null, id: 'b' });
    });

    await it('drops what an older page repeats', async () => {
      const shown = [message({ id: 'c' }), message({ id: 'd' })];
      const page = [message({ id: 'b' }), message({ id: 'c' })];
      expect(newOlder(shown, page).map((m) => m.id)).toStrictEqual(['b']);
    });

    await it('puts a day separator above the first message of each day, also after a page was added', async () => {
      const shown = [
        message({ id: 'c', sentAt: '2026-08-02T08:00:00Z' }),
        message({ id: 'd', sentAt: '2026-08-02T09:00:00Z' }),
        message({ id: 'e', sentAt: '2026-08-03T09:00:00Z' }),
      ];
      expect([...dayStarts(shown)]).toStrictEqual(['c', 'e']);
      const merged = [message({ id: 'b', sentAt: '2026-08-02T07:00:00Z' }), ...shown];
      expect([...dayStarts(merged)]).toStrictEqual(['b', 'e']);
    });

    await it('lets a message without a time follow the day before it', async () => {
      const shown = [
        message({ id: 'a', sentAt: '2026-08-02T08:00:00Z' }),
        message({ id: 'b' }),
        message({ id: 'c', sentAt: '2026-08-02T09:00:00Z' }),
      ];
      expect([...dayStarts(shown)]).toStrictEqual(['a']);
    });

    await it('labels a subject only where the topic changes, over what is shown', async () => {
      const older = [message({ id: 'a', subject: 'Plan' }), message({ id: 'b', subject: 'Re: Plan' })];
      const shown = [message({ id: 'c', subject: 'Re: Plan' })];
      expect([...subjectLabels(shown).keys()]).toStrictEqual(['c']);
      expect([...subjectLabels([...older, ...shown]).keys()]).toStrictEqual(['a']);
    });

    await it('shows the sender above the first bubble of a run in a group', async () => {
      const from = (id: string, sender: string, over: Partial<ConversationMessage> = {}) =>
        message({ id, senderId: sender, senderName: sender, backend: 'signal', presentation: 'bubble', ...over });
      const shown = [
        from('a', 'Anna'),
        from('b', 'Anna'),
        from('c', 'Ben'),
        from('d', 'x', { fromSelf: true, senderId: null, senderName: null }),
        from('e', 'Ben'),
        from('f', 'Anna'),
      ];
      expect([...senderRunStarts(shown, true)]).toStrictEqual([
        ['a', 'Anna'],
        ['c', 'Ben'],
        ['e', 'Ben'],
        ['f', 'Anna'],
      ]);
      expect(senderRunStarts(shown, false).size).toBe(0);
    });

    await it('keeps sender runs right when an older page is prepended', async () => {
      const from = (id: string, sender: string) =>
        message({ id, senderId: sender, senderName: sender, presentation: 'bubble' });
      const newer = [from('c', 'Anna'), from('d', 'Ben')];
      expect([...senderRunStarts(newer, true).keys()]).toStrictEqual(['c', 'd']);
      // The older page ends with the same sender: 'c' joins that run and loses its label.
      const merged = [from('a', 'Ben'), from('b', 'Anna'), ...newer];
      expect([...senderRunStarts(merged, true).keys()]).toStrictEqual(['a', 'b', 'd']);
    });

    await it('skips notices and names an unlabelled sender by address', async () => {
      const shown = [
        message({ id: 'n', presentation: 'notice', senderId: 'p' }),
        message({ id: 'a', presentation: 'bubble', senderId: 'p', senderAddress: { kind: 'jid', value: 'anna@example.org' } }),
      ];
      expect([...senderRunStarts(shown, true)]).toStrictEqual([['a', 'anna@example.org']]);
      expect(senderName(message({ id: 'x', senderName: '  ' }))).toBe('Unknown sender');
    });

    await it('says what an attachment-only message carries, else just Attachment', async () => {
      expect(attachmentLines(undefined)).toStrictEqual(['Attachment']);
      expect(attachmentLines([])).toStrictEqual(['Attachment']);
      expect(attachmentLines([{ filename: null, mimeType: null }])).toStrictEqual(['Attachment']);
      expect(attachmentLines([{ filename: 'report.pdf', mimeType: 'application/pdf' }])).toStrictEqual(['File: report.pdf']);
      expect(attachmentLines([{ filename: 'cat.jpg', mimeType: 'image/jpeg' }])).toStrictEqual(['Image: cat.jpg']);
      expect(attachmentLines([{ filename: null, mimeType: 'video/mp4' }])).toStrictEqual(['Video']);
      expect(attachmentLines([{ filename: null, mimeType: 'audio/ogg' }])).toStrictEqual(['Audio']);
      const many = Array.from({ length: 5 }, (_unused, i) => ({ filename: `f${i}.txt`, mimeType: 'text/plain' }));
      expect(attachmentLines(many).slice(2)).toStrictEqual(['File: f2.txt', 'and 2 more attachments']);
    });
  });
};
