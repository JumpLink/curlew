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
          'nothing was sent: no device of {to} may be encrypted to — `curlew omemo devices` shows them, `curlew omemo trust` decides',
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
    'identity-changed': (to: string) =>
      fmt(
        _(
          'nothing was sent: a device of {to} published a new OMEMO key — compare it with them, then `curlew omemo trust` decides',
        ),
        { to },
      ),
    'encryption-required': (to: string) =>
      fmt(
        _(
          'nothing was sent: {to} has no OMEMO devices and encryption is required for them — remove them from config.encryption to allow plain text',
        ),
        { to },
      ),
  } satisfies Record<RefusalReason, (to: string) => string>,
  /**
   * The notice that goes into the conversation when a device's key changed (§6).
   *
   * Translated, unlike {@link MESSAGES.omemoFallback}: this one is read by the person whose
   * client wrote it and never leaves the machine. It names the NEW fingerprint, because the
   * whole point of the line is to send someone to a second channel to compare it.
   */
  omemoIdentityChanged: (jid: string, printed: string) =>
    fmt(
      _(
        '{jid} is now using a different OMEMO key: {printed}. Compare it with them out of band — `curlew omemo trust` decides.',
      ),
      { jid, printed },
    ),
  /**
   * `encryption: "required"` for a peer whose account has no `xmpp.omemo` grant (§7).
   *
   * Refused before the connection, because without the grant curlew holds no keys and could only
   * send in the clear — which is the one thing the setting rules out. Both halves of the fix are
   * named, since either one is a legitimate answer.
   */
  omemoRequiredWithoutGrant: (accountId: string, to: string) =>
    fmt(
      _(
        'nothing was sent: encryption is required for {to}, but {accountId} has no `xmpp.omemo` grant — grant it, or remove {to} from config.encryption',
      ),
      { accountId, to },
    ),
  /** Why a trust decision changed nothing — one line per way the typed fingerprint can miss. */
  omemoTrust: {
    get unparsable() {
      return _('that is not an OMEMO fingerprint: expected 64 hex characters, in any grouping');
    },
    /** The fingerprint typed back at the terminal was not the one being decided (§6). */
    get mismatch() {
      return _('that is not the fingerprint you passed — nothing changed');
    },
    unknown: (jid: string) =>
      fmt(_('no device of {jid} carries that fingerprint — `curlew omemo devices` lists them'), { jid }),
    ambiguous: (jid: string, count: number) =>
      fmt(
        _('{count} devices of {jid} carry that fingerprint, so it does not name one — nothing changed'),
        { count, jid },
      ),
  },
} as const;
