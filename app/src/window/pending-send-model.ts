/**
 * Sends the network has not answered yet (ADR 0021): the three states, the bubble a pending send
 * is shown as, and the matching that decides when the real message has taken its place.
 *
 * Pure. No widget, no database, no clock of its own — which is what makes the duplicate and loss
 * cases testable on Node as well as GJS.
 */

import { _ } from '@curlew/protocol';
import type { ReplyTarget } from '@curlew/protocol';

import type { PickedFile } from './composer-files-model.ts';
import type { AttachmentInfo, ShownMessage } from './conversation-model.ts';

/** The id a pending bubble is built under. No real message id can collide: the networks' ids never carry it. */
export const PENDING_PREFIX = 'pending:';

/**
 * `pending` while the send is on its way, `failed` once it is not. There is no `confirmed` state:
 * a confirmed send is the index's row, and the entry is gone (§3).
 */
export type PendingSendState = 'pending' | 'failed';

/** One send in flight, held in the window's memory and keyed by the client id it goes out under. */
export interface PendingSend<Choice = unknown> {
  /** What the window minted and handed down to `sendMessage` (§2). */
  clientId: string;
  /** The carrier the person picked, so Retry sends the same message the same way. */
  choice: Choice;
  /** For the bubble's protocol badge, divider and ref; `choice` is opaque here. */
  backend: string;
  accountId: string;
  /**
   * Every conversation id the open row stands for (`ListEntry.conversationIds`): a merged mail
   * row has several, and the delivered copy may land in any of them. The first one is the
   * bubble's own.
   */
  conversations: readonly string[];
  /** What was typed, as typed: the bubble shows it and the content stage matches the delivered body against it. */
  text: string;
  /** The files handed over to the send. This entry owns the temporary ones until it settles. */
  files: readonly PickedFile[];
  /** The message being answered, so Retry keeps the reply link. */
  replyTo?: ReplyTarget;
  /** Local clock when the person pressed send: the bubble's time, and the content stage's lower bound. */
  startedAt: string;
  state: PendingSendState;
  /** The backend's one sentence, on a `failed` entry. */
  error?: string;
}

/** The bubble's id for a client id, and back. */
export function pendingRowId(clientId: string): string {
  return `${PENDING_PREFIX}${clientId}`;
}

/** The client id of a pending bubble's row id, or null for a real message. */
export function pendingClientId(messageId: string): string | null {
  return messageId.startsWith(PENDING_PREFIX) ? messageId.slice(PENDING_PREFIX.length) : null;
}

/**
 * What stands in the bubble's clock position, and is its accessible name too: a screen reader
 * announces the state instead of an empty time (§4).
 */
export function sendStateLabel(state: PendingSendState): string {
  return state === 'failed' ? _('Not sent') : _('Sending…');
}

/** One picked file as a bubble part: its bytes are already on this machine, so nothing is fetched. */
function partOf(file: PickedFile, index: number): AttachmentInfo {
  return {
    filename: file.name,
    mimeType: null,
    size: file.size,
    index,
    localPath: file.path,
    ...(file.voiceMs === undefined ? {} : { kind: 'voice' as const, durationMs: file.voiceMs }),
  };
}

/**
 * The pending send as a message the conversation can show: a normal own bubble, built by the same
 * `addRow` as every other (§4). It carries no `ref.remoteId`, so nothing offers to reply to it,
 * react to it or edit it — there is no message on any network to act on yet.
 */
export function pendingRow<Choice>(send: PendingSend<Choice>): ShownMessage {
  return {
    id: pendingRowId(send.clientId),
    conversationId: send.conversations[0] ?? send.clientId,
    backend: send.backend,
    presentation: 'bubble',
    senderId: null,
    senderName: null,
    senderAddress: null,
    fromSelf: true,
    sentAt: send.startedAt,
    subject: null,
    seen: true,
    hasAttachments: send.files.length > 0,
    classification: 'conversational',
    classificationReason: 'self',
    emailChat: false,
    ref: { accountId: send.accountId, backend: send.backend },
    bodyText: send.text,
    ...(send.files.length === 0 ? {} : { attachments: send.files.map(partOf) }),
  };
}

/** What the content stage compares a pending entry against; every shown message offers this much. */
export interface SettlingRow {
  id: string;
  conversationId: string;
  fromSelf: boolean;
  sentAt: string | null;
  clientId?: string | null;
  bodyText?: string | null;
  attachments?: readonly unknown[];
}

