/**
 * The person's mute and favourite flags per conversation (schema v30, ADR 0020).
 *
 * A table of its own, not columns on `conversations`: the mail rebuild replaces every conversation
 * row and a sync rewrites it, so nothing a sync writes may hold state that only exists here.
 * The local half (`muted`, `favourite`) is what the window and the daemon read; the `remote_*`
 * half mirrors what the network last reported and is never a prerequisite. A flag whose write has
 * not been acknowledged carries a `*_pending_at`.
 */

import { appendChanges } from './changes.ts';
import type { IndexDatabase } from './db.ts';
import { withTransaction } from './db.ts';

export interface ChatFlags {
  conversationId: string;
  muted: boolean;
  /** Absolute instant; null with `muted` = until unmuted. */
  mutedUntil: string | null;
  mutedAt: string | null;
  favourite: boolean;
  favouriteAt: string | null;
  mutePendingAt: string | null;
  favouritePendingAt: string | null;
  /** The last mute state the network reported; null = never seen. */
  remoteMuted: boolean | null;
  remoteMutedUntil: string | null;
  remoteFavourite: boolean | null;
  remoteAt: string | null;
}

const COLUMNS = `conversation_id, muted, muted_until, muted_at, favourite, favourite_at,
  mute_pending_at, favourite_pending_at, remote_muted, remote_muted_until, remote_favourite, remote_at`;

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const tri = (v: unknown): boolean | null => (v === null || v === undefined ? null : Number(v) === 1);

function fromRow(r: Record<string, unknown>): ChatFlags {
  return {
    conversationId: String(r.conversation_id),
    muted: Number(r.muted) === 1,
    mutedUntil: text(r.muted_until),
    mutedAt: text(r.muted_at),
    favourite: Number(r.favourite) === 1,
    favouriteAt: text(r.favourite_at),
    mutePendingAt: text(r.mute_pending_at),
    favouritePendingAt: text(r.favourite_pending_at),
    remoteMuted: tri(r.remote_muted),
    remoteMutedUntil: text(r.remote_muted_until),
    remoteFavourite: tri(r.remote_favourite),
    remoteAt: text(r.remote_at),
  };
}

/** Is the mute in force at `now`? A mute with a past `mutedUntil` has lapsed, whatever the column says. */
export function isMutedAt(flags: Pick<ChatFlags, 'muted' | 'mutedUntil'> | null | undefined, now: Date = new Date()): boolean {
  if (!flags || !flags.muted) return false;
  if (flags.mutedUntil === null) return true;
  const until = Date.parse(flags.mutedUntil);
  return Number.isNaN(until) ? true : until > now.getTime();
}

export function loadChatFlags(db: IndexDatabase, conversationId: string): ChatFlags | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM conversation_flags WHERE conversation_id = ?`).get(conversationId) as
    | Record<string, unknown>
    | undefined;
  return row === undefined ? null : fromRow(row);
}

/** Every conversation with a flag row. */
export function loadAllChatFlags(db: IndexDatabase): Map<string, ChatFlags> {
  const rows = db.prepare(`SELECT ${COLUMNS} FROM conversation_flags`).all() as Array<Record<string, unknown>>;
  const out = new Map<string, ChatFlags>();
  for (const r of rows) {
    const flags = fromRow(r);
    out.set(flags.conversationId, flags);
  }
  return out;
}

/** Conversations whose mute has a deadline, for the local timer of a protocol with no expiry. */
export function listTimedMutes(db: IndexDatabase): ChatFlags[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM conversation_flags WHERE muted = 1 AND muted_until IS NOT NULL`)
    .all() as Array<Record<string, unknown>>;
  return rows.map(fromRow);
}

function header(db: IndexDatabase, conversationId: string): { backend: string; accountId: string } | null {
  const row = db.prepare('SELECT backend, account_id FROM conversations WHERE id = ?').get(conversationId) as
    | Record<string, unknown>
    | undefined;
  return row === undefined ? null : { backend: String(row.backend), accountId: String(row.account_id) };
}

function ensureRow(db: IndexDatabase, conversationId: string): void {
  db.prepare('INSERT OR IGNORE INTO conversation_flags (conversation_id) VALUES (?)').run(conversationId);
}

function journal(db: IndexDatabase, conversationId: string): void {
  const head = header(db, conversationId);
  appendChanges(db, [
    {
      kind: 'conversations',
      backend: head?.backend ?? null,
      accountId: head?.accountId ?? null,
      conversationId,
    },
  ]);
}

