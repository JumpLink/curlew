/**
 * Follow mode for a granted XMPP account (ADR 0004 §5), run by `curlew daemon`.
 *
 * The connection is held open with carbons on and a negative-priority presence, so the server
 * routes the person's chat to it. A stanza is only a WAKE-UP, though: the archive (MAM) is the
 * truth, and every wake-up runs the same `syncChats` that `curlew sync` runs, over the link that
 * is already open. So a reply is written through one path whether it arrived live, was missed
 * while the link was down, or came in while a sync was running. Wake-ups are coalesced and
 * rate-limited: a burst is one catch-up, never one per stanza.
 *
 * Per account: take the receive lease (ADR 0002 §4) before connecting, refresh it while running,
 * reconnect with backoff, release it on stop. Log lines carry names and counts, never text.
 */

import type { ChatBackend } from '@curlew/protocol';
import {
  type IndexDatabase,
  LEASE_HEARTBEAT_MS,
  RECONNECT_CAP_MS,
  RECONNECT_FIRST_MS,
  refreshReceiveLease,
  releaseReceiveLease,
  syncChats,
  takeReceiveLease,
} from '@curlew/store';
import type { GrantedXmppSession, SendPermit } from '@curlew/xmpp';
import { appendWriteLog } from '../write-log.ts';
import { SEND_CAPABILITY } from './send.ts';

/** The least time between two catch-ups of one account. */
export const FOLLOW_MIN_GAP_MS = 1_000;

export interface FollowDeps {
  db: IndexDatabase;
  /** The chat backend whose accounts are followed; its own `connect` is never used here. */
  backend: ChatBackend;
  /** Opens the granted session of one account. */
  open: (accountId: string, permit: SendPermit) => Promise<GrantedXmppSession>;
  permit: SendPermit;
  signal: AbortSignal;
  log: (line: string) => void;
  /** Called after anything was written, so the conversations get rebuilt. */
  onWrite: () => void;
  holder: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  leaseIntervalMs?: number;
  minGapMs?: number;
  writeLogPath?: string;
}

