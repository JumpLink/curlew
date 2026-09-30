/**
 * The receive path: one authenticated Signal chat connection as a `DeliverySession`.
 *
 * Signal's server pushes the envelopes queued for this device and deletes each one once the device
 * acknowledges it. So the one rule this class exists for is the ORDER of a commit:
 *
 *   decrypt → journal (fsync) → protocol store (flush) → acknowledge
 *
 * An envelope is acknowledged only after what it said is on disk in the journal AND the ratchet
 * step its decryption took is in the session file. A crash anywhere before the acknowledgement
 * leaves the envelope on the server, and the next run gets it again: either it decrypts again
 * (the ratchet step was not saved — the journal replay and the redelivery write the same keyed
 * rows) or libsignal reports it as a duplicate (the step was saved), and it is only acknowledged.
 * Either way, nothing is lost and nothing is stored twice.
 *
 * Unlike WhatsApp's Baileys, libsignal does not acknowledge on its own — the acknowledgement is
 * ours to send — so this receiver has back-pressure for free: stopping early (the time cap, the
 * memory cap, `close`) leaves everything not yet committed on the server for the next sync.
 *
 * `catch-up` ends when the server says the queue that existed at connect time was delivered
 * (`onQueueEmpty`) and everything before that signal is committed; `follow` keeps going. A
 * dropped connection is reconnected up to `maxReconnects` times; the server redelivers what was
 * not acknowledged. A device the server no longer knows (unlinked on the phone) ends the session
 * with `loggedOut`, so a follow-mode caller (the daemon) stops the account instead of
 * reconnecting credentials the server has dropped.
 *
 * Envelopes that cannot be decrypted are acknowledged and counted — they would never decrypt on
 * a later run either, and postbote sends no retry request (`guard.ts`) — and the count is reported
 * as the session's error, so a sync that lost messages says so.
 *
 * A third way exists, and it used to be invisible. An envelope the decryptor declines on purpose
 * — addressed to the phone-number identity, a story this build cannot show — is acknowledged by
 * `drain()` exactly like a stored one, so it is gone from the network too. Those are counted in
 * `outcome().skipped`, by reason, and the two that can swallow a real message are reported; the
 * reasons that are just protocol traffic (a receipt, a retry request, our own echo) are counted
 * and stay quiet, because a report that cries wolf on a healthy run teaches the reader to ignore
 * the line that means trouble.
 *
 * Envelopes that DO decrypt are never dropped, even when nothing of them is understood: once the
 * ratchet has moved, the server's copy is one acknowledgement away from gone. So a plaintext this
 * build cannot parse, or content it does not know, goes into the account file's ledger
 * (`setAside`) — written by the same `flush()` as the ratchet state, before the acknowledgement —
 * and the outcome carries the count. A contact whose safety number changed is not swallowed
 * either: each change becomes a notice in the direct chat with that contact.
 */

import type { DeliveryEvent, DeliveryMode, DeliveryOutcome, DeliverySession } from '@postbote/protocol';
import type { AttachmentDownloader } from './contacts.ts';
import { readContactsSync } from './contacts.ts';
import type { DecryptResult, SkipReason } from './decrypt.ts';
import type { EventJournal } from './journal.ts';
import { type SignalMapper, peerOf } from './map.ts';
import { SET_ASIDE_LIMIT, type SetAsideEntry, toBase64 } from './protocol-store.ts';
import { type Content, decodeEnvelope, type Envelope } from './schema.ts';

/** What a notice about a contact's identity key says, in the conversation with that contact. */
export const SAFETY_NUMBER_CHANGED = 'Safety number changed';

/** The one `DecryptResult` that carries a decrypted plaintext. */
type Decrypted = Extract<DecryptResult, { kind: 'content' }>;

export const RELINK_HINT = 'link it again with `postbote accounts add signal`';

/** The acknowledgement handle of one delivered envelope (libsignal's `ChatServerMessageAck`). */
export interface EnvelopeAck {
  send(status: number): void;
}

/** What the receiver listens to — libsignal's `ChatServiceListener`, structurally. */
export interface ChatListenerLike {
  onIncomingMessage(envelope: Uint8Array, timestamp: number, ack: EnvelopeAck): void;
  onQueueEmpty(): void;
  onConnectionInterrupted(cause: Error | null): void;
}

/**
 * One open chat connection. No `fetch`: the sync holds no way to send a request (`guard.ts`).
 */
export interface ChatHandle {
  disconnect(): Promise<void>;
}

