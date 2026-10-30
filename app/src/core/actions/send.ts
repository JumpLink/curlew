/**
 * `curlew send` / `send_message` — one message from a granted account, whatever its backend.
 *
 * Both frontends call this, and this is where the grant is checked (ADR 0004 §4, amended
 * 2026-10-30): the CLI is no back door for an agent with a shell. The account names the backend
 * one way only — it is resolved through the registry — and the grant names the pair exactly:
 * `<backend>.send` for `<account>/<address>`. A grant for another address, or for another
 * backend, is refused before anything opens a connection.
 *
 * A backend's send path exists only on a handle opened with a permit from a grant
 * (`SendBackend.openSender`, the `GrantedXmppSession` / Signal `guardedFetch` pattern); the
 * permit lists the addresses granted for this account and the handle checks them again.
 *
 * An XMPP image goes out as its OWN stanza after the text (XEP-0066 practice: a client renders
 * the file inline only when the body is exactly the URL, so a caption cannot share the stanza).
 * Text and image are therefore two stanzas, two origin-ids, two write-log lines and two index
 * rows. A backend without `sendImage` refuses an image rather than sending a bare URL.
 *
 * A backend whose send writes the same protocol state its receive path writes — Signal's
 * double-ratchet session, `manifest.sendSharesReceiveState` — is serialised against the daemon
 * here, through the receive lease (`holdReceiveLease`): a send while another process receives that
 * account is refused, because a corrupted session is not something a retry fixes.
 *
 * Order matters: send, then the write log, then index the outgoing message. Once the server has
 * the message it is sent, whatever happens next: the log line records that, and a failing log is
 * a failed call. Indexing is best effort — a busy or broken index must not report a delivered
 * message as failed, or a caller that retries sends it twice. The daemon's catch-up (carbons,
 * MAM) stores the message later anyway.
 */

import {
  chatConversationId,
  configPath,
  indexDbPath,
  recordSentChatMessage,
  releaseReceiveLease,
  takeReceiveLease,
} from '@curlew/store';
import type { LeaseTake, SentChatRecord } from '@curlew/store';
import type { MessageBackend, MessageSender, SentMessage, SendPermit } from '@curlew/protocol';
import { isSendBackend } from '@curlew/protocol';
import { isOmemoSendRefusedError, MESSAGES, validateImageUrl, XmppBackend } from '@curlew/xmpp';
import { builtinRegistry } from '../backends/builtin.ts';
import { backendContext } from '../backends/context.ts';
import { loadConfig, type CurlewConfig } from '../config.ts';
import { type Capability, type Grant, isGranted, isSendCapability } from '../grants.ts';
import { MAX_CHUNK_CHARS, renderForXmpp, type MessageFormat } from '../markdown.ts';
import { appendWriteLog, type WriteFrontend } from '../write-log.ts';
import { openIndex } from './index-sync.ts';
import { decryptAccounts, encryptionRequired, requireEncryptionFor } from './omemo.ts';
import { _, fmt } from '@curlew/protocol';

/** The chat send capability, still the one the daemon follows accounts under. */
export const SEND_CAPABILITY = 'xmpp.send';

export interface SendParams {
  accountId: string;
  /** The address exactly as the grant spells it. */
  to: string;
  /** The message text. At least one of `text` and `imageUrl` is required. */
  text?: string;
  /** An https URL sent as its own message (body = URL + XEP-0066 `jabber:x:oob`), shown inline by clients. */
  imageUrl?: string;
  /** Mail only: the subject line. A backend whose manifest has no `subject` refuses it. */
  subject?: string;
  /** `plain` (default) sends `text` as is; `markdown` renders it per chat protocol and splits long texts. */
  format?: MessageFormat;
  frontend: WriteFrontend;
  dbPath?: string;
  configPath?: string;
  /** Where the write log goes; injected by tests. */
  writeLogPath?: string;
  /** Injected by tests: the backend that opens the granted sender. */
  backend?: MessageBackend;
}

