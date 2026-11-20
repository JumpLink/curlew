import { describe, expect, it } from '@gjsify/unit';
import parse from '@xmpp/xml/lib/parse.js';

import {
  applyMentionLabels,
  codePointToUtf16,
  mentionsFromJson,
  mentionsToJson,
  normalizeMentions,
} from '@curlew/protocol';
import { mentionsOf as matrixMentions } from '@curlew/matrix';
import { mentionsOf as telegramMentions } from '@curlew/telegram';
import { mentionsOf as whatsappMentions } from '@curlew/whatsapp';
import { mentionRefsOf, mentionsOf as xmppMentions } from '@curlew/xmpp';
import { decodeContent, encodeContent, SignalMapper } from '@curlew/signal';

import {
  clipMentions,
  mentionEntry,
  mentionIndex,
  mentionMarkup,
  mentionName,
  trimWithMentions,
} from '../../../src/window/mention-model.ts';
import { ALICE_ACI, groupIdOf, OWN_ACI } from '../signal/world.ts';

const ME = 'me@example.org';

export default async () => {
  await describe('mention helpers', async () => {
    await it('keeps only ordered, non-overlapping ranges inside the text', async () => {
      const kept = normalizeMentions('hello bob', [
        { start: 6, end: 9, userId: 'bob' },
        { start: 7, end: 8, userId: 'x' },
        { start: 0, end: 99, userId: 'y' },
        { start: 3, end: 3, userId: 'z' },
      ]);
      expect(kept).toStrictEqual([{ start: 6, end: 9, userId: 'bob' }]);
      expect(normalizeMentions('abc', [])).toBe(undefined);
    });

    await it('replaces placeholders with labels and moves later ranges', async () => {
      const out = applyMentionLabels('a \uFFFC b \uFFFC', [
        { start: 2, end: 3, userId: 'u1', label: '@Alice' },
        { start: 6, end: 7, userId: 'u2', label: '@Bo', self: true },
      ]);
      expect(out.text).toBe('a @Alice b @Bo');
      expect(out.mentions).toStrictEqual([
        { start: 2, end: 8, userId: 'u1' },
        { start: 11, end: 14, userId: 'u2', self: true },
      ]);
    });

    await it('converts code-point offsets and round-trips through JSON', async () => {
      expect(codePointToUtf16('😀 hi', 2)).toBe(3);
      const m = [{ start: 1, end: 3, userId: 'u', self: true }];
      expect(mentionsFromJson(mentionsToJson(m))).toStrictEqual(m);
      expect(mentionsToJson(undefined)).toBe(null);
      expect(mentionsFromJson('not json')).toBe(undefined);
      expect(mentionsFromJson(null)).toBe(undefined);
    });
  });

  await describe('mentions per backend', async () => {
    await it('Matrix: a matrix.to pill whose text is in the body', async () => {
      const content = {
        msgtype: 'm.text',
        body: 'hi Alice and Bob',
        format: 'org.matrix.custom.html',
        formatted_body:
          'hi <a href="https://matrix.to/#/@alice:ex.org">Alice</a> and <a href="https://matrix.to/#/@bob:ex.org">Bob</a>',
        'm.mentions': { user_ids: ['@alice:ex.org', '@bob:ex.org'] },
      };
      expect(matrixMentions(content, content.body, '@bob:ex.org')).toStrictEqual([
        { start: 3, end: 8, userId: '@alice:ex.org' },
        { start: 13, end: 16, userId: '@bob:ex.org', self: true },
      ]);
    });

    await it('Matrix: m.mentions restricts, a pill missing from the text and a plain link do not count', async () => {
      const content = {
        body: 'hi Alice see Docs',
        format: 'org.matrix.custom.html',
        formatted_body:
          'hi <a href="https://matrix.to/#/@alice:ex.org">Alice</a> see <a href="https://example.org">Docs</a> <a href="https://matrix.to/#/@ghost:ex.org">Ghost</a>',
        'm.mentions': { user_ids: ['@alice:ex.org'] },
      };
      expect(matrixMentions(content, content.body, '')).toStrictEqual([
        { start: 3, end: 8, userId: '@alice:ex.org' },
      ]);
      expect(matrixMentions({ body: 'plain' }, 'plain', '')).toBe(undefined);
    });

    await it('Telegram: text_mention entities carry the person by id', async () => {
      const message = {
        text: 'ping Anna now',
        entities: [
          { offset: 5, length: 4, kind: 'text_mention', params: { kind: 'text_mention', userId: 42 } },
          { offset: 0, length: 4, kind: 'mention', params: { kind: 'mention' } },
        ],
      };
      expect(telegramMentions(message as never, 42)).toStrictEqual([
        { start: 5, end: 9, userId: '42', self: true },
      ]);
      expect(telegramMentions(message as never, null)).toStrictEqual([{ start: 5, end: 9, userId: '42' }]);
      expect(telegramMentions({ text: 'x', entities: [] } as never, null)).toBe(undefined);
    });

    await it('Signal: bodyRanges over U+FFFC become a name stand-in', async () => {
      const mapper = new SignalMapper(OWN_ACI, groupIdOf);
      const content = decodeContent(
        encodeContent({
          dataMessage: {
            body: 'hi \uFFFC and \uFFFC',
            timestamp: 1,
            mentions: [
              { start: 3, length: 1, aci: ALICE_ACI },
              { start: 9, length: 1, aci: OWN_ACI },
            ],
          },
        }),
      );
      const [event] = mapper.map(content, { senderAci: ALICE_ACI, timestamp: 1, groupId: null }).events;
      if (event?.type !== 'message') throw new Error('expected a message');
      const label = `@${ALICE_ACI.slice(0, 8)}`;
      const own = `@${OWN_ACI.slice(0, 8)}`;
      expect(event.message.text).toBe(`hi ${label} and ${own}`);
      expect(event.message.mentions).toStrictEqual([
        { start: 3, end: 3 + label.length, userId: ALICE_ACI },
        { start: 8 + label.length, end: 8 + label.length + own.length, userId: OWN_ACI, self: true },
      ]);
    });

    await it('Signal: a body without ranges has no mentions', async () => {
      const mapper = new SignalMapper(OWN_ACI, groupIdOf);
      const content = decodeContent(encodeContent({ dataMessage: { body: 'plain', timestamp: 1 } }));
      const [event] = mapper.map(content, { senderAci: ALICE_ACI, timestamp: 1, groupId: null }).events;
      if (event?.type !== 'message') throw new Error('expected a message');
      expect(event.message.mentions).toBe(undefined);
    });

    await it('WhatsApp: mentionedJid matched to @number in the text', async () => {
      const text = 'hello @491701234567 and @491709999999';
      const found = whatsappMentions(
        text,
        ['491701234567@s.whatsapp.net', '491709999999@s.whatsapp.net'],
        (jid) => jid.startsWith('4917012'),
      );
      expect(found).toStrictEqual([
        { start: 6, end: 19, userId: '491701234567@s.whatsapp.net', self: true },
        { start: 24, end: 37, userId: '491709999999@s.whatsapp.net' },
      ]);
      expect(whatsappMentions('no tag', ['1@s.whatsapp.net'])).toBe(undefined);
      expect(whatsappMentions('@1 hi', undefined)).toBe(undefined);
    });

    await it('XMPP: XEP-0372 references in code points, past a reply fallback', async () => {
      const xml =
        `<message xmlns="jabber:client" type="chat">` +
        `<body>&gt; quoted\n😀 hi Juliet!</body>` +
        `<fallback xmlns="urn:xmpp:fallback:0" for="urn:xmpp:reply:0"><body start="0" end="9"/></fallback>` +
        `<reference xmlns="urn:xmpp:reference:0" type="mention" begin="14" end="20" uri="xmpp:juliet@example.org"/>` +
        `<reference xmlns="urn:xmpp:reference:0" type="data" begin="0" end="2" uri="xmpp:x@example.org"/>` +
        `</message>`;
      const message = parse(xml);
      const stripped = '😀 hi Juliet!';
      const refs = mentionRefsOf(message, stripped);
      expect(refs.length).toBe(1);
      expect(stripped.slice(refs[0]!.start, refs[0]!.end)).toBe('Juliet');
      expect(refs[0]!.jid).toBe('juliet@example.org');
    });

    await it('XMPP: marks a mention of the account itself and ignores edited-out text', async () => {
      const context = { selfJid: ME, kind: 'direct' } as never;
      const entry = { body: 'hi me', mentions: [{ start: 3, end: 5, jid: `${ME}/phone` }] } as never;
      expect(xmppMentions(context, entry, 'hi me')).toStrictEqual([
        { start: 3, end: 5, userId: `${ME}/phone`, self: true },
      ]);
      expect(xmppMentions(context, entry, 'changed')).toBe(undefined);
    });
  });

  await describe('mention-model', async () => {
    const mentions = [
      { start: 3, end: 8, userId: '@alice:ex.org' },
      { start: 13, end: 16, userId: '@bob:ex.org', self: true },
    ];

    await it('renders links with escaped labels and a stronger self mention', async () => {
      const out = mentionMarkup('hi <Alice> and Bob', [{ start: 3, end: 10, userId: 'a' }]);
      expect(out.markup).toBe('hi <a href="curlew-mention:0">&lt;Alice&gt;</a> and Bob');
      const self = mentionMarkup('hi Alice and Bob', mentions);
      expect(self.markup.includes('<b><a href="curlew-mention:1">Bob</a></b>')).toBe(true);
      expect(self.targets.length).toBe(2);
      expect(self.shown).toBe('hi Alice and Bob');
    });

    await it('swaps an identifier-like stand-in for a known name, never a written name', async () => {
      const text = 'hi @491701234567 and Anna';
      const m = [
        { start: 3, end: 16, userId: 'u' },
        { start: 21, end: 25, userId: 'v' },
      ];
      const out = mentionMarkup(text, m, () => 'Mia');
      expect(out.markup.includes('>@Mia</a>')).toBe(true);
      expect(out.markup.includes('>Anna</a>')).toBe(true);
    });

    await it('trims text and clips mentions with it', async () => {
      const t = trimWithMentions('  hi Al', [{ start: 5, end: 7, userId: 'a' }]);
      expect(t).toStrictEqual({ text: 'hi Al', mentions: [{ start: 3, end: 5, userId: 'a' }] });
      expect(clipMentions(mentions, 10)).toStrictEqual([mentions[0]]);
      expect(clipMentions(undefined, 10)).toBe(undefined);
    });

    await it('reads the index out of a mention link and nothing else', async () => {
      expect(mentionIndex('curlew-mention:2')).toBe(2);
      expect(mentionIndex('https://example.org')).toBe(null);
      expect(mentionIndex('curlew-mention:x')).toBe(null);
    });

    await it('finds the direct chat and name of a mentioned person', async () => {
      const row = {
        id: 'c1',
        backend: 'matrix',
        kind: 'direct',
        members: [],
        people: [{ name: 'Alice', addresses: ['@alice:ex.org'] }],
      } as never;
      expect(mentionEntry([row], 'matrix', mentions[0]!)).toBe(row);
      expect(mentionName([row], 'matrix', mentions[0]!)).toBe('Alice');
      expect(mentionEntry([row], 'signal', mentions[0]!)).toBe(null);
      expect(mentionEntry([row], 'matrix', mentions[1]!)).toBe(null);
    });
  });
};
