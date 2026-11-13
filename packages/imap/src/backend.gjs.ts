/**
 * The IMAP implementation of the `MailBackend` port (GJS-only).
 *
 * This is the adapter that lets `@curlew/store` run the sync engine without ever importing
 * `gi://`. Everything IMAP-shaped stays on this side of the port; the engine sees only plain
 * data.
 */

import {
  type AccountPrompter,
  type BackendAccount,
  type BackendContext,
  type ListAccountsOptions,
  visibleAccounts,
  type BackendFlagState,
  type BackendMessage,
  type BackendSession,
  type FolderInfo,
  type MailBackend,
  type MailTarget,
  type MessageSender,
  type SendBackend,
  type SendPermit,
  decodeBytes,
  extractBodySection,
  hasFlag,
  type ImapValue,
  latin1ToBytes,
  parseEnvelope,
  parseFetchAttributes,
  pickBodyPart,
  isEncryptedStructure,
  quotedPrintableToBytes,
  base64ToBytes,
  attachmentParts,
  extractHeaderFields,
  parseMessageIdList,
  parseThreadHeaders,
  threadHeaderFetchItem,
  tokenizeImapList,
  walkBodyStructure,
} from '@curlew/protocol';
import { ImapClient, type ImapResponse } from './client.gjs.ts';
import { addMailAccount } from './add-account.ts';
import { readOwnAccounts, removeOwnAccount, type OwnMailAccount } from './own-accounts.ts';
import { mailSecretsDir, resolveMailTargets } from './targets.ts';
import { MAIL_MANIFEST } from './manifest.ts';
import { isOwnAddressOf, openMailSender } from './send.ts';

/**
 * How much body text is indexed per message.
 *
 * Deliberately far above the 50 000-character DISPLAY cap: this is the searchable corpus, and a
 * term that appears only on page four of a long thread is exactly what a search is for.
 */
const MAX_INDEX_BODY_CHARS = 200_000;

function* fetchItems(response: ImapResponse): Generator<ImapValue[]> {
  for (const line of response.lines) {
    if (!/^\*\s+\d+\s+FETCH\s+\(/i.test(line)) continue;
    yield tokenizeImapList(line, response.literals);
  }
}

function formatAddresses(list: Array<{ name: string | null; email: string }>): string {
  return list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ');
}

/** Decode one fetched part's bytes according to its transfer encoding. */
function decodePart(raw: string, encoding: string, charset: string | undefined): string {
  const enc = encoding.toLowerCase();
  const bytes =
    enc === 'base64'
      ? base64ToBytes(raw)
      : enc === 'quoted-printable'
        ? quotedPrintableToBytes(raw)
        : latin1ToBytes(raw);
  return decodeBytes(bytes, charset);
}

/** Strip tags when only an HTML part exists, so the index holds words rather than markup. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

class ImapBackendSession implements BackendSession {
  private readonly client: ImapClient;

  constructor(client: ImapClient) {
    this.client = client;
  }

  async listFolders(): Promise<FolderInfo[]> {
    return this.client.listFolders();
  }

  async openFolder(path: string) {
    // EXAMINE, not SELECT: read-only at the protocol level, so no code path here can set \Seen
    // even by accident.
    return this.client.examine(path);
  }

  async fetchNewer(path: string, afterUid: number, batchSize: number): Promise<BackendMessage[]> {
    const start = afterUid + 1;
    const response = await this.client.fetchRange(
      `${start}:*`,
      `(UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE BODYSTRUCTURE ${threadHeaderFetchItem()})`,
    );
    if (!response.ok) return [];

    const messages: BackendMessage[] = [];
    for (const items of fetchItems(response)) {
      if (messages.length >= batchSize) break;
      const fetch = parseFetchAttributes(items);
      const uid = fetch.uid ? Number.parseInt(fetch.uid, 10) : Number.NaN;
      // `<n>:*` yields at least the highest existing UID even when n is past the end, so the
      // caller would otherwise re-index the newest message on every run.
      if (!Number.isInteger(uid) || uid < start) continue;

      const env = parseEnvelope(fetch.envelope);
      const thread = parseThreadHeaders(extractHeaderFields(items));
      const parts = walkBodyStructure(fetch.bodyStructure);
      const bodyPart = pickBodyPart(parts);
      const attachments = attachmentParts(parts).map((p) => ({
        section: p.section,
        filename: p.filename,
        mimeType: p.mimeType,
        size: p.size,
      }));

      let bodyText: string | null = null;
      if (bodyPart) {
        const bodyResponse = await this.client.fetchSection(String(uid), bodyPart.section);
        if (bodyResponse.ok) {
          const [bodyItems] = [...fetchItems(bodyResponse)];
          const raw = bodyItems ? extractBodySection(bodyItems, bodyPart.section) : '';
          const decoded = decodePart(raw, bodyPart.encoding, bodyPart.params.charset);
          const text = bodyPart.mimeType === 'text/html' ? htmlToText(decoded) : decoded;
          bodyText = text.length > MAX_INDEX_BODY_CHARS ? text.slice(0, MAX_INDEX_BODY_CHARS) : text;
        }
      }

      messages.push({
        uid,
        messageId: env.messageId,
        subject: env.subject,
        sender: formatAddresses(env.from),
        recipients: formatAddresses([...env.to, ...env.cc]),
        date: env.date,
        internalDate: fetch.internalDate,
        size: fetch.size,
        seen: hasFlag(fetch.flags, '\\Seen'),
        flagged: hasFlag(fetch.flags, '\\Flagged'),
        hasAttachment: attachments.length > 0,
        attachments,
        bodyText,
        from: env.from,
        to: env.to,
        cc: env.cc,
        // ENVELOPE's In-Reply-To is the fallback for a server that answered the header fetch
        // with nothing; both are the same header.
        inReplyTo: thread.inReplyTo ?? parseMessageIdList(env.inReplyTo)[0] ?? null,
        references: thread.references,
        automation: thread.automation,
        emailChat: thread.emailChat,
        ...(thread.reaction ? { reaction: true } : {}),
        ...(isEncryptedStructure(parts) ? { encrypted: true } : {}),
      });
    }
    // Ascending, so the engine's cursor advances monotonically.
    messages.sort((a, b) => a.uid - b.uid);
    return messages;
  }

  async listFlags(path: string): Promise<BackendFlagState[]> {
    // Re-open explicitly rather than relying on a prior openFolder still being in effect. The
    // engine does call them in that order today, but a FETCH against whatever mailbox happens
    // to be selected is the kind of implicit coupling that silently indexes the wrong folder.
    await this.client.examine(path);
    const response = await this.client.fetchRange('1:*', '(UID FLAGS)');
    if (!response.ok) return [];
    const states: BackendFlagState[] = [];
    for (const items of fetchItems(response)) {
      const fetch = parseFetchAttributes(items);
      const uid = fetch.uid ? Number.parseInt(fetch.uid, 10) : Number.NaN;
      if (!Number.isInteger(uid)) continue;
      states.push({
        uid,
        seen: hasFlag(fetch.flags, '\\Seen'),
        flagged: hasFlag(fetch.flags, '\\Flagged'),
      });
    }
    return states;
  }

  async close(): Promise<void> {
    await this.client.logout();
  }
}

/** One HTTPS GET for server discovery. Anything but a 200 is "nothing published here". */
async function fetchText(url: string): Promise<string | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000), redirect: 'follow' });
  return response.ok ? await response.text() : null;
}

