/**
 * Every user-facing string of the send path, in one place for the gettext pass that follows.
 */

import type { RefusalReason } from './omemo-send.ts';

export const MESSAGES = {
  notPermitted: (account: string, to: string) =>
    `sending from ${account} to ${to} is not granted — add { "capability": "xmpp.send", "target": "${account}/${to}" } to config.grants`,
  notBare: (to: string) => `${JSON.stringify(to)} is not a bare XMPP address — expected name@example.org`,
  emptyText: 'there is nothing to send: the text is empty',
  imageNotHttps: 'the image URL must be a valid https:// URL without credentials or spaces',
  imageTooLong: (max: number) => `the image URL is longer than ${max} characters`,
  tooLong: (max: number) => `the text is longer than ${max} characters`,
  noAccount: (id: string) => `no XMPP account ${id} — \`curlew accounts list\` shows them`,
  /**
   * The plaintext `<body>` of an encrypted message, for a client that cannot read OMEMO.
   *
   * It names the encryption and nothing else: this line goes to the server in the clear, so
   * every word of it is a word the server learns.
   */
  omemoFallback: 'This message is OMEMO encrypted and this client cannot read it.',
  /** Why nothing was sent — one line per reason, each a different thing to do about it (§7). */
  omemoRefused: {
    'device-list-failed': (to: string) =>
      `nothing was sent: ${to} uses OMEMO and their device list could not be read — try again when the server answers`,
    'no-trusted-device': (to: string) =>
      `nothing was sent: no device of ${to} may be encrypted to — \`curlew omemo devices\` shows them, \`curlew omemo verify\` decides`,
    'no-usable-bundle': (to: string) =>
      `nothing was sent: no device of ${to} has published keys to encrypt with — their client has to come online once`,
  } satisfies Record<RefusalReason, (to: string) => string>,
} as const;
