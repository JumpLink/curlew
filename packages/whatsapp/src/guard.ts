/**
 * Read-only through structure, a granted send through one gate.
 *
 * Signal's gate (`@curlew/signal`, `guard.ts`) sits on an allowlist of HTTP-shaped requests,
 * because every write to Signal is one. Baileys has no such seam: a write is a method call on
 * the socket object, and the socket Baileys returns carries dozens of them (`readMessages`,
 * `sendPresenceUpdate`, `chatModify`, `groupCreate`, `logout`, …). So this package draws the line
 * one level up, in `api.ts`: the receive path is handed `WaSocketHandle`, which has `ev`,
 * `requestPairingCode` and `end` and no way to write at all, and a granted send is handed
 * `WaSendSocketHandle`, whose single write is `sendText(jid, text)`. Nothing widens either shape
 * at runtime, and a test asserts the receive handle has no send-capable method.
 *
 * What is left to gate is therefore one argument: WHICH chat that one text may go into. That is
 * this file — fail-closed, per permit, over the already-normalized JID:
 *
 * - a JID a permit names → through;
 * - anything else → refused before it reaches Baileys, without naming what was asked for (the
 *   caller knows, and a refusal is no place to put other people's addresses).
 *
 * The gate is the SECOND check, not the first: `send.ts` validates and refuses the address with
 * a sentence a person can act on. This one exists for the case a bug above it gets that wrong,
 * so its reasons are terse and in English — reaching them is a defect, not a user path.
 */

import type { WaSendSocketHandle, WaSentMessage } from './api.ts';
import { sendableJid } from './jid.ts';

/** The one write a granted sender has. */
export type WaSendText = (jid: string, text: string) => Promise<WaSentMessage>;

/**
 * Why a sender permitted to write to `recipients` may not write to `jid`, or null when it may.
 * An address that is not sendable at all is refused here too: the permitted list holds only
 * normalized JIDs, so a match on anything else would be a comparison of unlike things.
 */
export function sendRefusal(jid: string, recipients: readonly string[]): string | null {
  const target = sendableJid(jid);
  if (!target) return 'an address that is not a WhatsApp chat id';
  return recipients.includes(target) ? null : 'a chat no grant names';
}

export class SendViolation extends Error {
  constructor(reason: string) {
    super(`curlew refused to send: ${reason}`);
    this.name = 'SendViolation';
  }
}

/**
 * Wrap a send socket's write for ONE granted sender. `recipients` is normalized and copied, so a
 * later change to the permit cannot widen a handle that is already open.
 */
export function guardedSendText(send: WaSendText, recipients: readonly string[]): WaSendText {
  const permitted = recipients.map((address) => sendableJid(address)).filter((jid) => jid !== null);
  return async (jid, text) => {
    const reason = sendRefusal(jid, permitted);
    if (reason) throw new SendViolation(reason);
    return send(jid, text);
  };
}

/** The gate around a whole handle: the only thing `openSender` hands to `WhatsAppSender`. */
export function guardedSendSocket(
  socket: WaSendSocketHandle,
  recipients: readonly string[],
): WaSendSocketHandle {
  const sendText = guardedSendText((jid, text) => socket.sendText(jid, text), recipients);
  return {
    ev: socket.ev,
    ready: () => socket.ready(),
    sendText,
    end: () => socket.end(),
  };
}
