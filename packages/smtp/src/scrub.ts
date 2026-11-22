import type { SmtpErrorCode } from './errors.ts';
import type { SmtpAccount } from './types.ts';

/** Longest server reply text that goes into an error message. */
const MAX_REPLY_LENGTH = 200;

export const SUMMARY: Record<SmtpErrorCode, string> = {
  auth: 'SMTP login failed',
  tls: 'SMTP TLS handshake failed',
  connect: 'SMTP connection failed',
  rejected: 'SMTP server rejected the message',
  config: 'SMTP configuration is invalid',
};

export function secretsOf(account: SmtpAccount): string[] {
  return account.auth.kind === 'password' ? [account.auth.password] : [account.auth.accessToken];
}

/** The reply text with every form of a secret removed, flattened to one bounded line. */
export function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    for (const form of [secret, btoa(secret)]) out = out.split(form).join('[redacted]');
  }
  return out.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, MAX_REPLY_LENGTH);
}