export type ChatConnector = (listener: ChatListenerLike) => Promise<ChatHandle>;

/** The decrypting side, injected so the receiver is testable around a real or scripted one. */
export interface EnvelopeDecryptorLike {
  decrypt(envelope: Envelope): Promise<DecryptResult>;
}

/** The protocol store's write step. */
export interface Flushable {
  /**
   * Keep a plaintext this build could not map, in the account's secret state. The next `flush()`
   * writes it with the ratchet state — the one `commit()` makes before acknowledging the envelope
   * it came from, so a plaintext Signal is about to forget is on disk first. Returns how many
   * older entries this call pushed out of the ledger's limit.
   */
  setAside(entry: SetAsideEntry): number;
  flush(): void;
}

/**
 * Why nothing of a decrypted content could be mapped, or null when it was understood — or when it
 * is content postbote deliberately does not show (typing, a disappearing-messages timer, a
 * reaction): those are dropped on purpose, not kept.
 *
 * Only what this build does not UNDERSTAND counts: a field a newer Signal added. A field it knows
 * but ignores (a reaction next to a body) is no loss, and a content whose body was mapped is in
 * the index whatever else it carries.
 */
function unmappedReason(result: Decrypted, mappedEvents: number): string | null {
  if (result.content === null) return result.parseError ?? 'the plaintext did not parse';
  if (mappedEvents > 0) return null;
  if (result.content.unknownFields.length > 0)
    return `content field(s) ${result.content.unknownFields.join(', ')} this postbote does not know`;
  const data = result.content.dataMessage;
  if (data && data.unknownFields.length > 0)
    return `data message field(s) ${data.unknownFields.join(', ')} this postbote does not know`;
  return null;
}

/**
 * A safety-number change as a notice in the direct chat with that contact: something Signal
 * reported about the conversation that nobody wrote. The contact is that chat's peer, so it shows
 * up under their name; the `notice` presentation says what it is.
 */
function safetyNumberNotice(aci: string, at: number): DeliveryEvent {
  return {
    type: 'message',
    chatRemoteId: aci,
    chatKind: 'direct',
    message: {
      remoteId: `identity:${aci}:${at}`,
      seq: at,
      sentAt: new Date(at).toISOString(),
      editedAt: null,
      sender: peerOf(aci),
      fromSelf: false,
      text: SAFETY_NUMBER_CHANGED,
      hasAttachments: false,
      replyToRemoteId: null,
      threadRemoteId: null,
      notice: true,
    },
    // Nobody waits for the network's own news: a notice is never unread.
    seen: true,
  };
}

export interface ReceiverOptions {
  mode: DeliveryMode;
  journal: EventJournal;
  /** Download for contact sync; without one, contact lists are skipped. */
  download?: AttachmentDownloader;
  /** Envelopes per commit — the journal fsync and the store write are per commit, not per envelope. */
  commitEvery?: number;
  /** The longest a `catch-up` run waits for the queue. */
  maxMs?: number;
  /** The most undecrypted envelopes held in memory; past it the session stops taking more. */
  maxQueued?: number;
  maxReconnects?: number;
  /** True when an error is the server saying this device is gone. */
  isDelinked?: (err: unknown) => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

type InboxItem =
  | { kind: 'envelope'; bytes: Uint8Array; ack: EnvelopeAck; generation: number }
  | { kind: 'queue-empty'; generation: number };

export class SignalReceiver implements DeliverySession {
  private readonly connector: ChatConnector;
  private readonly decryptor: EnvelopeDecryptorLike;
  private readonly mapper: SignalMapper;
  private readonly store: Flushable;
  private readonly journal: EventJournal;
  private readonly mode: DeliveryMode;
  private readonly download: AttachmentDownloader | null;
  private readonly commitEvery: number;
  private readonly maxMs: number;
  private readonly maxQueued: number;
  private readonly maxReconnects: number;
  private readonly isDelinked: (err: unknown) => boolean;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private handle: ChatHandle | null = null;
  /** Bumped per connection: an item from a dead connection cannot be acknowledged any more. */
  private generation = 0;
  private reconnects = 0;
  private inbox: InboxItem[] = [];
  private draining: Promise<void> | null = null;
  private pendingAcks: EnvelopeAck[] = [];
  private pendingEvents: DeliveryEvent[] = [];
  private queue: DeliveryEvent[] = [];
  private waiter: (() => void) | null = null;
  private stopping = false;
  private ended = false;
  private readonly endWaiters: Array<() => void> = [];
  private result: DeliveryOutcome = { caughtUp: false, error: null };
  /**
   * Set where the server says this device is gone (unlinked on the phone, or refused). The
   * error text alone would not do: `RequestUnauthorized` also covers a temporary refusal, and a
   * retried-but-dead account is a silent data-loss machine. Tracked here because the reason can
   * surface on two paths (a refused connect, an interrupted connection) and one `outcome()` call
   * has to report it.
   */
  private loggedOut = false;
  private caughtUp = false;
  private undecryptable = 0;
  /** The first decryption error of the run — reported with the count, never message content. */
  private firstFailure: string | null = null;
  /** Decrypted plaintexts this run could not map, now kept raw in the account file. */
  private setAside = 0;
  /** And how many of those the ledger's limit pushed out — data that is really gone. */
  private setAsideDropped = 0;
  /**
   * Envelopes this run acknowledged without turning into events, by reason.
   *
   * `drain()` pushes the ack whatever `process()` did, so a skip is not a harmless shrug: the
   * network is told "I have this" and never sends it again. Before this counter existed, a run
   * that dropped three envelopes and a run that received none looked identical — `added: 0,
   * error: null` — which makes every receiving bug unfindable after the fact.
   */
  // The decryptor's reasons plus this receiver's own one (`story`). A `duplicate` is deliberately
  // absent: that envelope IS already in the index, so counting it would report a loss that never
  // happened.
  private readonly skipped: Partial<Record<SkipReason | 'story', number>> = {};
  private contactsProblem: string | null = null;
  private maxTimer: unknown = null;
  private finishRequested: DeliveryOutcome | null = null;
  /** `close()` is idempotent — the store closes on abort and again in its finally. */
  private closed = false;
  private handedMark: number | null = null;

