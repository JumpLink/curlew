import { describe, expect, it } from '@gjsify/unit';
import type { AddressKind, Conversation, Participant } from '@curlew/protocol';

import { parseConfig } from '../../../src/core/config.ts';
import {
  type ListEntry,
  buildSections,
  fieldHit,
  matches,
  phoneDigits,
  toEntries,
} from '../../../src/window/conversation-list-model.ts';

// Synthetic data only.
const chat = (over: Partial<Conversation> & { id: string }): Conversation =>
  ({
    backend: 'whatsapp',
    accountId: 'whatsapp-1',
    kind: 'direct',
    title: null,
    participants: [],
    classification: 'conversational',
    classificationReason: 'default',
    firstMessageAt: null,
    lastMessageAt: '2026-01-01T10:00:00Z',
    messageCount: 1,
    unreadCount: 0,
    hasAttachments: false,
    emailChat: false,
    ...over,
  }) as Conversation;

const person = (id: string, name: string | null, addresses: Array<[AddressKind, string]>): Participant => ({
  id,
  displayName: name,
  addresses: addresses.map(([kind, value]) => ({ kind, value })),
  contactUid: null,
});

const entries = (): ListEntry[] =>
  toEntries([
    chat({
      id: 'c-ana',
      participants: [person('p-ana', 'Ana Example', [['phone', '+491511234567']])],
    }),
    chat({
      id: 'c-bo',
      backend: 'telegram',
      accountId: 'telegram-1',
      participants: [person('p-bo', 'Bo Sample', [['telegram', 'bosample']])],
    }),
  ]);

const query = (text: string, scope?: 'all' | 'names' | 'messages', hits: Array<[string, string]> = []) => ({
  backends: new Set<string>(),
  accounts: new Map<string, Set<string>>(),
  query: text,
  hits: new Map(hits),
  ...(scope === undefined ? {} : { scope }),
});

const shown = (text: string, scope?: 'all' | 'names' | 'messages', hits: Array<[string, string]> = []) =>
  buildSections(entries(), query(text, scope, hits)).flatMap((s) => s.entries);

export default async () => {
  describe('conversation search scope', () => {
    it('finds a chat by name and shows no extra field when the title matched', () => {
      const found = shown('ana');
      expect(found.map((e) => e.id)).toStrictEqual(['c-ana']);
      expect(found[0]!.preview).toBe(undefined);
    });

    it('finds a phone number in several formats and shows the matched number', () => {
      for (const text of ['+49 151 1234567', '0151 1234567', '0049 151 1234567', '151-1234']) {
        const found = shown(text);
        expect(found.map((e) => e.id)).toStrictEqual(['c-ana']);
        expect(found[0]!.preview).toBe('+491511234567');
      }
    });

    it('finds a handle with or without the @', () => {
      expect(shown('@bosample').map((e) => e.id)).toStrictEqual(['c-bo']);
      expect(shown('bosample')[0]!.preview).toBe('bosample');
    });

    it('does not match a number against an unrelated one', () => {
      expect(shown('0170 9999999')).toStrictEqual([]);
    });

    it('finds by message text and shows the matching line', () => {
      const found = shown('invoice', undefined, [['c-bo', 'the invoice is ready']]);
      expect(found.map((e) => e.id)).toStrictEqual(['c-bo']);
      expect(found[0]!.preview).toBe('the invoice is ready');
    });

    it('"names" ignores message hits, "messages" ignores names and numbers', () => {
      const hit: Array<[string, string]> = [['c-bo', 'ana wrote this']];
      expect(shown('ana', 'names', hit).map((e) => e.id)).toStrictEqual(['c-ana']);
      expect(shown('ana', 'messages', hit).map((e) => e.id)).toStrictEqual(['c-bo']);
      expect(shown('151 1234', 'messages')).toStrictEqual([]);
    });

    it('matches through a merged contact, by any of its members', () => {
      const merged = toEntries([
        chat({ id: 'w', participants: [person('p-x', 'Cy Example', [['phone', '+4917011111']])] }),
        chat({
          id: 't',
          backend: 'telegram',
          accountId: 'telegram-1',
          participants: [person('p-x', 'Cy Example', [['telegram', 'cyexample']])],
        }),
      ]);
      expect(merged.length).toBe(1);
      expect(fieldHit(merged[0]!, '0170 11111')).toBe('+4917011111');
      expect(fieldHit(merged[0]!, 'cyexample')).toBe('cyexample');
    });

    it('lists everything for an empty query', () => {
      expect(shown('').length).toBe(2);
      expect(shown('   ', 'messages').length).toBe(2);
    });

    it('keeps the protocol filter in force', () => {
      const filter = { ...query('ana'), backends: new Set(['telegram']) };
      expect(entries().filter((e) => matches(e, filter))).toStrictEqual([]);
    });

    it('reduces a phone query to digits only when it looks like a number', () => {
      expect(phoneDigits('+49 (151) 12')).toBe('4915112');
      expect(phoneDigits('0151 12')).toBe('15112');
      expect(phoneDigits('ana')).toBe(null);
      expect(phoneDigits('01')).toBe(null);
    });

    it('validates ui.searchScope in the config', () => {
      expect(parseConfig('{"ui":{"searchScope":"messages"}}').ui.searchScope).toBe('messages');
      expect(parseConfig('{}').ui.searchScope).toBe(undefined);
      expect(() => parseConfig('{"ui":{"searchScope":"nope"}}')).toThrow();
    });
  });
};