export interface SendResult {
  /** The backend that sent it, as its manifest names it. */
  backend: string;
  /** The grant target: `<account>/<address>`. */
  target: string;
  /** The conversation to watch for a reply; absent for a backend whose sent copy is not indexed (mail). */
  conversationId?: string;
  /** The indexed row, or null when the message went out but could not be indexed (see `indexError`). */
  messageId?: string | null;
  /** Why indexing failed; the message was delivered regardless. */
  indexError?: string;
  /** The chat's remote id, for a chat backend. */
  chatJid?: string;
  /** The first message's id — what the write log recorded. */
  originId: string;
  /** The image message's id when text AND image were sent. */
  imageOriginId?: string;
  /** Local clock, ISO 8601: pass it as `since` when waiting for the reply. */
  sentAt: string;
  /** Markdown only: how many messages went out (text parts and images). */
  parts?: number;
  /** Markdown only: every message's origin-id, in order. */
  originIds?: string[];
  /** The message went out, but something around it did not — the backend's one sentence for it. */
  sendWarning?: string;
}

/**
 * The receive lease, held across a send whose backend shares its protocol state with the receive
 * path (`manifest.sendSharesReceiveState`).
 *
 * Signal is that backend: the double-ratchet session lives in one file with no lock, and the
 * daemon loads it whole. Two writers would leave the session somewhere neither the sender nor the
 * recipient can decrypt from, and no amount of retrying fixes a broken ratchet — so a send takes
 * the same lease the receive path takes (ADR 0002 §4), and a send while the daemon holds the
 * account is REFUSED rather than risked. The user stops the daemon, or sends from the phone.
 *
 * It is taken here and not in the backend because the lease lives in the index, which a backend
 * does not reach: `@curlew/store` must never import a backend, and a backend never opens the index.
 */
function holdReceiveLease(dbPath: string, backend: string, accountId: string): { release(): void } {
  const holder = `send-${process.pid}`;
  const db = openIndex(dbPath);
  let take: LeaseTake;
  try {
    take = takeReceiveLease(db, backend, accountId, holder, new Date());
  } catch (error) {
    db.close();
    throw new Error(
      fmt(
        _(
          'the message index is busy, so curlew cannot tell whether {account} is in use elsewhere — nothing was sent; try again in a moment',
        ),
        { account: accountId },
      ),
      { cause: error },
    );
  }
  if (!take.acquired) {
    db.close();
    throw new Error(
      take.holder === null
        ? fmt(
            _(
              'the message index is busy, so curlew cannot tell whether {account} is in use elsewhere — nothing was sent; try again in a moment',
            ),
            { account: accountId },
          )
        : fmt(
            _(
              '{account} is being received by {holder} right now, and {backend} cannot send and receive at the same time — nothing was sent; stop that process (`curlew daemon stop`) and send again, or send from your phone',
            ),
            { account: accountId, holder: take.holder, backend },
          ),
    );
  }
  return {
    release: () => {
      try {
        releaseReceiveLease(db, backend, accountId, holder);
      } catch {
        // The message is out: a lease that could not be dropped expires on its own, and failing
        // the call here would get the message sent twice on a retry.
      } finally {
        db.close();
      }
    },
  };
}

/** The grant target of a `*.send` pair. */
export function sendTarget(accountId: string, to: string): string {
  return `${accountId}/${to}`;
}

/** The addresses the grants allow for one account — what the sender's permit lists. */
export function permitFor(
  grants: readonly Grant[],
  accountId: string,
  capability: Capability = SEND_CAPABILITY,
): SendPermit {
  const prefix = `${accountId}/`;
  return {
    account: accountId,
    addresses: grants
      .filter((g) => g.capability === capability && g.target.startsWith(prefix))
      .map((g) => g.target.slice(prefix.length)),
  };
}

/** Throw unless the grants name exactly this pair for this capability. */
export function requireSendGrant(
  config: Pick<CurlewConfig, 'grants'>,
  accountId: string,
  to: string,
  capability: Capability = SEND_CAPABILITY,
): void {
  if (!isGranted(config.grants, capability, sendTarget(accountId, to))) {
    const target = sendTarget(accountId, to);
    throw new Error(
      fmt(_('{capability} is not granted for {target} — add {grant} to the grants in the config file'), {
        capability,
        target,
        grant: `{ "capability": "${capability}", "target": "${target}" }`,
      }),
    );
  }
}

/** The `<backend>.send` capabilities that name exactly this pair. Empty = nothing granted. */
export function sendCapabilitiesFor(
  grants: readonly Grant[] | undefined,
  accountId: string,
  to: string,
): Capability[] {
  const target = sendTarget(accountId, to);
  return (grants ?? [])
    .filter((g) => isSendCapability(g.capability) && g.target === target)
    .map((g) => g.capability);
}