  constructor(
    connector: ChatConnector,
    decryptor: EnvelopeDecryptorLike,
    mapper: SignalMapper,
    store: Flushable,
    options: ReceiverOptions,
  ) {
    this.connector = connector;
    this.decryptor = decryptor;
    this.mapper = mapper;
    this.store = store;
    this.journal = options.journal;
    this.mode = options.mode;
    this.download = options.download ?? null;
    this.commitEvery = options.commitEvery ?? 50;
    this.maxMs = options.maxMs ?? 10 * 60_000;
    this.maxQueued = options.maxQueued ?? 5_000;
    this.maxReconnects = options.maxReconnects ?? 3;
    this.isDelinked = options.isDelinked ?? (() => false);
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Replay what a crashed run left, then connect. Resolves once the first connection is open. */
  async start(): Promise<void> {
    if (this.journal.recovered.length > 0) this.queue.push(...this.journal.recovered);
    if (this.mode === 'catch-up') {
      this.maxTimer = this.setTimer(() => void this.stop({ caughtUp: false, error: null }), this.maxMs);
    }
    await this.open();
  }

  private async open(): Promise<void> {
    const generation = ++this.generation;
    const listener: ChatListenerLike = {
      onIncomingMessage: (bytes, _timestamp, ack) => {
        if (generation !== this.generation || this.stopping) return; // not acknowledged: redelivered
        this.inbox.push({ kind: 'envelope', bytes, ack, generation });
        if (this.inbox.length > this.maxQueued) {
          void this.stop({ caughtUp: false, error: null });
          return;
        }
        this.kick();
      },
      onQueueEmpty: () => {
        if (generation !== this.generation) return;
        this.inbox.push({ kind: 'queue-empty', generation });
        this.kick();
      },
      onConnectionInterrupted: (cause) => {
        if (generation !== this.generation || this.stopping) return;
        this.handle = null;
        void this.interrupted(cause);
      },
    };
    try {
      this.handle = await this.connector(listener);
    } catch (err) {
      if (this.isDelinked(err)) this.loggedOut = true;
      await this.stop({ caughtUp: false, error: this.describe(err, 'the Signal connection failed') });
    }
  }

  private async interrupted(cause: Error | null): Promise<void> {
    // What arrived on the dead connection cannot be acknowledged: it will come again.
    this.inbox = [];
    if (this.isDelinked(cause)) this.loggedOut = true;
    if (this.isDelinked(cause) || this.reconnects >= this.maxReconnects) {
      await this.stop({ caughtUp: false, error: this.describe(cause, 'the Signal connection closed') });
      return;
    }
    this.reconnects++;
    await this.open();
  }

  private describe(err: unknown, fallback: string): string {
    if (this.isDelinked(err)) return `Signal no longer knows this device (it was unlinked) — ${RELINK_HINT}`;
    const text = err instanceof Error ? err.message : err ? String(err) : '';
    return text ? `${fallback}: ${text}` : fallback;
  }

  private kick(): void {
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
      const finish = this.finishRequested;
      if (finish) {
        this.finishRequested = null;
        void this.stop(finish);
      } else if (this.inbox.length > 0 && !this.stopping) this.kick();
    });
  }

