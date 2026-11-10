/**
 * The XMPP handle that may write — opened only with a send permit (ADR 0004 §5).
 *
 * The sync path holds an `XmppApi` and has no method that sends. This is the other handle, in the
 * same pattern as Signal's `guardedFetch`: it exists only once the caller proved a grant, and it
 * re-checks the address on every send, so a bug in a frontend's gate still cannot make it write
 * to a JID the grant does not name. Presence and carbons (follow mode) need only the account's
 * permit, which is why the permit is per account with the addresses it may reach.
 */

import type { ChatSession, SendPermit } from '@curlew/protocol';
import { normalizeAddress } from '@curlew/protocol';
import { aesGcmEncrypt, toHex } from '@curlew/omemo';
import { randomUUID } from 'node:crypto';
import type { XmppApi, XmppLink } from './api.ts';
import { readOnly } from './client.ts';
import { MESSAGES } from './messages.ts';
import type { EncryptedStanza } from './omemo-stanza.ts';
import { bareJid } from './stanza.ts';
import { type DecryptEntries, XmppChatSession } from './session.ts';
import { checkedSlotUrl } from './upload.ts';

/** The longest text one send carries. A chat message, not a document. */
export const MAX_TEXT_CHARS = 8_000;

/** What the grants allow for ONE account: the exact addresses `xmpp.send` names for it. */
export type { SendPermit };

export interface SentChat {
  /** The bare JID the message went to. */
  chatJid: string;
  /** The id it carries as `id` and `origin-id` (XEP-0359). */
  originId: string;
  /** Local send time, ISO 8601. */
  sentAt: string;
  /** Whether it went out under OMEMO. False means the peer has none, never a fallback (§7). */
  encrypted: boolean;
}

/** A file for `sendFile`: the bytes are read already, the name is shown to the peer. */
export interface FileToSend {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}

/** The extension of a name when it is short and plain, else none — all an encrypted upload keeps of it. */
function plainExtension(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(filename);
  return match === null ? '' : `.${match[1].toLowerCase()}`;
}

/** The longest image URL one send carries. */
export const MAX_IMAGE_URL_CHARS = 2_000;

/**
 * An image URL is sent as the message body and as an OOB reference, so a client fetches it:
 * https only, no embedded credentials, no whitespace or control characters.
 */
export function validateImageUrl(url: string): string {
  if (url.length > MAX_IMAGE_URL_CHARS) throw new Error(MESSAGES.imageTooLong(MAX_IMAGE_URL_CHARS));
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(MESSAGES.imageNotHttps);
  }
  const unsafe = [...url].some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code <= 0x20 || code === 0x7f;
  });
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || unsafe) {
    throw new Error(MESSAGES.imageNotHttps);
  }
  return parsed.href;
}

/**
 * The account's OMEMO, opened by the backend for a caller that decrypts.
 *
 * Separate from the send permit because the two grants are separate: following an account may
 * decrypt without being allowed to send, and sending does not imply decrypting.
 */
export interface GrantedOmemo {
  readonly decrypt: DecryptEntries;
  /**
   * Encrypt one outgoing message for a peer, or answer null when the peer has no OMEMO devices
   * and plaintext is what they can read.
   *
   * A throw is a refusal (`OmemoSendRefusedError`) and the message is NOT sent in the clear —
   * that is ADR 0006 §7 and the reason this returns a stanza rather than a boolean. The policy
   * itself lives in `omemo-send.ts`; what this interface does is keep it out of here.
   */
  encrypt(to: string, text: string | null): Promise<EncryptedStanza | null>;
  /**
   * Whether a message to this peer goes out encrypted — the same decision `encrypt` makes, asked
   * BEFORE a file is uploaded, because a file's route depends on it. Throws what `encrypt`
   * throws: a refusal is a refusal at either step.
   */
  encrypts(to: string): Promise<boolean>;
  /** Releases what opening it took — the account's secret file. */
  close(): void;
}

export class GrantedXmppSession {
  private readonly link: XmppLink;
  private readonly permit: SendPermit;
  private readonly newId: () => string;
  private readonly omemo: GrantedOmemo | undefined;

  constructor(
    link: XmppLink,
    permit: SendPermit,
    newId: () => string = randomUUID,
    omemo?: GrantedOmemo,
  ) {
    this.link = link;
    this.permit = permit;
    this.newId = newId;
    this.omemo = omemo;
  }

  /**
   * Send one chat message — encrypted when the peer has OMEMO devices and this session was
   * opened with OMEMO, plain text otherwise. Throws, writing nothing, unless the permit names
   * `to`.
   *
   * There is no third outcome. Either the message goes out encrypted, or it goes out to a peer
   * who has no OMEMO at all, or nothing is sent and the caller hears why (§7).
   */
  async send(
    to: string,
    text: string,
    now: () => Date = () => new Date(),
    answers?: { id: string; fromSelf: boolean },
  ): Promise<SentChat> {
    const chatJid = this.recipient(to);
    if (text.trim().length === 0) throw new Error(MESSAGES.emptyText);
    if (text.length > MAX_TEXT_CHARS) throw new Error(MESSAGES.tooLong(MAX_TEXT_CHARS));
    const originId = this.newId();
    // XEP-0461 names the author of the answered message: the person, or the one this chat is with.
    const reply = answers && { id: answers.id, author: answers.fromSelf ? bareJid(this.link.jid) : chatJid };
    const encrypted = await this.omemo?.encrypt(chatJid, text);
    if (encrypted) await this.link.sendEncrypted(chatJid, originId, encrypted, MESSAGES.omemoFallback, reply);
    else await this.link.sendChat(chatJid, originId, text, undefined, reply);
    return { chatJid, originId, sentAt: now().toISOString(), encrypted: Boolean(encrypted) };
  }