export interface SetMuteInput {
  muted: boolean;
  /** Absolute instant the mute ends; omitted = until unmuted. Ignored when `muted` is false. */
  until?: string | null;
  /** The write will be pushed to the network, so it waits for an acknowledgement. */
  pending?: boolean;
  now?: Date;
}

/**
 * The person (un)muted a conversation here. Sets the local flag and, when it is going to be
 * pushed, its pending mark; journals the change. Returns false for a conversation the index does
 * not hold.
 */
export function setChatMuted(db: IndexDatabase, conversationId: string, input: SetMuteInput): boolean {
  return withTransaction(db, () => {
    if (header(db, conversationId) === null) return false;
    const at = (input.now ?? new Date()).toISOString();
    ensureRow(db, conversationId);
    db.prepare(
      `UPDATE conversation_flags SET muted = ?, muted_until = ?, muted_at = ?, mute_pending_at = ?
        WHERE conversation_id = ?`,
    ).run(input.muted ? 1 : 0, input.muted ? (input.until ?? null) : null, at, input.pending ? at : null, conversationId);
    journal(db, conversationId);
    return true;
  });
}

export interface SetFavouriteInput {
  favourite: boolean;
  pending?: boolean;
  now?: Date;
}

export function setChatFavourite(db: IndexDatabase, conversationId: string, input: SetFavouriteInput): boolean {
  return withTransaction(db, () => {
    if (header(db, conversationId) === null) return false;
    const at = (input.now ?? new Date()).toISOString();
    ensureRow(db, conversationId);
    db.prepare(
      `UPDATE conversation_flags SET favourite = ?, favourite_at = ?, favourite_pending_at = ?
        WHERE conversation_id = ?`,
    ).run(input.favourite ? 1 : 0, at, input.pending ? at : null, conversationId);
    journal(db, conversationId);
    return true;
  });
}

/** What the network reported for a conversation's mute. */
export interface RemoteMute {
  muted: boolean;
  /** Absent: the network has no expiry, so only `muted` is compared and a local timer is kept. */
  until?: string | null;
}

/**
 * What to do with a reported state (ADR 0020 §4), decided without touching the database.
 *
 * - `echo`: the network reports what we wrote — clear the pending mark, keep the local value.
 * - `retry`: it reports something else while our write is pending, and we have not retried yet.
 * - `take-remote`: it still disagrees after the retry — the network's state is the one the
 *   person's phone shows, so it wins and the pending mark clears.
 * - `apply`: nothing pending and the remote is newer than the local change — take it.
 * - `keep`: nothing pending and the local change is newer (or they agree) — leave the local value.
 */
export type FlagResolution = 'echo' | 'retry' | 'take-remote' | 'apply' | 'keep';

export interface ResolveInput<T> {
  local: T;
  remote: T;
  /** `*_pending_at` of the field; null = nothing pending. */
  pendingAt: string | null;
  /** `muted_at` / `favourite_at`: when the person set it here. */
  localAt: string | null;
  /** When the remote state was read (our clock). */
  remoteAt: string;
  /** The write was already pushed a second time. */
  retried: boolean;
  equal: (a: T, b: T) => boolean;
}

export function resolveFlag<T>(input: ResolveInput<T>): FlagResolution {
  const same = input.equal(input.local, input.remote);
  if (input.pendingAt !== null) {
    if (same) return 'echo';
    return input.retried ? 'take-remote' : 'retry';
  }
  if (same) return 'keep';
  if (input.localAt === null) return 'apply';
  const local = Date.parse(input.localAt);
  const remote = Date.parse(input.remoteAt);
  if (Number.isNaN(local) || Number.isNaN(remote)) return 'apply';
  return remote >= local ? 'apply' : 'keep';
}

const sameMute = (a: RemoteMute, b: RemoteMute): boolean => {
  if (a.muted !== b.muted) return false;
  if (!a.muted) return true;
  if (a.until === undefined || b.until === undefined) return true;
  return a.until === b.until || (a.until !== null && b.until !== null && Date.parse(a.until) === Date.parse(b.until));
};

export interface RemoteMuteOutcome {
  resolution: FlagResolution;
}

