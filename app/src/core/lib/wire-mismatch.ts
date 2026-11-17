/**
 * One place the window hears about a daemon wire mismatch, whichever call hit it: the accounts
 * query, a send, an attachment fetch or an access prompt. The window shows one banner for all.
 */

import { DaemonWireMismatchError, wireMismatchOf } from './daemon-bus.ts';

type Listener = (error: DaemonWireMismatchError) => void;

const listeners = new Set<Listener>();

/** Follow mismatches; returns the function that stops following. */
export function onWireMismatch(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Tell the listeners when `error` is a mismatch; returns it, or null for any other error. */
export function reportWireMismatch(error: unknown): DaemonWireMismatchError | null {
  const mismatch = wireMismatchOf(error);
  if (mismatch) for (const listener of [...listeners]) listener(mismatch);
  return mismatch;
}

/** Run a reply parser; a mismatch is reported, then thrown as before. */
export function parseReporting<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    reportWireMismatch(error);
    throw error;
  }
}