  /**
   * The person's emoji on a message of a 1:1 chat, replacing their earlier set; `null` takes it
   * back. A reaction cannot be encrypted (XEP-0444 has no payload for it), so an OMEMO chat
   * refuses it rather than put the emoji in the clear next to messages that are not.
   */
  async react(to: string, targetId: string, emoji: string | null): Promise<void> {
    const chatJid = this.recipient(to);
    if (await this.omemo?.encrypts(chatJid)) throw new Error(MESSAGES.reactNotEncrypted);
    await this.link.sendReaction(chatJid, this.newId(), targetId, emoji === null ? [] : [emoji]);
  }

  /**
   * Send one image as its own message: body = the URL, plus an XEP-0066 `<x xmlns='jabber:x:oob'>`
   * carrying the same URL. Same permit check and same encryption rule as `send`.
   *
   * Encrypted, the URL goes INSIDE the payload and there is no `<x>` element: an out-of-band
   * reference is plaintext, and a plaintext link to the picture is most of what the encryption
   * was for. The receiving client then shows it as a link rather than inline, which is what
   * Conversations does for an encrypted URL it was not given a key for.
   */
  async sendImage(to: string, url: string, now: () => Date = () => new Date()): Promise<SentChat> {
    const chatJid = this.recipient(to);
    const href = validateImageUrl(url);
    const originId = this.newId();
    const encrypted = await this.omemo?.encrypt(chatJid, href);
    if (encrypted) await this.link.sendEncrypted(chatJid, originId, encrypted, MESSAGES.omemoFallback);
    else await this.link.sendChat(chatJid, originId, href, href);
    return { chatJid, originId, sentAt: now().toISOString(), encrypted: Boolean(encrypted) };
  }

  /**
   * Send one file as its own message: upload it (XEP-0363), then send the link.
   *
   * A peer without OMEMO gets the link as the body plus an XEP-0066 reference, which is how
   * every client shows a picture inline. A peer WITH OMEMO never gets a plaintext link — and a
   * plaintext upload would be the same leak: the file is encrypted with a fresh key first, uploaded
   * as opaque bytes under a random name, and the `aesgcm://` link carrying the key goes INSIDE the
   * OMEMO payload (the format Conversations and Dino read). If the peer's encryption disappears
   * between the check and the send, the upload stays and nothing is sent.
   *
   * Same permit check as `send`, before anything leaves.
   */
  async sendFile(to: string, file: FileToSend, now: () => Date = () => new Date()): Promise<SentChat> {
    const chatJid = this.recipient(to);
    const originId = this.newId();
    if (!(await this.omemo?.encrypts(chatJid))) {
      const slot = await this.link.uploadSlot({
        filename: file.filename,
        size: file.bytes.length,
        contentType: file.contentType,
      });
      await this.link.putFile(slot, file);
      await this.link.sendChat(chatJid, originId, slot.getUrl, slot.getUrl);
      return { chatJid, originId, sentAt: now().toISOString(), encrypted: false };
    }
    const omemo = this.omemo!;
    const key = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bytes = await aesGcmEncrypt(key, iv, file.bytes);
    const name = `${randomUUID()}${plainExtension(file.filename)}`;
    const contentType = 'application/octet-stream';
    const slot = await this.link.uploadSlot({ filename: name, size: bytes.length, contentType });
    await this.link.putFile(slot, { bytes, contentType, filename: file.filename });
    const link = checkedSlotUrl(slot.getUrl);
    if (link === null) throw new Error(MESSAGES.uploadBadSlot(file.filename));
    const encrypted = await omemo.encrypt(chatJid, `aesgcm:${link.slice('https:'.length)}#${toHex(iv)}${toHex(key)}`);
    if (encrypted === null) throw new Error(MESSAGES.encryptionLost(chatJid));
    await this.link.sendEncrypted(chatJid, originId, encrypted, MESSAGES.omemoFallback);
    return { chatJid, originId, sentAt: now().toISOString(), encrypted: true };
  }

  /** The bare JID to send to, or a throw: the permit is re-checked on every send (ADR 0004 §5). */
  private recipient(to: string): string {
    if (!this.permit.addresses.includes(to)) throw new Error(MESSAGES.notPermitted(this.permit.account, to));
    const chatJid = to.includes('/') ? null : normalizeAddress('jid', to);
    if (!chatJid || !chatJid.includes('@')) throw new Error(MESSAGES.notBare(to));
    return chatJid;
  }

  /** Follow mode: carbons on, then the negative-priority presence. */
  goAvailable(): Promise<void> {
    return this.link.goAvailable();
  }

  onArrival(listener: () => void): () => void {
    return this.link.onArrival(listener);
  }

  onClosed(listener: (reason: string) => void): void {
    this.link.onClosed(listener);
  }

  /**
   * A chat session over THIS connection, for an archive catch-up. Closing it keeps the link open.
   *
   * It decrypts whenever the session was opened with OMEMO, so follow mode writes the same rows
   * `curlew sync` would: the daemon is the process that sees a message FIRST, and a message it
   * indexed textless would stay that way — the next sync finds nothing new to fetch for it.
   */
  chatSession(): ChatSession {
    const api: XmppApi = { ...readOnly(this.link), close: async () => {} };
    return new XmppChatSession(api, this.omemo?.decrypt);
  }

  async close(): Promise<void> {
    this.omemo?.close();
    await this.link.close();
  }
}
