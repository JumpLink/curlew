/**
 * Decrypting a page of archived messages before it becomes a `ChatHistoryPage` (ADR 0006 §8).
 *
 * ## Why there is a journal
 *
 * The ADR asks for one order: **decrypt → write the index row → commit the ratchet step**, so
 * that a crash in between re-decrypts rather than loses. Curlew's layering does not allow it
 * literally — `ChatSession.fetchHistory` hands a page back and the sync engine writes the rows
 * much later, in a different package and a different file — so the ratchet would have to commit
 * long before the row exists.
 *
 * What commits inside the ratchet transaction instead is a **plaintext journal entry**, keyed by
 * archive id, in the same account file (ADR 0006 §3's `state` tier covers it). It plays the part
 * the index row plays in the ADR: after the transaction there is a readable copy that no longer
 * depends on the session. If the process dies before the index is written, the next catch-up
 * re-fetches the same archive ids and {@link decryptEntries} answers them from the journal
 * without touching the ratchet at all. Entries older than {@link JOURNAL_RETENTION_MS} are
 * pruned, because by then the index write either happened or never will.
 *
 * ## What a pass does and does not do
 *
 * Pure book-keeping over `@curlew/omemo` and the storage port: no stanza is sent from here, so a
 * pass needs no grant beyond the one that opened the account file. Entries are decrypted in
 * ARCHIVE ORDER, and prekey deletion is deferred across the whole pass (§8): one prekey can
 * appear in several archived key exchanges, and deleting it on the first would turn every later
 * one into `no-session`.
 */

import {
  formatFingerprint,
  fromBase64,
  type DeviceId,
  type OmemoProfile,
  type OmemoStorage,
  type RandomSource,
  type TrustState,
} from '@curlew/omemo';
import { MESSAGES } from './messages.ts';
import { deleteConsumedPreKeys, type OwnDevice } from './omemo-device.ts';
import { parseEncryptedElement } from './omemo-stanza.ts';
import { noteSenderDevice, receiveOmemo, type UndecryptableReason } from './omemo-receive.ts';
import { type ArchivedEntry, bareJid } from './stanza.ts';

/**
 * How long a decrypted body stays in the journal.
 *
 * Long enough to outlive a crash and a weekend without a sync, short enough that the account
 * file does not become a second message archive. A journal entry is a duplicate of a row the
 * index is about to hold, not a store in its own right.
 */
export const JOURNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** A decrypted body held until the index has it. */
export interface JournalEntry {
  /** The plaintext, or null for a keys-only message that said nothing. */
  readonly text: string | null;
  readonly senderDeviceId: DeviceId;
  readonly trust: TrustState;
  /** When it was decrypted, ISO-8601 — what {@link PlaintextJournal.prunePlaintext} compares. */
  readonly at: string;
}

/**
 * The journal half of the account file, kept out of {@link OmemoStorage} on purpose: it is
 * curlew's crash-safety device, not something `@curlew/omemo` knows or needs.
 */
export interface PlaintextJournal {
  loadPlaintext(archiveId: string): Promise<JournalEntry | undefined>;
  savePlaintext(archiveId: string, entry: JournalEntry): Promise<void>;
  /** Drop every entry decrypted before `before` (ISO-8601). */
  prunePlaintext(before: string): Promise<void>;
}

export interface DecryptPassOptions {
  readonly profile?: OmemoProfile;
  readonly random?: RandomSource;
  readonly now?: () => Date;
  /**
   * Called for each message that stayed closed, in archive order.
   *
   * The reason is not stored with the row yet (`ChatMessage` has no field for it), so this is
   * what a caller uses to count or log them.
   */
  readonly onUndecryptable?: (entry: ArchivedEntry, reason: UndecryptableReason) => void;
  /**
   * Answer from the journal only, never from the ratchet — for entries the session has already
   * moved past.
   *
   * A lookback window is the case: those messages are OLDER than the page and were decrypted on
   * an earlier run, so stepping the ratchet over them again would at best report a duplicate and
   * at worst be a ratchet running backwards. What the journal still holds is returned; the rest
   * stays encrypted, which costs a quote inference and nothing else.
   */
  readonly journalOnly?: boolean;
}

/**
 * A page with every readable OMEMO message replaced by its plaintext.
 *
 * The returned entries are what `buildPage` should see: a decrypted one carries its text in
 * `body` with `encrypted` cleared, so it is indexed like any other message, and one that stayed
 * closed is returned untouched, so `buildPage` still files it as an encrypted message with no
 * text. The input is never mutated.
 *
 * `selfJid` is the account's own bare JID, used only for an entry with no `from` — the archive's
 * way of saying "you sent this".
 */