/** Throw unless SOME `<backend>.send` names exactly this pair — before any backend is constructed. */
export function requireAnySendGrant(
  config: Pick<CurlewConfig, 'grants'>,
  accountId: string,
  to: string,
): Capability[] {
  const capabilities = sendCapabilitiesFor(config.grants, accountId, to);
  if (capabilities.length === 0) {
    const target = sendTarget(accountId, to);
    throw new Error(
      fmt(
        _(
          'sending to {target} is not granted — add a grant like {grant} to the config file, naming the account and the address',
        ),
        {
          target,
          grant: `{ "capability": "<backend>.send", "target": "${target}" }`,
        },
      ),
    );
  }
  return capabilities;
}

/**
 * The registry's backend for one account, or the one a test injected. Only backends named by a
 * granted `<backend>.send` are asked, so a send never constructs a backend nobody granted (and
 * never touches GOA to find the XMPP account).
 */
export async function resolveSendBackend(
  config: CurlewConfig,
  capabilities: readonly Capability[],
  accountId: string,
  injected?: MessageBackend,
): Promise<MessageBackend> {
  if (injected) return injected;
  const registry = builtinRegistry();
  for (const capability of capabilities) {
    const name = capability.slice(0, -'.send'.length);
    const backend = registry.create(config, name, backendContext(name, config));
    const accounts = await backend.listAccounts();
    if (accounts.some((a) => a.id === accountId)) return backend;
  }
  throw new Error(fmt(_('no account {account} — `curlew accounts list` shows them'), { account: accountId }));
}

/** The registry's xmpp backend, typed for its granted handle. The daemon follows one account. */
export function createXmppBackend(config: CurlewConfig): XmppBackend {
  const created = builtinRegistry().create(config, 'xmpp', backendContext('xmpp', config));
  if (!(created instanceof XmppBackend)) throw new Error(_('the xmpp backend is not available'));
  return created;
}