/** Prove the server accepts the login before the account is saved. */
async function testLogin(account: OwnMailAccount): Promise<void> {
  const client = new ImapClient();
  await client.connect({
    accountId: 'login-test',
    host: account.imap.host,
    port: account.imap.port,
    user: account.imap.user,
    implicitTls: true,
    getPassword: () => account.password,
  });
  try {
    await client.login(account.imap.user, account.password);
  } finally {
    await client.logout().catch(() => {});
  }
}

/** The live IMAP backend: the accounts Curlew holds itself, then those of the system (GNOME Online Accounts). */
export class ImapBackend implements MailBackend, SendBackend {
  readonly manifest = MAIL_MANIFEST;
  readonly kind = 'mailbox' as const;
  private targets: MailTarget[] | null = null;
  private readonly context: Pick<BackendContext, 'secretsDir' | 'disabledAccounts'>;

  /** Without a context (the CLI's direct reads) the accounts live where the registry would put them. */
  constructor(context?: Pick<BackendContext, 'secretsDir' | 'disabledAccounts'>) {
    this.context = context ?? { secretsDir: mailSecretsDir() };
  }

  private async allTargets(): Promise<MailTarget[]> {
    if (!this.targets) this.targets = await resolveMailTargets(undefined, this.context.secretsDir);
    return this.targets;
  }

  async listAccounts(options?: ListAccountsOptions): Promise<BackendAccount[]> {
    const own = readOwnAccounts(this.context.secretsDir);
    const accounts = (await this.allTargets()).map((t) => ({
      id: t.accountId,
      // An own account is known by its address; the login name can differ from it.
      identity: own.get(t.accountId)?.address ?? t.user,
      provider: 'imap_smtp',
    }));
    return visibleAccounts(this.context, accounts, options);
  }

  /** Add an account Curlew holds itself: no GNOME Online Accounts needed, so it works in a Flatpak. */
  async addAccount(prompter: AccountPrompter): Promise<BackendAccount> {
    const account = await addMailAccount(this.context.secretsDir, prompter, { fetchText, testLogin });
    this.targets = null;
    return account;
  }

  /** Unlink an own account. A system account is the system's to remove, not ours. */
  async removeAccount(accountId: string): Promise<void> {
    removeOwnAccount(this.context.secretsDir, accountId);
    this.targets = null;
  }

  async connect(accountId: string): Promise<BackendSession> {
    const target = (await this.allTargets()).find((t) => t.accountId === accountId);
    if (!target) throw new Error(`no mail account with id ${accountId}`);
    const client = new ImapClient();
    await client.connect(target);
    await client.login(target.user, await target.getPassword());
    return new ImapBackendSession(client);
  }

  /**
   * The send port (ADR 0004, amended 2026-10-30): SMTP through GOA, behind a `mail.send` permit.
   * The permit is checked again on every send; this method reads no password.
   */
  async openSender(accountId: string, permit: SendPermit): Promise<MessageSender> {
    return openMailSender(accountId, permit);
  }

  /** The account's own mail address; an account without SMTP has none to recognise. */
  async isSelfAddress(accountId: string, to: string): Promise<boolean> {
    return isOwnAddressOf(accountId, to);
  }
}
