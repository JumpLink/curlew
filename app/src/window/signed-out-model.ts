/**
 * Which accounts are known to be signed out. Two sources: the daemon's account state (authoritative,
 * kept until it reports another state) and one refused fetch (a fallback that expires, for when no
 * daemon state is known). No GTK, so both runtimes test it.
 */

import type { DaemonAccountEntry } from '../core/lib/daemon-bus.ts';

/** How long one refused fetch marks the rest of its account's parts when the daemon says nothing. */
export const SIGNED_OUT_TTL_MS = 5 * 60_000;

export function accountKeyOf(backend: string, accountId: string): string {
  return `${backend}/${accountId}`;
}

export class SignedOutRegistry {
  private readonly fromDaemon = new Set<string>();
  private readonly fromFetch = new Map<string, number>();

  isSignedOut(key: string, now = Date.now()): boolean {
    if (this.fromDaemon.has(key)) return true;
    const since = this.fromFetch.get(key);
    if (since === undefined) return false;
    if (now - since < SIGNED_OUT_TTL_MS) return true;
    this.fromFetch.delete(key);
    return false;
  }

  /** A refused fetch; ignored while the daemon already reports the account's state either way. */
  noteFailure(key: string, now = Date.now()): void {
    this.fromFetch.set(key, now);
  }

  clear(key: string): void {
    this.fromDaemon.delete(key);
    this.fromFetch.delete(key);
  }

  /** The daemon's account list: a logged-out account is marked, any other state clears the mark. Returns the keys that changed. */
  applyDaemon(accounts: Iterable<DaemonAccountEntry>): string[] {
    const changed: string[] = [];
    for (const entry of accounts) {
      const key = accountKeyOf(entry.backend, entry.accountId);
      const was = this.isSignedOut(key);
      if (entry.state === 'logged-out') {
        this.fromDaemon.add(key);
        this.fromFetch.delete(key);
      } else {
        this.clear(key);
      }
      if (was !== this.isSignedOut(key)) changed.push(key);
    }
    return changed;
  }
}