/**
 * Record the mute state the network reported. The `remote_*` mirror is always filled; the local
 * flag changes only as `resolveFlag` says and only when `apply` (the sync setting) is on —
 * otherwise nothing local moves and a later turn-on shows the difference (ADR 0020 §3).
 * A `retry` leaves the pending mark in place: the caller pushes again and reports once more
 * with `retried: true`.
 */
export function applyRemoteMute(
  db: IndexDatabase,
  conversationId: string,
  remote: RemoteMute,
  options: { apply: boolean; retried?: boolean; now?: Date } = { apply: true },
): RemoteMuteOutcome | null {
  return withTransaction(db, () => {
    if (header(db, conversationId) === null) return null;
    const at = (options.now ?? new Date()).toISOString();
    ensureRow(db, conversationId);
    const current = loadChatFlags(db, conversationId)!;
    const mirror = (): void => {
      db.prepare(
        'UPDATE conversation_flags SET remote_muted = ?, remote_muted_until = ?, remote_at = ? WHERE conversation_id = ?',
      ).run(remote.muted ? 1 : 0, remote.muted ? (remote.until ?? null) : null, at, conversationId);
    };
    mirror();
    if (!options.apply) return { resolution: 'keep' as const };
    const resolution = resolveFlag<RemoteMute>({
      local: { muted: current.muted, until: current.mutedUntil },
      remote,
      pendingAt: current.mutePendingAt,
      localAt: current.mutedAt,
      remoteAt: at,
      retried: options.retried ?? false,
      equal: sameMute,
    });
    if (resolution === 'echo') {
      db.prepare('UPDATE conversation_flags SET mute_pending_at = NULL WHERE conversation_id = ?').run(conversationId);
    } else if (resolution === 'take-remote' || resolution === 'apply') {
      db.prepare(
        `UPDATE conversation_flags SET muted = ?, muted_until = ?, muted_at = ?, mute_pending_at = NULL
          WHERE conversation_id = ?`,
      ).run(remote.muted ? 1 : 0, remote.muted ? (remote.until ?? null) : null, at, conversationId);
      journal(db, conversationId);
    }
    return { resolution };
  });
}

/** Same as `applyRemoteMute`, for the favourite flag. */
export function applyRemoteFavourite(
  db: IndexDatabase,
  conversationId: string,
  remote: boolean,
  options: { apply: boolean; retried?: boolean; now?: Date } = { apply: true },
): RemoteMuteOutcome | null {
  return withTransaction(db, () => {
    if (header(db, conversationId) === null) return null;
    const at = (options.now ?? new Date()).toISOString();
    ensureRow(db, conversationId);
    const current = loadChatFlags(db, conversationId)!;
    db.prepare('UPDATE conversation_flags SET remote_favourite = ?, remote_at = ? WHERE conversation_id = ?').run(
      remote ? 1 : 0,
      at,
      conversationId,
    );
    if (!options.apply) return { resolution: 'keep' as const };
    const resolution = resolveFlag<boolean>({
      local: current.favourite,
      remote,
      pendingAt: current.favouritePendingAt,
      localAt: current.favouriteAt,
      remoteAt: at,
      retried: options.retried ?? false,
      equal: (a, b) => a === b,
    });
    // A network that repeats what it said before has no news for a star the person set here: one that
    // did not fit its pin limit (ADR 0020 §6) stays local instead of being taken back by the next sync.
    if (resolution === 'apply' && current.favouriteAt !== null && current.remoteFavourite === remote) return { resolution: 'keep' as const };
    if (resolution === 'echo') {
      db.prepare('UPDATE conversation_flags SET favourite_pending_at = NULL WHERE conversation_id = ?').run(
        conversationId,
      );
    } else if (resolution === 'take-remote' || resolution === 'apply') {
      db.prepare(
        `UPDATE conversation_flags SET favourite = ?, favourite_at = ?, favourite_pending_at = NULL
          WHERE conversation_id = ?`,
      ).run(remote ? 1 : 0, at, conversationId);
      journal(db, conversationId);
    }
    return { resolution };
  });
}

/** Clear a pending mark without changing the value (the push failed for good, e.g. no capability). */
export function clearFlagPending(db: IndexDatabase, conversationId: string, field: 'mute' | 'favourite'): void {
  const column = field === 'mute' ? 'mute_pending_at' : 'favourite_pending_at';
  db.prepare(`UPDATE conversation_flags SET ${column} = NULL WHERE conversation_id = ?`).run(conversationId);
}