export async function sendMessage(params: SendParams): Promise<SendResult> {
  const config = loadConfig(params.configPath ?? configPath());
  const granted = requireAnySendGrant(config, params.accountId, params.to);
  const backend = await resolveSendBackend(config, granted, params.accountId, params.backend);
  const capability = `${backend.manifest.name}.send` as Capability;
  // The account resolved to a backend no grant names for this pair: refuse before opening it.
  requireSendGrant(config, params.accountId, params.to, capability);
  if (!isSendBackend(backend))
    throw new Error(fmt(_('{backend} cannot send'), { backend: backend.manifest.name }));

  const text = params.text !== undefined && params.text.trim().length > 0 ? params.text : undefined;
  if (text === undefined && params.imageUrl === undefined)
    throw new Error(_('nothing to send: give text, an image URL or both'));
  if (params.subject !== undefined && !backend.manifest.capabilities.subject) {
    throw new Error(fmt(_('{backend} messages carry no subject'), { backend: backend.manifest.name }));
  }
  // Validated before anything is sent, so a bad URL cannot leave the text half-delivered.
  const imageUrl = params.imageUrl === undefined ? undefined : validateImageUrl(params.imageUrl);

  const account = (await backend.listAccounts()).find((a) => a.id === params.accountId);
  if (!account) {
    throw new Error(
      fmt(_('no {backend} account {account} — `curlew accounts list` shows them'), {
        backend: backend.manifest.name,
        account: params.accountId,
      }),
    );
  }

  // `xmpp.omemo` for this account turns the send path encrypted: the session then asks the peer
  // for their devices and refuses rather than sending a message in the clear that the person
  // believes is encrypted (ADR 0006 §7). Without the grant nothing changes — unless the config
  // requires encryption for this peer, which without keys cannot be honoured at all.
  const decrypt = decryptAccounts(config.grants).includes(params.accountId);
  if (!decrypt && encryptionRequired(config, params.accountId, params.to))
    throw new Error(MESSAGES.omemoRequiredWithoutGrant(params.accountId, params.to));
  const permit = permitFor(config.grants, params.accountId, capability);
  const dbPath = params.dbPath ?? indexDbPath();
  // Before the handle exists, so a refusal costs no connection (see `holdReceiveLease`).
  const lease = backend.manifest.sendSharesReceiveState
    ? holdReceiveLease(dbPath, backend.manifest.name, params.accountId)
    : null;
  let sender: MessageSender;
  try {
    sender = await backend.openSender(params.accountId, permit, {
      decrypt,
      requireEncryption: requireEncryptionFor(config, params.accountId, permit.addresses),
    });
  } catch (error) {
    lease?.release();
    throw error;
  }

  // A plain-text transport still gets the text — as written; only a chat sender renders Markdown.
  const markdown = params.format === 'markdown' && sender.features.markdown;
  const sends: Array<{ sent: SentMessage; body: string }> = [];
  // Everything the open handle is needed for, so the one `finally` closes it and gives the lease
  // back — a refusal in the plan below used to leave both to the garbage collector.
  try {
    const plan: Array<{ kind: 'text' | 'image'; value: string }> = [];
    if (markdown && text !== undefined) {
      for (const seg of renderForXmpp(text, undefined, MAX_CHUNK_CHARS))
        plan.push(
          seg.kind === 'text' ? { kind: 'text', value: seg.text } : { kind: 'image', value: seg.url },
        );
    } else if (text !== undefined) {
      plan.push({ kind: 'text', value: text });
    }
    if (imageUrl !== undefined) {
      if (sender.sendImage === undefined) {
        throw new Error(
          fmt(_('{backend} cannot send an image — give text and leave image_url out'), {
            backend: backend.manifest.name,
          }),
        );
      }
      plan.push({ kind: 'image', value: imageUrl });
    }
    if (plan.length === 0) throw new Error(_('nothing to send: the text is empty after rendering'));
    for (const step of plan) if (step.kind === 'image') step.value = validateImageUrl(step.value);

    for (const step of plan)
      sends.push({
        sent:
          step.kind === 'text'
            ? await sender.send({
                to: params.to,
                text: step.value,
                ...(params.subject === undefined ? {} : { subject: params.subject }),
              })
            : await sender.sendImage!(params.to, step.value),
        body: step.value,
      });
  } catch (error) {
    // The typed refusal carries a reason, not a sentence. Turned into one here, where the
    // address is known, so the person reads what to do rather than an enum.
    if (isOmemoSendRefusedError(error)) throw new Error(MESSAGES.omemoRefused[error.reason](params.to));
    throw error;
  } finally {
    await sender.close().catch(() => {});
    lease?.release();
  }

  const recorded = sends.map(({ sent, body }) => {
    appendWriteLog(
      {
        capability,
        target: sendTarget(params.accountId, params.to),
        frontend: params.frontend,
        id: sent.id,
      },
      { path: params.writeLogPath },
    );
    return sent.chatRemoteId === undefined
      ? {}
      : recordDelivered(
          dbPath,
          account,
          { chatJid: sent.chatRemoteId, originId: sent.id, text: body, sentAt: sent.sentAt },
          backend.manifest.name,
        );
  });
  const first = sends[0];
  // Each part carries its own; the same gap reported twice is one sentence, not two.
  const warnings = [...new Set(sends.map((x) => x.sent.warning).filter((w) => w !== undefined))];
  return {
    backend: backend.manifest.name,
    target: sendTarget(params.accountId, params.to),
    ...recorded[0],
    ...(first.sent.chatRemoteId === undefined ? {} : { chatJid: first.sent.chatRemoteId }),
    originId: first.sent.id,
    ...(!markdown && sends.length > 1 ? { imageOriginId: sends[1].sent.id } : {}),
    ...(markdown ? { parts: sends.length, originIds: sends.map((x) => x.sent.id) } : {}),
    sentAt: first.sent.sentAt,
    ...(warnings.length === 0 ? {} : { sendWarning: warnings.join(' ') }),
  };
}

/** Index a delivered message. Never throws: the message is out, so a failure here is only reported. */
export function recordDelivered(
  dbPath: string,
  account: SentChatRecord['account'],
  sent: { chatJid: string; originId: string; text: string; sentAt: string },
  backend = 'xmpp',
): { conversationId: string; messageId: string | null; indexError?: string } {
  try {
    const db = openIndex(dbPath);
    try {
      return recordSentChatMessage(db, {
        backend,
        account,
        chatRemoteId: sent.chatJid,
        clientId: sent.originId,
        text: sent.text,
        sentAt: sent.sentAt,
      });
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      conversationId: chatConversationId(backend, account.id, sent.chatJid),
      messageId: null,
      indexError: error instanceof Error ? error.message : String(error),
    };
  }
}