export async function decryptEntries(
  storage: OmemoStorage & PlaintextJournal,
  device: OwnDevice,
  selfJid: string,
  entries: readonly ArchivedEntry[],
  options: DecryptPassOptions = {},
): Promise<ArchivedEntry[]> {
  const now = options.now ?? (() => new Date());
  const out: ArchivedEntry[] = [];
  let consumedPreKeys = false;

  for (const entry of entries) {
    if (entry.omemo === null) {
      out.push(entry);
      continue;
    }
    if (entry.omemo.version === 'v2') {
      // Recognised, not read (ADR 0006 §1): indexed as an encrypted message so that the
      // conversation shows something happened here.
      options.onUndecryptable?.(entry, 'v2');
      out.push(entry);
      continue;
    }

    const journalled = await storage.loadPlaintext(entry.archiveId);
    if (journalled !== undefined) {
      out.push(decrypted(entry, journalled.text));
      continue;
    }

    if (options.journalOnly === true) {
      out.push(entry);
      continue;
    }

    const stanza = parseEncryptedElement(entry.omemo.element);
    if (stanza === undefined) {
      options.onUndecryptable?.(entry, 'malformed');
      out.push(entry);
      continue;
    }

    const senderJid = entry.from === null ? selfJid : bareJid(entry.from);
    const outcome = await receiveOmemo(storage, device, senderJid, stanza, {
      ...(options.profile === undefined ? {} : { profile: options.profile }),
      ...(options.random === undefined ? {} : { random: options.random }),
      now,
      deferPreKeyDeletion: true,
      // Inside the ratchet transaction: see the module comment. A throw here rolls the step
      // back, and the message is decrypted again next time rather than lost.
      commit: async (result) => {
        await storage.savePlaintext(entry.archiveId, {
          text: result.text,
          senderDeviceId: result.senderDeviceId,
          trust: result.trust,
          at: now().toISOString(),
        });
      },
    });

    if (outcome.kind === 'decrypted') {
      consumedPreKeys = true;
      await noteSenderDevice(storage, senderJid, outcome.senderDeviceId);
      if (outcome.identity === 'replaced') {
        const notice = await identityNotice(storage, entry, senderJid, outcome.senderDeviceId);
        if (notice !== undefined) out.push(notice);
      }
      out.push(decrypted(entry, outcome.text));
    } else {
      options.onUndecryptable?.(entry, outcome.reason);
      out.push(entry);
    }
  }

  // Only now that no later entry can need them (§8).
  if (consumedPreKeys) await deleteConsumedPreKeys(storage);
  await storage.prunePlaintext(new Date(now().getTime() - JOURNAL_RETENTION_MS).toISOString());
  return out;
}

/**
 * The entry as it should be indexed once its text is known.
 *
 * `encrypted` is cleared because the flag means "the body is only a fallback", which stops being
 * true here. A keys-only message ends up with no body and no flag, which is exactly how
 * `buildPage` drops it: a session set-up is not a message anyone wrote.
 */
function decrypted(entry: ArchivedEntry, text: string | null): ArchivedEntry {
  return { ...entry, body: text, encrypted: false, omemo: null };
}

/**
 * The line that goes into the conversation when a device's identity key has CHANGED (§6).
 *
 * "Never silent" is the rule, and a log line is silent: the person reads their chats, not
 * curlew's journal. So the change becomes an entry of the page, just before the message that
 * proved the new key — a notice rather than a message, which is what `ChatMessage.notice` is for.
 *
 * It names the new fingerprint, read back from storage because `noteIdentity` has just written
 * it there and `DecryptedMessage` carries no key. Undefined when that read finds nothing to
 * print: a notice that cannot say WHICH key is now in use is not worth a row.
 *
 * Written once. A re-fetch of the same archive id is answered from the journal, which has the
 * body and no identity outcome, so the notice is not repeated — and is lost if the index write
 * never happened. That is the right trade: a duplicate notice on every catch-up would teach the
 * person to ignore the one that matters.
 */
async function identityNotice(
  storage: OmemoStorage,
  entry: ArchivedEntry,
  senderJid: string,
  deviceId: DeviceId,
): Promise<ArchivedEntry | undefined> {
  const identity = await storage.loadIdentity({ jid: senderJid, deviceId });
  if (identity === undefined) return undefined;
  let printed: string;
  try {
    printed = formatFingerprint(fromBase64(identity.publicKey));
  } catch {
    return undefined;
  }
  return {
    ...entry,
    // Prefixed, so it cannot be mistaken for an id the archive would answer a query about.
    archiveId: `identity:${deviceId}:${entry.archiveId}`,
    // One millisecond EARLIER, which is both true (the key changed before the message proved it)
    // and what keeps the carrying message's seq where a page without a notice would put it:
    // `assignSeqs` walks forward from the previous seq, so a notice sharing the stamp would push
    // the real message to stamp + 1 and move a read marker's target under it.
    stampMs: entry.stampMs === null ? null : entry.stampMs - 1,
    body: MESSAGES.omemoIdentityChanged(senderJid, printed),
    encrypted: false,
    omemo: null,
    notice: true,
    // Nothing of the carrying message's identity: a notice corrects nothing, replies to
    // nothing, and must not be found as the target of either.
    id: null,
    originId: null,
    replaceId: null,
    replyToId: null,
    retract: null,
    tombstone: false,
    attachmentUrls: [],
  };
}
