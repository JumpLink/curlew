/**
 * Keeping the sent copy of a mail (#108): after SMTP accepted a message, the same bytes are filed
 * in the account's Sent mailbox with `\Seen`, so the person's half of the conversation survives a
 * reload and shows in every other client.
 *
 * Pure on purpose: the IMAP side is a small port (`SentFolderSession`), so the decision of
 * whether and where to file is tested on both runtimes without a socket.
 */

import type { FolderInfo } from '@curlew/protocol';
import { _, fmt } from '@curlew/protocol';

/** The three IMAP operations the filing needs; the GJS client implements them. */
export interface SentFolderSession {
  listFolders(): Promise<FolderInfo[]>;
  /** Whether the mailbox already holds a message with this `Message-ID` (`<id@host>`). */
  hasMessageId(path: string, messageId: string): Promise<boolean>;
  /** APPEND with the `\Seen` flag. */
  append(path: string, raw: Uint8Array): Promise<void>;
}

export type SentCopyOutcome = 'filed' | 'provider-files-it' | 'already-there';

/** Files one sent message (raw bytes, its Message-ID); throws when it could not. */
export type SentCopyFiler = (raw: Uint8Array, messageId: string) => Promise<SentCopyOutcome>;

/** Providers that file every SMTP submission in Sent themselves: a second copy would be a duplicate. */
const AUTO_FILING_HOSTS = ['imap.gmail.com', 'imap.googlemail.com'];

export function providerFilesSentMail(imapHost: string): boolean {
  return AUTO_FILING_HOSTS.includes(imapHost.trim().toLowerCase());
}

/**
 * File one sent message. Throws when it could not be filed (no Sent mailbox, a server refusal);
 * the caller turns that into a warning, because the mail is out either way.
 */
export async function fileSentCopy(
  session: SentFolderSession,
  raw: Uint8Array,
  messageId: string,
  imapHost: string,
): Promise<SentCopyOutcome> {
  if (providerFilesSentMail(imapHost)) return 'provider-files-it';
  const sent = (await session.listFolders()).find((f) => f.role === 'sent' && f.selectable);
  if (!sent) throw new Error(_('the account has no Sent mailbox'));
  if (await session.hasMessageId(sent.path, messageId)) return 'already-there';
  await session.append(sent.path, raw);
  return 'filed';
}

/** One sentence for the person: the mail went out, only the copy did not get filed. */
export function sentCopyWarning(error: unknown): string {
  return fmt(_('The message was sent, but its copy could not be saved to the Sent folder: {reason}'), {
    reason: error instanceof Error ? error.message : String(error),
  });
}
