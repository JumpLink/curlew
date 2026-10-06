/**
 * SMTP errors.
 *
 * The message never carries a credential: it is built from fixed text and, for a server refusal,
 * the numeric reply code. Nothing of the underlying library error is kept (no `cause`), because
 * its fields are not ours to vouch for.
 *
 * Note: no TypeScript parameter properties — Node's --experimental-strip-types rejects them.
 */

/** What went wrong, coarse enough to branch on. */
export type SmtpErrorCode =
  /** The server refused the login, or no usable credential was given. */
  | 'auth'
  /** The TLS handshake or the STARTTLS upgrade failed (certificate included). */
  | 'tls'
  /** No connection, a dropped one, a timeout, or a reply that is not SMTP. */
  | 'connect'
  /** The server refused the sender, a recipient, or the message. */
  | 'rejected'
  /** The account or message is invalid; nothing was sent over the network. */
  | 'config';

export class SmtpError extends Error {
  readonly name = 'SmtpError';
  readonly code: SmtpErrorCode;
  /** Numeric SMTP reply code of a server refusal, when there was one. */
  readonly responseCode?: number;

  constructor(code: SmtpErrorCode, message: string, responseCode?: number) {
    super(message);
    this.code = code;
    this.responseCode = responseCode;
  }
}