export interface FollowResult {
  accountId: string;
  catchUps: number;
  added: number;
  /** Set when following ended for another reason than the stop signal. */
  error: string | null;
  heldBy: string | null;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Follow one account until `deps.signal` aborts. Never throws: the outcome is the result. */
export async function followAccount(deps: FollowDeps): Promise<FollowResult> {
  const { db, backend, signal, log, permit } = deps;
  const accountId = permit.account;
  const who = `xmpp/${accountId}`;
  const now = deps.now ?? (() => new Date());
  const interval = deps.leaseIntervalMs ?? LEASE_HEARTBEAT_MS;
  const sleep = deps.sleep ?? ((ms: number) => abortableSleep(ms, signal));
  const minGap = deps.minGapMs ?? FOLLOW_MIN_GAP_MS;
  const result: FollowResult = { accountId, catchUps: 0, added: 0, error: null, heldBy: null };

  // The lease first: a `sync` on the same account stands down while a daemon holds it.
  let waitingFor: string | null = null;
  for (;;) {
    if (signal.aborted) return result;
    let acquired = false;
    let holder: string | null = null;
    try {
      const take = takeReceiveLease(db, 'xmpp', accountId, deps.holder, now(), interval);
      acquired = take.acquired;
      holder = take.acquired ? null : take.holder;
    } catch {
      // The index was busy: not knowing who holds the account is the same as not holding it.
    }
    if (acquired) break;
    if (holder !== waitingFor) {
      waitingFor = holder;
      log(`curlew-daemon: ${who} is held by ${holder ?? 'another process'} — waiting for the lease`);
    }
    await sleep(interval);
  }

  let leaseLost = false;
  const stopAccount = new AbortController();
  const heartbeat = setInterval(() => {
    try {
      if (!refreshReceiveLease(db, 'xmpp', accountId, deps.holder, now(), interval)) leaseLost = true;
    } catch {
      leaseLost = true;
    }
    if (leaseLost) {
      clearInterval(heartbeat);
      log(`curlew-daemon: ${who} lost the receive lease — stopping that account`);
      stopAccount.abort();
    }
  }, interval);
  const stop = (): void => stopAccount.abort();
  signal.addEventListener('abort', stop, { once: true });
  const live = stopAccount.signal;

  // The catch-up runs over the open link, not a new connection.
  let wait = RECONNECT_FIRST_MS;
  let attempt = 0;
  try {
    while (!live.aborted) {
      let session: GrantedXmppSession | null = null;
      const openedAt = now().getTime();
      try {
        session = await deps.open(accountId, permit);
        const link = session;
        const overLink: ChatBackend = {
          manifest: backend.manifest,
          kind: 'chat',
          listAccounts: () => backend.listAccounts(),
          connect: async () => link.chatSession(),
        };

        let running = false;
        let again = false;
        let lastEnd = 0;
        const catchUp = async (): Promise<void> => {
          if (running) {
            again = true;
            return;
          }
          running = true;
          try {
            do {
              again = false;
              const gap = lastEnd + minGap - Date.now();
              if (gap > 0) await sleep(gap);
              if (live.aborted) return;
              const done = await syncChats(db, overLink, { accountId });
              lastEnd = Date.now();
              result.catchUps += 1;
              result.added += done.added;
              if (done.added > 0 || done.removed > 0) {
                log(`curlew-daemon: ${who} catch-up wrote ${done.added} added, ${done.removed} removed`);
                deps.onWrite();
              }
              const failure = done.accounts.find((a) => a.error !== null)?.error;
              if (failure) log(`curlew-daemon: ${who} catch-up failed: ${failure}`);
            } while (again && !live.aborted);
          } finally {
            running = false;
          }
        };

        const closed = new Promise<string>((resolve) => {
          session?.onClosed(resolve);
          live.addEventListener('abort', () => resolve('stopped'), { once: true });
        });
        const unsubscribe = session.onArrival(() => {
          void catchUp().catch((err: unknown) =>
            log(`curlew-daemon: ${who} catch-up failed: ${errText(err)}`),
          );
        });

        await session.goAvailable();
        appendWriteLog(
          {
            capability: SEND_CAPABILITY,
            target: accountId,
            frontend: 'daemon',
            note: 'presence available',
          },
          { path: deps.writeLogPath },
        );
        log(`curlew-daemon: ${who} connected`);
        attempt = 0;
        await catchUp();
        const reason = await closed;
        unsubscribe();
        if (live.aborted) break;
        throw new Error(reason);
      } catch (err) {
        if (live.aborted) break;
        attempt += 1;
        if (now().getTime() - openedAt >= RECONNECT_CAP_MS) wait = RECONNECT_FIRST_MS;
        log(`curlew-daemon: ${who} reconnect in ${wait} ms (attempt ${attempt}, ${errText(err)})`);
        await abortableSleepOr(sleep, wait, live);
        wait = Math.min(wait * 2, RECONNECT_CAP_MS);
      } finally {
        if (session) await session.close().catch(() => {});
      }
    }
  } finally {
    clearInterval(heartbeat);
    signal.removeEventListener('abort', stop);
    try {
      releaseReceiveLease(db, 'xmpp', accountId, deps.holder);
    } catch {
      // A busy index leaves the lease to expire on its own.
    }
    log(`curlew-daemon: ${who} stopped (${signal.aborted ? 'aborted' : leaseLost ? 'lease lost' : 'ended'})`);
  }
  if (leaseLost) result.error = 'lost the receive lease';
  return result;
}

/** A sleep that also ends when the account is stopped. */
async function abortableSleepOr(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  live: AbortSignal,
): Promise<void> {
  await Promise.race([sleep(ms), abortableSleep(ms + 1, live)]);
}
