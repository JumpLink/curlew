/**
 * `curlew watch` — print the change journal as it grows (ADR 0007 §4).
 *
 * The reference listener: it holds a cursor, reads `readChanges` after it, and prints one JSON
 * line per row. It wakes on the daemon's `Changed` when a daemon owns the bus name; otherwise it
 * says so once on stderr and polls the journal itself, so it works on a machine with only `sync`
 * from a timer. A signal is never needed for correctness — a lost one costs latency.
 *
 * Prints what the journal holds and nothing else: kinds, ids and times, no text, no titles.
 */

import { _, fmt } from '@curlew/protocol';
import { type ChangeRow, type IndexDatabase, newestSeq, readChanges } from '@curlew/store';
import type { DaemonChangeSource } from '../lib/daemon-watch-client.ts';

/** How often `watch` looks at the journal when no daemon wakes it. */
export const WATCH_POLL_MS = 2_000;
/** With a daemon the signal wakes it; this is only the net under a lost one. */
export const WATCH_SAFETY_MS = 30_000;
const PAGE = 500;

/** The journal moved past this reader: everything it shows has to be read again. */
export interface WatchResync {
  resync: true;
  oldest: number | null;
  newest: number | null;
}

export type WatchLine = ChangeRow | WatchResync;

/** Everything after `cursor`, in order; a fell-behind cursor yields one resync line and jumps to the newest. */
export function watchStep(db: IndexDatabase, cursor: number): { lines: WatchLine[]; cursor: number } {
  const lines: WatchLine[] = [];
  let at = cursor;
  for (;;) {
    const read = readChanges(db, at, PAGE);
    if (read.oldest !== null && at < read.oldest - 1 && lines.length === 0) {
      lines.push({ resync: true, oldest: read.oldest, newest: read.newest });
      at = read.newest ?? at;
      return { lines, cursor: at };
    }
    for (const change of read.changes) lines.push(change);
    if (read.changes.length > 0) at = read.changes[read.changes.length - 1].seq;
    if (read.changes.length < PAGE) return { lines, cursor: at };
  }
}

export interface WatchParams {
  db: IndexDatabase;
  /** Where to start; the default is the current newest row, so only NEW changes are printed. */
  since?: number;
  signal: AbortSignal;
  /** One line per journal row, as JSON. */
  out: (line: string) => void;
  /** Said once on stderr. */
  notice: (text: string) => void;
  source: DaemonChangeSource;
  pollMs?: number;
  safetyMs?: number;
}

export async function runWatch(params: WatchParams): Promise<void> {
  const { db, signal } = params;
  let cursor = params.since ?? newestSeq(db) ?? 0;
  let wake: (() => void) | null = null;
  const nudge = (): void => wake?.();
  const unsubscribe = params.source.subscribe(nudge);
  if (unsubscribe === null) {
    params.notice(
      fmt(_('no curlew daemon on the session bus — reading the journal every {seconds} s myself'), {
        seconds: String((params.pollMs ?? WATCH_POLL_MS) / 1000),
      }),
    );
  }
  const wait = unsubscribe === null ? (params.pollMs ?? WATCH_POLL_MS) : (params.safetyMs ?? WATCH_SAFETY_MS);
  signal.addEventListener('abort', nudge, { once: true });
  try {
    while (!signal.aborted) {
      const step = watchStep(db, cursor);
      for (const line of step.lines) params.out(JSON.stringify(line));
      cursor = step.cursor;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, wait);
        function done(): void {
          clearTimeout(timer);
          wake = null;
          resolve();
        }
        wake = done;
        // An abort or a signal that came in while the read ran must not wait out the timer.
        if (signal.aborted) done();
      });
    }
  } finally {
    unsubscribe?.();
    signal.removeEventListener('abort', nudge);
  }
}