  private async drain(): Promise<void> {
    while (this.inbox.length > 0 && !this.stopping) {
      const item = this.inbox.shift() as InboxItem;
      if (item.kind === 'queue-empty') {
        if (!this.commit()) return;
        this.caughtUp = true;
        if (this.mode === 'catch-up') {
          // Stopped from `kick` once this loop has returned: `stop` waits for the loop.
          this.finishRequested = { caughtUp: true, error: null };
          return;
        }
        continue;
      }
      await this.process(item);
      if (item.generation === this.generation) this.pendingAcks.push(item.ack);
      if (this.pendingAcks.length >= this.commitEvery && !this.commit()) return;
    }
    this.commit();
  }

  private async process(item: { bytes: Uint8Array }): Promise<void> {
    let envelope: Envelope;
    try {
      envelope = decodeEnvelope(item.bytes);
    } catch (err) {
      this.failed(err);
      return;
    }
    // A story is a message this build cannot show, and it is acknowledged below like any other
    // envelope — so it is counted, not shrugged.
    if (envelope.story) {
      this.countSkip('story');
      return;
    }
    let result: DecryptResult;
    try {
      result = await this.decryptor.decrypt(envelope);
    } catch (err) {
      this.failed(err);
      return;
    }
    if (result.kind === 'duplicate') {
      // Already decrypted in an earlier, unacknowledged run: the message IS in the index, and
      // counting it as skipped would report a loss that did not happen.
      return;
    }
    if (result.kind !== 'content') {
      this.countSkip(result.reason);
      return;
    }
    const at = envelope.clientTimestamp ?? envelope.serverTimestamp ?? Date.now();
    const mapped = result.content
      ? this.mapper.map(result.content, {
          senderAci: result.senderAci,
          timestamp: at,
          groupId: result.groupId,
        })
      : { events: [] as DeliveryEvent[], contactsBlob: null };
    this.pendingEvents.push(...mapped.events);
    // A changed safety number is news about the contact, not about the message: it belongs in
    // their conversation, once per change.
    for (const changed of result.identityChanged) this.pendingEvents.push(safetyNumberNotice(changed, at));
    this.keepUnmapped(result, mapped.events.length, at);
    if (mapped.contactsBlob) {
      if (!this.download) {
        this.contactsProblem = 'the contact list from the phone was not read (no downloader)';
      } else {
        try {
          this.pendingEvents.push(...(await readContactsSync(mapped.contactsBlob, this.download)));
          this.contactsProblem = null;
        } catch (err) {
          this.contactsProblem = `the contact list from the phone could not be read (${err instanceof Error ? err.message : String(err)})`;
        }
      }
    }
  }

  /** Count one acknowledged-but-unwritten envelope, by reason. */
  private countSkip(reason: SkipReason | 'story'): void {
    this.skipped[reason] = (this.skipped[reason] ?? 0) + 1;
  }

  private failed(err: unknown): void {
    this.undecryptable++;
    this.firstFailure ??= err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }

  /**
   * Keep a decrypted plaintext nothing was mapped from, in the account file.
   *
   * This is the one place where losing data is still avoidable: the ratchet has moved, so the
   * server forgets this envelope as soon as it is acknowledged, and the next postbote may well
   * understand the content. `setAside` only marks the entry — `commit()`'s `flush()`, before the
   * acknowledgement, writes it with the ratchet state. A ledger that was already full drops its
   * oldest entry, and the outcome says so rather than pretending nothing was lost.
   */
  private keepUnmapped(result: Decrypted, mappedEvents: number, at: number): void {
    const reason = unmappedReason(result, mappedEvents);
    if (reason === null) return;
    this.setAsideDropped += this.store.setAside({
      senderAci: result.senderAci,
      sentAt: new Date(at).toISOString(),
      reason,
      plaintext: toBase64(result.plaintext),
    });
    this.setAside++;
  }