/**
 * How far BEFORE the moment the person pressed send a delivered row may be stamped and still be
 * that send (ADR 0021 §3).
 *
 * `startedAt` is this machine's clock with milliseconds; the `sentAt` of a delivered row is the
 * server's, and Telegram and WhatsApp report it truncated to whole seconds. A row that really is
 * this send can therefore carry an earlier stamp than the send's start — by up to a second from
 * the truncation alone, plus whatever the two clocks disagree by. Without a tolerance such a row
 * never settles its bubble, and the chat shows the pending bubble beside the real message until
 * the send's own promise resolves.
 *
 * Five seconds: wide enough for a truncated stamp and an unsynchronised clock, narrow enough that
 * the stage still cannot reach into history — it only ever sees the page beside the sends in
 * flight, and a send lives for seconds.
 */
export const SEND_CLOCK_SKEW_MS = 5_000;

/** The earliest `sentAt` a row may carry for this send: its start, floored to the second, less the window. */
function earliestFor(startedAt: string): number {
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return Number.NEGATIVE_INFINITY;
  return Math.floor(started / 1000) * 1000 - SEND_CLOCK_SKEW_MS;
}

/**
 * Which pending entries this page has taken over, as `clientId` → the row id that did it (§3).
 *
 * Two keys, in order, each row claimed by at most one entry:
 *
 *  1. the row carrying the same client id — exact, and available before the send returns, which
 *     is what closes the daemon race on XMPP,
 *  2. the row that looks like this send and cannot be anything else: the person's own, in one of
 *     the open conversations, the same body and the same number of parts, stamped no earlier than
 *     {@link SEND_CLOCK_SKEW_MS} before they pressed send.
 *
 * There is no stage for the id a resolved send reported: by the time `sendMessage` answers, the
 * window has the message itself and drops the entry, so such a stage could never fire.
 *
 * The content stage is bounded on purpose. It never reaches into history, so the worst it can do
 * is settle a bubble against the twin of a message sent twice inside one send's lifetime — one
 * bubble swapped a moment early, never a duplicate and never a lost message. A `failed` entry is
 * left alone: it waits for Retry or Discard.
 */
export function settledByPage<Choice>(
  sends: readonly PendingSend<Choice>[],
  page: readonly SettlingRow[],
): Map<string, string> {
  const settled = new Map<string, string>();
  const open = sends.filter((send) => send.state === 'pending');
  if (open.length === 0) return settled;
  // A pending bubble is in the page the view hands over; it can never settle another one.
  const rows = page.filter((row) => pendingClientId(row.id) === null);
  const claimed = new Set<string>();
  const take = (clientId: string, row: SettlingRow): void => {
    settled.set(clientId, row.id);
    claimed.add(row.id);
  };
  const free = (row: SettlingRow): boolean => !claimed.has(row.id);
  for (const send of open) {
    const row = rows.find((r) => free(r) && typeof r.clientId === 'string' && r.clientId === send.clientId);
    if (row) take(send.clientId, row);
  }
  for (const send of open) {
    if (settled.has(send.clientId)) continue;
    const body = send.text.trim();
    const earliest = earliestFor(send.startedAt);
    const row = rows.find((r) => {
      if (!free(r) || !r.fromSelf || !send.conversations.includes(r.conversationId)) return false;
      const at = r.sentAt === null || r.sentAt === undefined ? Number.NaN : Date.parse(r.sentAt);
      if (Number.isNaN(at) || at < earliest) return false;
      return (r.bodyText?.trim() ?? '') === body && (r.attachments?.length ?? 0) === send.files.length;
    });
    if (row) take(send.clientId, row);
  }
  return settled;
}

/**
 * The page with the still-pending bubbles of the open conversation after it, oldest first.
 *
 * The same shape as `withPendingEdits`: every later page read lays the in-flight sends over it
 * again, so the diff sees them as part of what the index reports and leaves their rows alone
 * until they settle.
 */
export function withPendingSends<M extends ShownMessage, Choice>(
  page: readonly M[],
  sends: readonly PendingSend<Choice>[],
): (M | ShownMessage)[] {
  if (sends.length === 0) return [...page];
  const rows = [...sends]
    .sort((a, b) => (a.startedAt === b.startedAt ? 0 : a.startedAt < b.startedAt ? -1 : 1))
    .map((send) => pendingRow(send));
  return [...page, ...rows];
}
