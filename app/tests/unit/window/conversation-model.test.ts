import { describe, expect, it } from '@gjsify/unit';
import type { ConversationMessage } from '@curlew/protocol';

import {
  attachmentLines,
  bubbleText,
  chatSubject,
  composeMailReply,
  cursorOf,
  dayStarts,
  defaultProtocolChoice,
  foldAlbums,
  newOlder,
  quoteOf,
  protocolDividers,
  protocolRunStarts,
  replySubject,
  senderName,
  senderRunStarts,
  subjectLabels,
  type ShownMessage,
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
    ref: { accountId: 'a', backend: 'mail' },
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
      expect(composeMailReply(message({ id: 'a', emailChat: true }), null, 'Hallo').subject).toBe(
        'Chat: Hallo',
      );
      expect(composeMailReply(message({ id: 'a', subject: 'Frage' }), null, 'Hallo').subject).toBe(
        'Re: Frage',
      );
    });

    await it('threads onto the parent Message-ID without duplicating References', async () => {
      const reply = composeMailReply(
        message({ id: 'a', emailChat: true }),
        {
          messageId: '<child@example.org>',
          references: ['<root@example.org>', '<child@example.org>'],
        },
        'Hallo',
      );
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
      expect([...labels.entries()]).toStrictEqual([
        ['a', 'First'],
        ['d', 'Second'],
      ]);
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
        message({
          id,
          senderId: sender,
          senderName: sender,
          backend: 'signal',
          presentation: 'bubble',
          ...over,
        });
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

    await it('badges the first bubble of each protocol run and adds a divider on switches', async () => {
      const m = (id: string, backend: string, accountId = 'a') =>
        message({ id, backend, presentation: 'bubble', ref: { accountId, backend } });
      const runs = protocolRunStarts([m('a', 'signal'), m('b', 'signal'), m('c', 'mail'), m('d', 'signal')]);
      expect([...runs.entries()]).toStrictEqual([
        ['a', { backend: 'signal' }],
        ['c', { backend: 'mail' }],
        ['d', { backend: 'signal' }],
      ]);
      const dividers = protocolDividers([
        m('a', 'signal'),
        m('b', 'signal'),
        m('c', 'mail'),
        m('d', 'signal'),
      ]);
      expect([...dividers.entries()]).toStrictEqual([
        ['c', 'Continuing via Mail'],
        ['d', 'Continuing via Signal'],
      ]);
    });

    await it('defaults the picker to the last message carrier, falling back to the first choice', async () => {
      const choices = [
        { backend: 'signal', accountId: 'signal-1', target: 'aci-1', label: 'Signal', icon: '' },
        { backend: 'xmpp', accountId: 'xmpp-1', target: 'x', label: 'XMPP', icon: '' },
      ];
      expect(defaultProtocolChoice([], choices)).toBe(choices[0]);
      const m = (id: string, backend: string, accountId = 'a') =>
        message({ id, backend, presentation: 'bubble', ref: { accountId, backend } });
      expect(defaultProtocolChoice([m('a', 'xmpp', 'xmpp-1')], choices)).toBe(choices[1]);
      expect(defaultProtocolChoice([m('a', 'xmpp', 'xmpp-2')], choices)).toBe(choices[1]);
      expect(defaultProtocolChoice([m('a', 'signal', 'signal-1')], choices)).toBe(choices[0]);
      expect(defaultProtocolChoice([m('a', 'mail')], choices)).toBe(choices[0]);
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
        message({
          id: 'a',
          presentation: 'bubble',
          senderId: 'p',
          senderAddress: { kind: 'jid', value: 'anna@example.org' },
        }),
      ];
      expect([...senderRunStarts(shown, true)]).toStrictEqual([['a', 'anna@example.org']]);
      expect(senderName(message({ id: 'x', senderName: '  ' }))).toBe('Unknown sender');
    });

    await it('says what an attachment-only message carries, else just Attachment', async () => {
      expect(attachmentLines(undefined)).toStrictEqual(['Attachment']);
      expect(attachmentLines([])).toStrictEqual(['Attachment']);
      expect(attachmentLines([{ filename: null, mimeType: null }])).toStrictEqual(['Attachment']);
      expect(attachmentLines([{ filename: 'report.pdf', mimeType: 'application/pdf' }])).toStrictEqual([
        'File: report.pdf',
      ]);
      expect(attachmentLines([{ filename: 'cat.jpg', mimeType: 'image/jpeg' }])).toStrictEqual([
        'Image: cat.jpg',
      ]);
      expect(attachmentLines([{ filename: null, mimeType: 'video/mp4' }])).toStrictEqual(['Video']);
      expect(attachmentLines([{ filename: null, mimeType: 'audio/ogg' }])).toStrictEqual(['Audio']);
      const many = Array.from({ length: 5 }, (_unused, i) => ({
        filename: `f${i}.txt`,
        mimeType: 'text/plain',
      }));
      expect(attachmentLines(many).slice(2)).toStrictEqual(['File: f2.txt', 'and 2 more attachments']);
    });

    await describe('foldAlbums', async () => {
      const part = (id: string, over: Partial<ShownMessage> = {}): ShownMessage =>
        message({
          id,
          backend: 'telegram',
          presentation: 'bubble',
          senderId: 'anna',
          sentAt: `2026-08-01T10:00:0${id.length}Z`,
          hasAttachments: true,
          groupId: 'album-1',
          ref: { accountId: 'a', backend: 'telegram', remoteId: `1/${id}` },
          attachments: [{ filename: `${id}.jpg`, mimeType: 'image/jpeg', index: 0 }],
          ...over,
        }) as ShownMessage;

      await it('folds consecutive messages of one sender and album into the first', async () => {
        const folded = foldAlbums([part('m1'), part('m2'), part('m3')]);
        expect(folded.length).toBe(1);
        expect(folded[0].id).toBe('m1');
        expect(folded[0].sentAt).toBe('2026-08-01T10:00:02Z');
        expect(folded[0].attachments!.map((a) => a.filename)).toStrictEqual(['m1.jpg', 'm2.jpg', 'm3.jpg']);
      });

      await it('tags every part with the message it came from', async () => {
        const [album] = foldAlbums([part('m1'), part('m2')]);
        expect(album.attachments!.map((a) => a.ref?.remoteId)).toStrictEqual(['1/m1', '1/m2']);
      });

      await it('takes the caption from the part that has one', async () => {
        const [album] = foldAlbums([part('m1'), part('m2', { bodyText: 'Urlaub' }), part('m3')]);
        expect(album.bodyText).toBe('Urlaub');
      });

      await it('is seen only when every part is, and reads the receipt off the last', async () => {
        const [album] = foldAlbums([part('m1'), part('m2', { seen: false, readByPeer: true })]);
        expect(album.seen).toBe(false);
        expect(album.readByPeer).toBe(true);
      });

      await it('does not fold another sender, another album or a message in between', async () => {
        expect(foldAlbums([part('m1'), part('m2', { senderId: 'ben' })]).length).toBe(2);
        expect(foldAlbums([part('m1'), part('m2', { groupId: 'album-2' })]).length).toBe(2);
        expect(foldAlbums([part('m1'), part('m2', { groupId: null }), part('m3')]).length).toBe(3);
        expect(foldAlbums([part('m1'), part('m2', { conversationId: 'other' })]).length).toBe(2);
      });

      await it('leaves messages without an album untouched', async () => {
        const plain = [
          part('m1', { groupId: null }),
          part('m2', { groupId: '' }),
          part('m3', { groupId: undefined }),
        ];
        const folded = foldAlbums(plain);
        expect(folded.length).toBe(3);
        expect(folded[0]).toBe(plain[0]);
      });
    });
  });

  await describe('quoteOf', async () => {
    const chat = (over: Partial<ShownMessage> & { id: string }): ShownMessage =>
      message({ backend: 'matrix', ...over, ref: { accountId: 'a', backend: 'matrix', remoteId: over.id } });

    await it('names the author and the first line of the quoted text', async () => {
      const first = chat({ id: 'r1', senderName: 'Alex', bodyText: '\n  Treffen wir uns?\nUm acht.' });
      const reply = chat({ id: 'r2', replyToRemoteId: 'r1', bodyText: 'Gern' });
      expect(quoteOf(reply, [first, reply])).toStrictEqual({ author: 'Alex', excerpt: 'Treffen wir uns?' });
    });

    await it('calls the person\'s own message "You" and clips a long excerpt', async () => {
      const first = chat({ id: 'r1', fromSelf: true, bodyText: 'x'.repeat(300) });
      const reply = chat({ id: 'r2', replyToRemoteId: 'r1' });
      const quote = quoteOf(reply, [first, reply]);
      expect(quote?.author).toBe('You');
      expect(quote?.excerpt.length).toBe(140);
      expect(quote?.excerpt.endsWith('…')).toBe(true);
    });

    await it('falls back to the attachment line and to nothing', async () => {
      const first = chat({
        id: 'r1',
        senderName: 'Alex',
        hasAttachments: true,
        attachments: [{ filename: 'plan.pdf' } as never],
      });
      const reply = chat({ id: 'r2', replyToRemoteId: 'r1' });
      expect(quoteOf(reply, [first, reply])?.excerpt).toContain('plan.pdf');
      expect(quoteOf(reply, [reply])).toBe(null);
      expect(quoteOf(chat({ id: 'r3' }), [first])).toBe(null);
    });
  });
};
