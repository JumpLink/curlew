/**
 * The XMPP handle that may write — opened only with a send permit (ADR 0004 §5).
 *
 * The sync path holds an `XmppApi` and has no method that sends. This is the other handle, in the
 * same pattern as Signal's `guardedFetch`: it exists only once the caller proved a grant, and it
 * re-checks the address on every send, so a bug in a frontend's gate still cannot make it write
 * to a JID the grant does not name. Presence and carbons (follow mode) need only the account's
 * permit, which is why the permit is per account with the addresses it may reach.
 */

import type { ChatSession } from '@curlew/protocol';
import { normalizeAddress } from '@curlew/protocol';
import { randomUUID } from 'node:crypto';
import type { XmppApi, XmppLink } from './api.ts';
import { readOnly } from './client.ts';
import { MESSAGES } from './messages.ts';
import { type DecryptEntries, XmppChatSession } from './session.ts';

/** The longest text one send carries. A chat message, not a document. */
export const MAX_TEXT_CHARS = 8_000;

/** What the grants allow for ONE account: the exact addresses `xmpp.send` names for it. */
export interface SendPermit {
  account: string;
  addresses: readonly string[];
}

export interface SentChat {
  /** The bare JID the message went to. */
  chatJid: string;
  /** The id it carries as `id` and `origin-id` (XEP-0359). */
  originId: string;
  /** Local send time, ISO 8601. */
  sentAt: string;
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
 * The account's OMEMO, opened by the backend for a caller that also holds `xmpp.omemo`.
 *
 * Separate from the send permit because the two grants are separate: following an account may
 * decrypt without being allowed to send, and sending does not imply decrypting.
 */
export interface GrantedOmemo {
  readonly decrypt: DecryptEntries;
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

  /** Send one plain-text chat message. Throws, writing nothing, unless the permit names `to`. */
  async send(to: string, text: string, now: () => Date = () => new Date()): Promise<SentChat> {
    if (!this.permit.addresses.includes(to)) throw new Error(MESSAGES.notPermitted(this.permit.account, to));
    const chatJid = to.includes('/') ? null : normalizeAddress('jid', to);
    if (!chatJid || !chatJid.includes('@')) throw new Error(MESSAGES.notBare(to));
    if (text.trim().length === 0) throw new Error(MESSAGES.emptyText);
    if (text.length > MAX_TEXT_CHARS) throw new Error(MESSAGES.tooLong(MAX_TEXT_CHARS));
    const originId = this.newId();
    await this.link.sendChat(chatJid, originId, text);
    return { chatJid, originId, sentAt: now().toISOString() };
  }

  /**
   * Send one image as its own message: body = the URL, plus an XEP-0066 `<x xmlns='jabber:x:oob'>`
   * carrying the same URL. Same permit check as `send`.
   */
  async sendImage(to: string, url: string, now: () => Date = () => new Date()): Promise<SentChat> {
    if (!this.permit.addresses.includes(to)) throw new Error(MESSAGES.notPermitted(this.permit.account, to));
    const chatJid = to.includes('/') ? null : normalizeAddress('jid', to);
    if (!chatJid || !chatJid.includes('@')) throw new Error(MESSAGES.notBare(to));
    const href = validateImageUrl(url);
    const originId = this.newId();
    await this.link.sendChat(chatJid, originId, href, href);
    return { chatJid, originId, sentAt: now().toISOString() };
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