  /**
   * Journal, flush, acknowledge — in that order. Returns false (and stops the session) when the
   * journal or the store cannot be written: then nothing is acknowledged, and the server keeps it.
   */
  private commit(): boolean {
    if (this.pendingAcks.length === 0 && this.pendingEvents.length === 0) return true;
    const events = this.pendingEvents;
    try {
      this.journal.append(events);
      this.store.flush();
    } catch (err) {
      this.pendingEvents = [];
      this.pendingAcks = [];
      void this.stop({
        caughtUp: false,
        error: `the receive journal or the session file cannot be written (${err instanceof Error ? err.message : String(err)}) — nothing was acknowledged`,
      });
      return false;
    }
    this.pendingEvents = [];
    const acks = this.pendingAcks;
    this.pendingAcks = [];
    for (const ack of acks) {
      try {
        ack.send(200);
      } catch {
        // The connection went away: the server redelivers, and the redelivery is a duplicate.
      }
    }
    if (events.length > 0) {
      this.queue.push(...events);
      this.wake();
    }
    return true;
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  /** Stop taking envelopes, commit what was processed, disconnect, end. */
  private async stop(outcome: DeliveryOutcome): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.result = outcome;
    if (this.maxTimer !== null) this.clearTimer(this.maxTimer);
    this.maxTimer = null;
    // Let an envelope being decrypted finish, so its ratchet step and its events commit together.
    if (this.draining) await this.draining.catch(() => undefined);
    this.commit();
    const handle = this.handle;
    this.handle = null;
    this.generation++;
    if (handle) await handle.disconnect().catch(() => undefined);
    this.ended = true;
    this.wake();
    for (const resolve of this.endWaiters.splice(0)) resolve();
  }

  async nextBatch(): Promise<DeliveryEvent[] | null> {
    // Being asked again means the previous batch is committed to the index: drop it.
    if (this.handedMark !== null) {
      this.journal.release(this.handedMark);
      this.handedMark = null;
    }
    for (;;) {
      if (this.queue.length > 0) {
        const batch = this.queue;
        this.queue = [];
        this.handedMark = this.journal.size();
        return batch;
      }
      if (this.ended) return null;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }

  outcome(): DeliveryOutcome {
    const problems = [this.result.error];
    if (this.undecryptable > 0) {
      problems.push(
        `${this.undecryptable} envelope(s) could not be decrypted and were dropped (Signal keeps no copy; the phone still has them) — first: ${this.firstFailure}`,
      );
    }
    if (this.setAsideDropped > 0) {
      problems.push(
        `${this.setAsideDropped} plaintext(s) postbote could not read were pushed out of the session file's ledger (it keeps the newest ${SET_ASIDE_LIMIT}) — those are gone`,
      );
    }
    // Loudness follows the consequence, not the count (ADR 0003). A server receipt, a retry
    // request and our own echo are the protocol doing its job: counted, never reported, because
    // a report that cries wolf on healthy traffic teaches the reader to skip the line that does
    // mean trouble. Two reasons are different — the envelope was acknowledged, so nothing will
    // send it again, and nobody can afterwards say whether a readable message was inside.
    const unread = this.skipped['phone-number-identity'] ?? 0;
    if (unread > 0) {
      problems.push(
        `${unread} envelope(s) were addressed to the phone-number identity, which this device holds no key for, and were acknowledged unread — the server will not send them again, and whether a readable message was among them is unknown`,
      );
    }
    const stories = this.skipped['story'] ?? 0;
    if (stories > 0) {
      problems.push(
        `${stories} story message(s) postbote cannot show were acknowledged and dropped (a known gap: it stores text, not media)`,
      );
    }
    if (this.contactsProblem) problems.push(this.contactsProblem);
    const error = problems.filter(Boolean).join('; ') || null;
    return {
      caughtUp: this.result.caughtUp || (this.mode === 'follow' && this.caughtUp),
      error,
      ...(this.loggedOut ? { loggedOut: true } : {}),
      ...(this.setAside > 0 ? { setAside: this.setAside } : {}),
      ...(this.undecryptable > 0 ? { undecryptable: this.undecryptable } : {}),
      ...(Object.keys(this.skipped).length > 0 ? { skipped: { ...this.skipped } } : {}),
    };
  }

  async close(): Promise<void> {
    // Idempotent: a caller that closes on abort and closes again in a finally (the store's
    // receive path does) must not close the journal's descriptor twice.
    if (this.closed) return;
    this.closed = true;
    await this.stop({ caughtUp: this.result.caughtUp, error: this.result.error });
    if (!this.ended) await new Promise<void>((resolve) => this.endWaiters.push(resolve));
    // Not released here: without a further `nextBatch()` the last batch may not be written.
    this.journal.close();
  }
}
