/**
 * `messaging_capabilities` — what a caller may rely on when it sends and waits, per protocol.
 *
 * Static facts of this build plus the account ids the grants already name (the same ids
 * `accounts_list` returns): no address, no message, no credential. XMPP, Telegram, Matrix, Signal
 * and WhatsApp can send chat messages (mail is not a chat protocol).
 */

import { configPath } from '@curlew/store';
import { loadConfig } from '../config.ts';
import { SEND_CAPABILITY } from './send.ts';
import { WAIT_TIMEOUT_S } from './wait-reply.ts';
import { MAX_CHUNK_CHARS, MESSAGE_FORMATS, type MessageFormat } from '../markdown.ts';

/** The longest text one XMPP message may carry (`@curlew/xmpp` refuses more). */
export const XMPP_MAX_MESSAGE_CHARS = 8_000;

/**
 * Telegram's limit, as `TELEGRAM_MAX_MESSAGE_CHARS` in `@curlew/telegram`. Repeated here because the
 * core must not import the backend (and mtcute with it); a unit test pins the two together.
 */
export const TELEGRAM_MAX_MESSAGE_CHARS = 4_096;

/**
 * Matrix's limit, as `MATRIX_MAX_MESSAGE_BYTES` in `@curlew/matrix`. Repeated here for the same
 * reason as Telegram's (the core must not import the backend); a unit test pins the two together.
 */
export const MATRIX_MAX_MESSAGE_BYTES = 32_000;

/**
 * Signal's limit, as `SIGNAL_MAX_MESSAGE_BYTES` in `@curlew/signal`. Repeated here for the same
 * reason as the two above (the core must not import the backend); a unit test pins them together.
 */
export const SIGNAL_MAX_MESSAGE_BYTES = 2_048;

/**
 * WhatsApp's limit, as `WHATSAPP_MAX_MESSAGE_BYTES` in `@curlew/whatsapp`. Repeated here for the
 * same reason as the three above (the core must not import the backend); a unit test pins them
 * together.
 */
export const WHATSAPP_MAX_MESSAGE_BYTES = 65_536;

export interface MessagingCapabilities {
  protocol: string;
  /** Account ids with a send grant; empty when none is granted. */
  accounts: string[];
  maxMessageChars: number;
  /**
   * The limit as the protocol states it, for one that counts BYTES rather than characters
   * (Matrix). `maxMessageChars` is then the same number and a safe ceiling — a text of n
   * characters is at least n bytes — so a caller that only knows characters still cannot exceed
   * it, and one that can measure UTF-8 gets the real figure. Absent where the protocol counts
   * characters.
   */
  maxMessageBytes?: number;
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
  const accountsOf = (capability: string): string[] => [
    ...new Set(
      grants.filter((g) => g.capability === capability).map((g) => g.target.slice(0, g.target.indexOf('/'))),
    ),
  ];
  return {
    protocols: [
      {
        protocol: 'xmpp',
        accounts: accountsOf(SEND_CAPABILITY),
        maxMessageChars: XMPP_MAX_MESSAGE_CHARS,
        splitAtChars: MAX_CHUNK_CHARS,
        formats: [...MESSAGE_FORMATS],
        markdownRendering: 'XEP-0393 message styling',
        splitsLongText: true,
        images: { supported: true, how: 'https image_url as its own message (XEP-0066 OOB)' },
        waitTimeoutS: { ...WAIT_TIMEOUT_S },
      },
      {
        protocol: 'telegram',
        accounts: accountsOf('telegram.send'),
        maxMessageChars: TELEGRAM_MAX_MESSAGE_CHARS,
        splitAtChars: TELEGRAM_MAX_MESSAGE_CHARS,
        formats: ['plain'],
        markdownRendering: 'none: the text goes out exactly as given',
        splitsLongText: false,
        images: { supported: false, how: 'not supported' },
        waitTimeoutS: { ...WAIT_TIMEOUT_S },
      },
      {
        protocol: 'matrix',
        accounts: accountsOf('matrix.send'),
        maxMessageChars: MATRIX_MAX_MESSAGE_BYTES,
        maxMessageBytes: MATRIX_MAX_MESSAGE_BYTES,
        splitAtChars: MATRIX_MAX_MESSAGE_BYTES,
        formats: ['plain'],
        markdownRendering: 'none: the text goes out exactly as given',
        splitsLongText: false,
        images: { supported: false, how: 'not supported' },
        waitTimeoutS: { ...WAIT_TIMEOUT_S },
      },
      {
        protocol: 'signal',
        accounts: accountsOf('signal.send'),
        maxMessageChars: SIGNAL_MAX_MESSAGE_BYTES,
        maxMessageBytes: SIGNAL_MAX_MESSAGE_BYTES,
        splitAtChars: SIGNAL_MAX_MESSAGE_BYTES,
        formats: ['plain'],
        markdownRendering: 'none: the text goes out exactly as given',
        splitsLongText: false,
        images: { supported: false, how: 'not supported' },
        waitTimeoutS: { ...WAIT_TIMEOUT_S },
      },
      {
        protocol: 'whatsapp',
        accounts: accountsOf('whatsapp.send'),
        maxMessageChars: WHATSAPP_MAX_MESSAGE_BYTES,
        maxMessageBytes: WHATSAPP_MAX_MESSAGE_BYTES,
        splitAtChars: WHATSAPP_MAX_MESSAGE_BYTES,
        formats: ['plain'],
        // WhatsApp's own clients render `*bold*` and `_italic_`, which is not chat Markdown and
        // not translated here: whatever is given goes out as the body, verbatim.
        markdownRendering: 'none: the text goes out exactly as given',
        splitsLongText: false,
        images: { supported: false, how: 'not supported' },
        waitTimeoutS: { ...WAIT_TIMEOUT_S },
      },
    ],
  };
}
