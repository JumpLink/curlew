/**
 * `messaging_capabilities` — what a caller may rely on when it sends and waits, per protocol.
 *
 * Static facts of this build plus the account ids the grants already name (the same ids
 * `accounts_list` returns): no address, no message, no credential. Only XMPP can send today.
 */

import { configPath } from '@curlew/store';
import { loadConfig } from '../config.ts';
import { SEND_CAPABILITY } from './send.ts';
import { WAIT_TIMEOUT_S } from './wait-reply.ts';
import { MAX_CHUNK_CHARS, MESSAGE_FORMATS, type MessageFormat } from '../markdown.ts';

/** The longest text one XMPP message may carry (`@curlew/xmpp` refuses more). */
export const XMPP_MAX_MESSAGE_CHARS = 8_000;

export interface MessagingCapabilities {
  protocol: string;
  /** Account ids with a send grant; empty when none is granted. */
  accounts: string[];
  maxMessageChars: number;
  /** Per-message size when `format` is markdown and the text is split. */
  splitAtChars: number;
  formats: MessageFormat[];
  /** How `markdown` is rendered on this protocol. */
  markdownRendering: string;
  /** A long text is split into several messages (markdown only). */
  splitsLongText: boolean;
  images: { supported: boolean; how: string };
  waitTimeoutS: { default: number; max: number };
}

export function messagingCapabilities(path = configPath()): { protocols: MessagingCapabilities[] } {
  const { grants } = loadConfig(path);
  const accounts = [
    ...new Set(
      grants
        .filter((g) => g.capability === SEND_CAPABILITY)
        .map((g) => g.target.slice(0, g.target.indexOf('/'))),
    ),
  ];
  return {
    protocols: [
      {
        protocol: 'xmpp',
        accounts,
        maxMessageChars: XMPP_MAX_MESSAGE_CHARS,
        splitAtChars: MAX_CHUNK_CHARS,
        formats: [...MESSAGE_FORMATS],
        markdownRendering: 'XEP-0393 message styling',
        splitsLongText: true,
        images: { supported: true, how: 'https image_url as its own message (XEP-0066 OOB)' },
        waitTimeoutS: { ...WAIT_TIMEOUT_S },
      },
    ],
  };
}
