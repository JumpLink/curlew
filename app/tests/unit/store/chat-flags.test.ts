import { describe, expect, it } from '@gjsify/unit';

import {
  applyRemoteFavourite,
  applyRemoteMute,
  chatConversationId,
  clearFlagPending,
  isMutedAt,
  listConversations,
  listTimedMutes,
  loadChatFlags,
  newestSeq,
  rebuildConversations,
  resolveFlag,
  setChatFavourite,
  setChatMuted,
  syncChats,
} from '@curlew/store';
import { telegramFixture } from './chat-fixtures.ts';
import { freshDb } from './fixtures.ts';

/** Mute and favourite flags (schema v30, ADR 0020). All content is synthetic. */

const DIRECT = chatConversationId('telegram', 'telegram-42', '1001');
const T0 = new Date('2026-11-01T10:00:00Z');
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

async function seeded() {
  const db = freshDb();
  await syncChats(db, telegramFixture());
  rebuildConversations(db);
  return db;
}

export default async () => {
  await describe('chat flags', async () => {
    await it('stores a local mute, journals it and reads it back through the list', async () => {
      const db = await seeded();
      try {
        const before = newestSeq(db) ?? 0;
        expect(setChatMuted(db, DIRECT, { muted: true, now: T0 })).toBe(true);
        expect((newestSeq(db) ?? 0) > before).toBe(true);
        const conv = listConversations(db).find((c) => c.id === DIRECT);
        expect(conv?.muted).toBe(true);
        expect(conv?.mutedUntil).toBe(null);
        expect(conv?.favourite).toBe(false);
        setChatMuted(db, DIRECT, { muted: false, now: at(1) });
        expect(listConversations(db).find((c) => c.id === DIRECT)?.muted).toBe(false);
        expect(setChatMuted(db, 'nope', { muted: true })).toBe(false);
      } finally {
        db.close();
      }
    });

    await it('survives a sync and a rebuild', async () => {
      const db = freshDb();
      try {
        const backend = telegramFixture();
        await syncChats(db, backend);
        setChatMuted(db, DIRECT, { muted: true, now: T0 });
        setChatFavourite(db, DIRECT, { favourite: true, now: T0 });
        await syncChats(db, backend, { fullScan: true });
        rebuildConversations(db);
        const flags = loadChatFlags(db, DIRECT);
        expect(flags?.muted).toBe(true);
        expect(flags?.favourite).toBe(true);
      } finally {
        db.close();
      }
    });

    await it('treats a lapsed mute-until as unmuted and lists timed mutes', async () => {
      const db = await seeded();
      try {
        setChatMuted(db, DIRECT, { muted: true, until: '2020-01-01T00:00:00.000Z', now: T0 });
        const flags = loadChatFlags(db, DIRECT);
        expect(isMutedAt(flags, T0)).toBe(false);
        expect(isMutedAt({ muted: true, mutedUntil: '2999-01-01T00:00:00Z' }, T0)).toBe(true);
        expect(listConversations(db).find((c) => c.id === DIRECT)?.muted).toBe(false);
        expect(listTimedMutes(db).length).toBe(1);
      } finally {
        db.close();
      }
    });

    await it('an echo does not flip the local flag and clears the pending mark', async () => {
      const db = await seeded();
      try {
        setChatMuted(db, DIRECT, { muted: true, pending: true, now: T0 });
        expect(loadChatFlags(db, DIRECT)?.mutePendingAt).toBe(T0.toISOString());
        const out = applyRemoteMute(db, DIRECT, { muted: true, until: null }, { apply: true, now: at(1) });
        expect(out?.resolution).toBe('echo');
        const flags = loadChatFlags(db, DIRECT);
        expect(flags?.muted).toBe(true);
        expect(flags?.mutePendingAt).toBe(null);
        expect(flags?.remoteMuted).toBe(true);
      } finally {
        db.close();
      }
    });

    await it('a remote change with nothing pending wins over an older local one', async () => {
      const db = await seeded();
      try {
        setChatMuted(db, DIRECT, { muted: true, now: T0 });
        const out = applyRemoteMute(db, DIRECT, { muted: false, until: null }, { apply: true, now: at(5) });
        expect(out?.resolution).toBe('apply');
        expect(loadChatFlags(db, DIRECT)?.muted).toBe(false);
      } finally {
        db.close();
      }
    });

    await it('a pending write survives one contradicting report and loses the second', async () => {
      const db = await seeded();
      try {
        setChatMuted(db, DIRECT, { muted: true, pending: true, now: T0 });
        const first = applyRemoteMute(db, DIRECT, { muted: false, until: null }, { apply: true, now: at(1) });
        expect(first?.resolution).toBe('retry');
        expect(loadChatFlags(db, DIRECT)?.muted).toBe(true);
        expect(loadChatFlags(db, DIRECT)?.mutePendingAt).not.toBe(null);
        const second = applyRemoteMute(
          db,
          DIRECT,
          { muted: false, until: null },
          { apply: true, retried: true, now: at(2) },
        );
        expect(second?.resolution).toBe('take-remote');
        const flags = loadChatFlags(db, DIRECT);
        expect(flags?.muted).toBe(false);
        expect(flags?.mutePendingAt).toBe(null);
      } finally {
        db.close();
      }
    });

    await it('with sync off it mirrors the network but moves nothing local', async () => {
      const db = await seeded();
      try {
        setChatMuted(db, DIRECT, { muted: false, now: T0 });
        const out = applyRemoteMute(db, DIRECT, { muted: true, until: null }, { apply: false, now: at(3) });
        expect(out?.resolution).toBe('keep');
        const flags = loadChatFlags(db, DIRECT);
        expect(flags?.muted).toBe(false);
        expect(flags?.remoteMuted).toBe(true);
      } finally {
        db.close();
      }
    });

    await it('resolves favourites independently of mutes', async () => {
      const db = await seeded();
      try {
        setChatMuted(db, DIRECT, { muted: true, pending: true, now: T0 });
        setChatFavourite(db, DIRECT, { favourite: true, pending: true, now: T0 });
        applyRemoteFavourite(db, DIRECT, true, { apply: true, now: at(1) });
        const flags = loadChatFlags(db, DIRECT);
        expect(flags?.favouritePendingAt).toBe(null);
        expect(flags?.mutePendingAt).not.toBe(null);
        clearFlagPending(db, DIRECT, 'mute');
        expect(loadChatFlags(db, DIRECT)?.mutePendingAt).toBe(null);
      } finally {
        db.close();
      }
    });

    await it('resolveFlag keeps a newer local change when nothing is pending', async () => {
      expect(
        resolveFlag({
          local: true,
          remote: false,
          pendingAt: null,
          localAt: at(10).toISOString(),
          remoteAt: at(5).toISOString(),
          retried: false,
          equal: (a, b) => a === b,
        }),
      ).toBe('keep');
    });
  });
};
