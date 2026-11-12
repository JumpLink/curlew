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
  trustRank,
  deleteHandleOf,
  editHandleOf,
  foldAlbums,
  newOlder,
  quoteOf,
  reactHandleOf,
  reactionsOfferedIn,
  changesOfferedFor,
  reactionChip,
  protocolDividers,
  protocolRunStarts,
  replyDraftOf,
  replySubject,
  senderName,
  senderRunStarts,
  subjectLabels,
  toggleOwnReaction,
  withOwnReaction,
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
      expect(composeMailReply(message({ id: 'a', emailChat: true }), null, 'Hallo', true).subject).toBe(
        'Chat: Hallo',
      );
      expect(composeMailReply(message({ id: 'a', subject: 'Frage' }), null, 'Hallo', true).subject).toBe(
        'Re: Frage',
      );
      // A first mail to this person is no reply, even though a Signal note comes before it.
      expect(composeMailReply(null, null, 'Hallo', true).subject).toBe('Chat: Hallo');
    });

    await it('threads onto the parent Message-ID without duplicating References', async () => {
      const reply = composeMailReply(
        message({ id: 'a', emailChat: true }),
        {
          messageId: '<child@example.org>',
          references: ['<root@example.org>', '<child@example.org>'],
        },
        'Hallo',
        true,
      );
      expect(reply.inReplyTo).toBe('<child@example.org>');
      expect(reply.references).toEqualArray(['<root@example.org>', '<child@example.org>']);
      expect(reply.emailChat).toBe(true);
    });

    await it('sends ordinary mail, without the chat marker, unless the account opted in', async () => {
      const off = composeMailReply(null, null, 'Hallo Welt', false);
      expect(off.emailChat).toBe(undefined);
      expect(off.subject).toBe('Hallo Welt');
      const reply = composeMailReply(message({ id: 'a', emailChat: true }), null, 'Hi', false);
      expect(reply.emailChat).toBe(undefined);
      expect(reply.subject).toBe('Re: Chat');
      expect(composeMailReply(null, null, 'Hallo', true).emailChat).toBe(true);
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
      const m = (id: string, backend: string, accountId = 'a') =>
        message({ id, backend, presentation: 'bubble', ref: { accountId, backend } });
      expect(defaultProtocolChoice([m('a', 'xmpp', 'xmpp-1')], choices)).toBe(choices[1]);
      expect(defaultProtocolChoice([m('a', 'xmpp', 'xmpp-2')], choices)).toBe(choices[1]);
      expect(defaultProtocolChoice([m('a', 'signal', 'signal-1')], choices)).toBe(choices[0]);
      expect(defaultProtocolChoice([m('a', 'mail')], choices)).toBe(choices[1]);
    });

    await it('starts a first contact on the most trusted protocol', async () => {
      const choice = (backend: string) => ({
        backend,
        accountId: `${backend}-1`,
        target: 't',
        label: backend,
        icon: '',
      });
      const ranked = ['whatsapp', 'telegram', 'signal', 'xmpp', 'matrix'].map(choice);
      expect(defaultProtocolChoice([], ranked)?.backend).toBe('xmpp');
      expect(defaultProtocolChoice([], ranked.slice(0, 3))?.backend).toBe('signal');
      expect(defaultProtocolChoice([], ranked.slice(0, 2))?.backend).toBe('telegram');
      // Equal rank keeps the list order.
      expect(defaultProtocolChoice([], [choice('matrix'), choice('xmpp')])?.backend).toBe('matrix');
      // Mail is never picked over a chat protocol, but is still picked when it is all there is.
      expect(defaultProtocolChoice([], [choice('mail'), choice('whatsapp')])?.backend).toBe('whatsapp');
      expect(defaultProtocolChoice([], [choice('mail')])?.backend).toBe('mail');
      expect(trustRank('xmpp')).toBe(trustRank('matrix'));
      expect(trustRank('mail')).toBeGreaterThan(trustRank('whatsapp'));
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

  await describe('reactionChip', async () => {
    await it('counts only when more than one person gave the emoji', async () => {
      expect(reactionChip({ emoji: '👍', count: 1, own: false })).toStrictEqual({
        text: '👍',
        tooltip: '1 person',
      });
      expect(reactionChip({ emoji: '👍', count: 3, own: false })).toStrictEqual({
        text: '👍 3',
        tooltip: '3 people',
      });
    });

    await it('says "You" for the own reaction', async () => {
      expect(reactionChip({ emoji: '❤️', count: 1, own: true }).tooltip).toBe('You');
      expect(reactionChip({ emoji: '❤️', count: 3, own: true }).tooltip).toBe('You and 2 others');
      expect(reactionChip({ emoji: '❤️', count: 2, own: true }).tooltip).toBe('You and 1 other');
    });
  });

  await describe('quoteOf', async () => {
    const chat = (over: Partial<ShownMessage> & { id: string }): ShownMessage =>
      message({ backend: 'matrix', ...over, ref: { accountId: 'a', backend: 'matrix', remoteId: over.id } });

    await it('names the author and the first line of the quoted text', async () => {
      const first = chat({ id: 'r1', senderName: 'Alex', bodyText: '\n  Treffen wir uns?\nUm acht.' });
      const reply = chat({ id: 'r2', replyToRemoteId: 'r1', bodyText: 'Gern' });
      expect(quoteOf(reply, [first, reply])).toStrictEqual({
        id: 'r1',
        author: 'Alex',
        excerpt: 'Treffen wir uns?',
      });
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

  await describe('replyDraftOf', async () => {
    const chat = (over: Partial<ShownMessage> & { id: string }): ShownMessage =>
      message({ backend: 'matrix', ...over, ref: { accountId: 'a', backend: 'matrix', remoteId: over.id } });
    const choices = [
      { backend: 'matrix', accountId: 'a' },
      { backend: 'signal', accountId: 's' },
    ];
    const can = (backend: string) => backend === 'matrix';

    await it('names the message and the carrier it must go through', async () => {
      const draft = replyDraftOf(
        chat({ id: '$1', senderName: 'Alex', bodyText: 'Treffen wir uns?' }),
        choices,
        can,
      );
      expect(draft?.target).toStrictEqual({ remoteId: '$1', text: 'Treffen wir uns?' });
      expect(draft?.choice).toBe(choices[0]);
      expect(draft?.author).toBe('Alex');
      expect(draft?.excerpt).toBe('Treffen wir uns?');
      expect(replyDraftOf(chat({ id: '$2', fromSelf: true, bodyText: 'Ja' }), choices, can)?.author).toBe(
        'You',
      );
    });

    await it('carries the sender-given id and whether the person wrote the message', async () => {
      const own = chat({ id: '$5', fromSelf: true, clientId: 'mine', bodyText: 'Ja' });
      expect(replyDraftOf(own, choices, can)?.target).toStrictEqual({
        remoteId: '$5',
        clientId: 'mine',
        fromSelf: true,
        text: 'Ja',
      });
    });

    await it('carries what the message said, trimmed and capped, for networks that quote content', async () => {
      const long = chat({ id: '$6', bodyText: `  ${'x'.repeat(800)}  ` });
      expect(replyDraftOf(long, choices, can)?.target.text?.length).toBe(500);
      expect(replyDraftOf(chat({ id: '$7', bodyText: '  ' }), choices, can)?.target.text === undefined).toBe(
        true,
      );
    });

    await it('offers nothing for a backend that cannot reply, a message without a network id or a foreign account', async () => {
      const signal = message({
        id: 'x',
        backend: 'signal',
        ref: { accountId: 's', backend: 'signal', remoteId: 'x' },
      });
      expect(replyDraftOf(signal, choices, can)).toBe(null);
      const bare = chat({ id: '$3' });
      bare.ref = { accountId: 'a', backend: 'matrix' };
      expect(replyDraftOf(bare, choices, can)).toBe(null);
      const other = chat({ id: '$4' });
      other.ref = { accountId: 'b', backend: 'matrix', remoteId: '$4' };
      expect(replyDraftOf(other, choices, can)).toBe(null);
    });
  });

  await describe('reacting', async () => {
    const chips = (r: Array<{ emoji: string; count: number; own: boolean }>) =>
      r.map((c) => `${c.emoji}${c.count}${c.own ? '*' : ''}`).join(',');

    await it('names the carrier a reaction goes through, like a reply', async () => {
      const choices = [{ backend: 'signal', accountId: 's' }];
      const signal = message({
        id: 'x',
        backend: 'signal',
        clientId: null,
        ref: { accountId: 's', backend: 'signal', remoteId: 's1:99' },
      });
      const handle = reactHandleOf(signal, choices, (b) => b === 'signal');
      expect(handle?.target).toStrictEqual({ remoteId: 's1:99' });
      expect(handle?.choice).toBe(choices[0]);
      expect(reactHandleOf(signal, choices, () => false)).toBe(null);
    });

    await it('offers no reaction where the chat cannot take one', async () => {
      expect(reactionsOfferedIn('telegram', true)).toBe(false);
      expect(reactionsOfferedIn('telegram', false)).toBe(true);
      expect(reactionsOfferedIn('signal', true)).toBe(true);
    });

    await it('closes edit and delete on Signal a day after sending, except in the note to self', async () => {
      const sent = '2026-09-01T10:00:00Z';
      const now = Date.parse(sent);
      const hour = 60 * 60 * 1000;
      expect(changesOfferedFor('signal', { sentAt: sent }, false, now + 23 * hour)).toBe(true);
      expect(changesOfferedFor('signal', { sentAt: sent }, false, now + 25 * hour)).toBe(false);
      expect(changesOfferedFor('signal', { sentAt: sent }, true, now + 25 * hour)).toBe(true);
      expect(changesOfferedFor('signal', { sentAt: null }, false, now + 25 * hour)).toBe(true);
      expect(changesOfferedFor('telegram', { sentAt: sent }, false, now + 99 * hour)).toBe(true);
    });

    await it('takes the own emoji back on a second tap and replaces it on another', async () => {
      const shown = [
        { emoji: '👍', count: 2, own: true },
        { emoji: '❤️', count: 1, own: false },
      ];
      expect(toggleOwnReaction(shown, '👍')).toStrictEqual({ emoji: null, previous: '👍' });
      expect(toggleOwnReaction(shown, '❤️')).toStrictEqual({ emoji: '❤️' });
      expect(toggleOwnReaction(undefined, '🙏')).toStrictEqual({ emoji: '🙏' });
    });

    await it("shows the person's reaction at once: one at a time, counts kept for the others", async () => {
      const shown = [
        { emoji: '👍', count: 2, own: true },
        { emoji: '❤️', count: 1, own: false },
      ];
      expect(chips(withOwnReaction(shown, '❤️'))).toBe('👍1,❤️2*');
      expect(chips(withOwnReaction(shown, '🙏'))).toBe('👍1,❤️1,🙏1*');
      expect(chips(withOwnReaction(shown, null))).toBe('👍1,❤️1');
      expect(chips(withOwnReaction([{ emoji: '👍', count: 1, own: true }], null))).toBe('');
      expect(chips(withOwnReaction(undefined, '👍'))).toBe('👍1*');
      expect(shown[0].count).toBe(2);
    });
  });

  await describe('editing and deleting', async () => {
    const choices = [
      { backend: 'signal', accountId: 's' },
      { backend: 'matrix', accountId: 'm' },
    ];
    const chat = (over: Partial<ShownMessage> & { id: string }): ShownMessage =>
      message({
        backend: 'signal',
        presentation: 'bubble',
        ...over,
        ref: { accountId: 's', backend: 'signal', remoteId: over.id },
      });

    await it("offers an edit handle only for the person's own messages on a capable backend", async () => {
      const own = chat({ id: 'x', fromSelf: true, bodyText: 'Hi' });
      const handle = editHandleOf(own, choices, (b) => b === 'signal');
      expect(handle?.target).toStrictEqual({ remoteId: 'x', fromSelf: true, text: 'Hi' });
      expect(handle?.choice).toBe(choices[0]);
      expect(editHandleOf(chat({ id: 'y', fromSelf: false }), choices, () => true)).toBe(null);
      expect(editHandleOf(own, choices, () => false)).toBe(null);
    });

    await it('offers no edit for a message with a file or without text', async () => {
      const withFile = chat({ id: 'x', fromSelf: true, hasAttachments: true });
      expect(editHandleOf(withFile, choices, () => true)).toBe(null);
      expect(editHandleOf(chat({ id: 'x', fromSelf: true, bodyText: '  ' }), choices, () => true)).toBe(null);
      expect(deleteHandleOf(withFile, choices, () => true)?.target.remoteId).toBe('x');
    });

    await it('edit handle carries the client id and trimmed text, like a reply', async () => {
      const own = chat({ id: 'x', fromSelf: true, clientId: 'mine', bodyText: '  Hello world  ' });
      expect(editHandleOf(own, choices, () => true)?.target).toStrictEqual({
        remoteId: 'x',
        clientId: 'mine',
        fromSelf: true,
        text: 'Hello world',
      });
    });

    await it('edit handle needs a remote id and a matching carrier choice', async () => {
      const noRemote = message({
        id: 'z',
        backend: 'signal',
        presentation: 'bubble',
        fromSelf: true,
        ref: { accountId: 's', backend: 'signal' },
      });
      expect(editHandleOf(noRemote, choices, () => true)).toBe(null);
      const wrongAccount = message({
        id: 'x',
        backend: 'signal',
        presentation: 'bubble',
        fromSelf: true,
        ref: { accountId: 'other', backend: 'signal', remoteId: 'x' },
      });
      expect(editHandleOf(wrongAccount, choices, () => true)).toBe(null);
    });

    await it('delete handle mirrors the edit handle rules', async () => {
      const own = chat({ id: 'x', fromSelf: true });
      expect(deleteHandleOf(own, choices, (b) => b === 'signal')?.target).toStrictEqual({
        remoteId: 'x',
        fromSelf: true,
      });
      expect(deleteHandleOf(chat({ id: 'y', fromSelf: false }), choices, () => true)).toBe(null);
      expect(deleteHandleOf(own, choices, () => false)).toBe(null);
    });
  });
};
