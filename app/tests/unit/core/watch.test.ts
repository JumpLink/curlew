import { describe, expect, it } from '@gjsify/unit';

import { appendChanges, CHANGES_KEEP_ROWS, type IndexDatabase } from '@curlew/store';
import { runWatch, watchStep } from '../../../src/core/actions/watch.ts';
import type { DaemonChangeSource } from '../../../src/core/lib/daemon-watch-client.ts';
import { freshDb } from '../store/fixtures.ts';

/** `curlew watch` (ADR 0007 §4) against a :memory: journal and an injected bus. Synthetic ids. */

const T0 = new Date('2026-11-01T10:00:00.000Z');
const noBus: DaemonChangeSource = { subscribe: () => null };

const add = (db: IndexDatabase, conversationId: string): void =>
  appendChanges(db, [{ kind: 'messages', backend: 'xmpp', accountId: 'a-1', conversationId }], T0);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export default async () => {
  await describe('curlew watch', async () => {
    await it('steps over rows after the cursor and moves it', async () => {
      const db = freshDb();
      try {
        add(db, 'c-1');
        add(db, 'c-2');
        const first = watchStep(db, 0);
        expect(first.lines.length).toBe(2);
        const again = watchStep(db, first.cursor);
        expect(again.lines.length).toBe(0);
        expect(again.cursor).toBe(first.cursor);
        add(db, 'c-3');
        const next = watchStep(db, first.cursor);
        expect(next.lines.length).toBe(1);
        expect((next.lines[0] as { conversationId: string }).conversationId).toBe('c-3');
      } finally {
        db.close();
      }
    });

    await it('prints one resync line when the cursor fell behind the pruned journal', async () => {
      const db = freshDb();
      try {
        const rows = Array.from({ length: CHANGES_KEEP_ROWS + 5 }, (_unused, i) => ({
          kind: 'messages' as const,
          backend: 'xmpp',
          accountId: 'a-1',
          conversationId: `c-${i}`,
        }));
        appendChanges(db, rows, new Date(T0.getTime() - 30 * 24 * 3600 * 1000));
        appendChanges(db, [{ kind: 'accounts', backend: 'xmpp', accountId: 'a-1' }], T0);
        const step = watchStep(db, 1);
        expect(step.lines.length).toBe(1);
        const line = step.lines[0] as { resync?: boolean; oldest: number; newest: number };
        expect(line.resync).toBe(true);
        expect(step.cursor).toBe(line.newest);
        expect(watchStep(db, step.cursor).lines.length).toBe(0);
      } finally {
        db.close();
      }
    });

    await it('starts at the newest row, polls, and says once that there is no daemon', async () => {
      const db = freshDb();
      const controller = new AbortController();
      const out: string[] = [];
      const notices: string[] = [];
      try {
        add(db, 'old');
        const running = runWatch({
          db,
          signal: controller.signal,
          out: (line) => out.push(line),
          notice: (text) => notices.push(text),
          source: noBus,
          pollMs: 5,
        });
        await sleep(20);
        expect(out.length).toBe(0);
        add(db, 'new');
        await sleep(40);
        controller.abort();
        await running;
        expect(out.length).toBe(1);
        const row = JSON.parse(out[0]) as Record<string, unknown>;
        expect(row.conversationId).toBe('new');
        expect(Object.keys(row).sort().join(',')).toBe('accountId,at,backend,conversationId,kind,seq');
        expect(notices.length).toBe(1);
      } finally {
        controller.abort();
        db.close();
      }
    });

    await it('honours --since and wakes on Changed without polling', async () => {
      const db = freshDb();
      const controller = new AbortController();
      const out: string[] = [];
      const notices: string[] = [];
      let nudge: (seq: number) => void = () => {};
      const bus: DaemonChangeSource = {
        subscribe: (onChanged) => {
          nudge = onChanged;
          return () => {};
        },
      };
      try {
        add(db, 'c-1');
        add(db, 'c-2');
        const running = runWatch({
          db,
          since: 1,
          signal: controller.signal,
          out: (line) => out.push(line),
          notice: (text) => notices.push(text),
          source: bus,
          safetyMs: 60_000,
        });
        await sleep(20);
        expect(out.length).toBe(1);
        add(db, 'c-3');
        await sleep(20);
        expect(out.length).toBe(1);
        nudge(3);
        await sleep(20);
        expect(out.length).toBe(2);
        controller.abort();
        await running;
        expect(notices.length).toBe(0);
      } finally {
        controller.abort();
        db.close();
      }
    });
  });
};
