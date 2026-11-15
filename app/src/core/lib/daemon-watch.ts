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

/**
 * How long the window waits before it calls a vanished daemon absent. The window restarts the
 * daemon itself (`systemctl --user try-restart`) after an account or protocol change, and the bus
 * name is gone from the stop until the new daemon serves again, which takes 2–3 s and far longer
 * on a loaded phone.
 */
export const VANISH_GRACE_MS = 10_000;

export interface PresenceTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface PresenceGate {
  /** The bus name has (`true`) or has not (`false`) an owner. */
  owner(present: boolean): void;
  /** The window just restarted the daemon: the next vanish is expected to be short. */
  expectRestart(): void;
  /** Cancel every timer. */
  dispose(): void;
}

/**
 * Turns raw owner changes into the presence the window shows. It starts `unknown` and reports
 * only changes. A first answer of "no owner" is a real absence and is reported at once, unless a
 * restart is under way; a daemon that vanishes after it was seen counts as absent only when the
 * name stays gone for `graceMs`. A reappearance within that time reports nothing at all.
 */
export function createPresenceGate(
  report: (presence: DaemonPresence) => void,
  timers: PresenceTimers,
  graceMs = VANISH_GRACE_MS,
): PresenceGate {
  let presence: DaemonPresence = 'unknown';
  let vanishTimer: unknown = null;
  let restartTimer: unknown = null;
  let restarting = false;

  const settle = (next: DaemonPresence) => {
    if (next === presence) return;
    presence = next;
    report(next);
  };
  const cancelVanish = () => {
    if (vanishTimer === null) return;
    timers.clear(vanishTimer);
    vanishTimer = null;
  };
  const endRestart = () => {
    if (restartTimer !== null) timers.clear(restartTimer);
    restartTimer = null;
    restarting = false;
  };

  return {
    owner(present) {
      if (present) {
        cancelVanish();
        endRestart();
        settle('present');
        return;
      }
      if (vanishTimer !== null) return;
      if (presence !== 'present' && !restarting) {
        settle('absent');
        return;
      }
      vanishTimer = timers.set(() => {
        vanishTimer = null;
        endRestart();
        settle('absent');
      }, graceMs);
    },
    expectRestart() {
      restarting = true;
      if (restartTimer !== null) timers.clear(restartTimer);
      restartTimer = timers.set(() => {
        restartTimer = null;
        restarting = false;
      }, graceMs);
    },
    dispose() {
      cancelVanish();
      endRestart();
    },
  };
}
