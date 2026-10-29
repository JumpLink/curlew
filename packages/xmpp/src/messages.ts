/**
 * Every user-facing string of the send path. Each is a function or getter, never a module-level
 * `_()`: that would resolve before `initI18n()` and freeze English into the module.
 */

import { _, fmt } from '@curlew/protocol';
import type { RefusalReason } from './omemo-send.ts';

export const MESSAGES = {
  notPermitted: (account: string, to: string) =>
    fmt(
      _(
        // TRANSLATORS: keep the JSON snippet verbatim — it is config syntax to paste.
        'sending from {account} to {to} is not granted — add { "capability": "xmpp.send", "target": "{account}/{to}" } to config.grants',
      ),
      { account, to },
    ),
  notBare: (to: string) =>
    fmt(_('{to} is not a bare XMPP address — expected name@example.org'), { to: JSON.stringify(to) }),
  get emptyText() {
    return _('there is nothing to send: the text is empty');
  },
  get imageNotHttps() {
    return _('the image URL must be a valid https:// URL without credentials or spaces');
  },
  imageTooLong: (max: number) => fmt(_('the image URL is longer than {max} characters'), { max }),
  tooLong: (max: number) => fmt(_('the text is longer than {max} characters'), { max }),
  noAccount: (id: string) => fmt(_('no XMPP account {id} — `curlew accounts list` shows them'), { id }),
  /**
   * The plaintext `<body>` of an encrypted message, for a client that cannot read OMEMO.
   *
   * Deliberately English and NEVER translated: this line goes over the wire to the recipient's
   * client, so it must not depend on the sender's locale. It names the encryption and nothing
   * else — the server learns every word of it.
   */
  omemoFallback: 'This message is OMEMO encrypted and this client cannot read it.',
  /** Why nothing was sent — one line per reason, each a different thing to do about it (§7). */
  omemoRefused: {
    'device-list-failed': (to: string) =>
      fmt(
        _(
          'nothing was sent: {to} uses OMEMO and their device list could not be read — try again when the server answers',
        ),
        { to },
      ),
    'no-trusted-device': (to: string) =>
      fmt(
        _(
          'nothing was sent: no device of {to} may be encrypted to — `curlew omemo devices` shows them, `curlew omemo verify` decides',
        ),
        { to },
      ),
    'no-usable-bundle': (to: string) =>
      fmt(
        _(
          'nothing was sent: no device of {to} has published keys to encrypt with — their client has to come online once',
        ),
        { to },
      ),
  } satisfies Record<RefusalReason, (to: string) => string>,
} as const;
