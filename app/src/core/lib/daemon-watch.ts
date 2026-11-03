/**
 * The listener's view of the daemon on the session bus (ADR 0007 §2): the port a listener is
 * written against and the pure decision of what a change of the bus name's owner means. No
 * `gi://` here, so `watch` and its tests run on Node; the Gio source is
 * `daemon-watch-client.gjs.ts`.
 */

export interface DaemonWatchHandlers {
  /** The bus name has (`true`) or has not (`false`) an owner. Called once at start, then on each change. */
  owner(present: boolean): void;
  /** The daemon emitted `Changed`. */
  changed(seq: number): void;
}

export interface DaemonChangeSource {
  /** Follow the daemon coming and going; returns how to stop. Never throws: no bus is "no owner". */
  follow(handlers: DaemonWatchHandlers): () => void;
}

export type DaemonPresence = 'unknown' | 'present' | 'absent';

/** What the listener says about a transition — once per transition, never on a repeat. */
export type DaemonNotice = 'absent-at-start' | 'vanished' | 'appeared';

export interface PresenceStep {
  presence: DaemonPresence;
  notice: DaemonNotice | null;
  /** Read the journal now: a daemon that just appeared may have written before we subscribed. */
  readNow: boolean;
}

export function nextPresence(previous: DaemonPresence, present: boolean): PresenceStep {
  const presence: DaemonPresence = present ? 'present' : 'absent';
  if (presence === previous) return { presence, notice: null, readNow: false };
  if (present) {
    return { presence, notice: previous === 'absent' ? 'appeared' : null, readNow: true };
  }
  return { presence, notice: previous === 'present' ? 'vanished' : 'absent-at-start', readNow: true };
}
