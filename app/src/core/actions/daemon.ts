/**
 * `curlew daemon` — the receiving daemon (ADR 0002).
 *
 * A delivery-only backend (Signal, WhatsApp) has no server archive: the network forgets a message
 * once this device acknowledged it, so what this process writes is the only copy there will ever
 * be. That makes "sync every so often" a data-loss window, and WhatsApp unlinks a linked device
 * that stays away for about two weeks. A `sync` from a timer narrows the window; this closes it.
 *
 * What it does, and nothing else:
 *
 *   - receives from every ENABLED delivery-only backend, every account, `mode: 'follow'`, all at
 *     once (a follow session ends only when it is closed, so a queue would starve every account
 *     behind the first). Mail and chat backends stay on `curlew sync`: they are pull models
 *     with a cursor, and a daemon buys them nothing;
 *   - also follows every ENABLED XMPP account (`follow.ts`, ADR 0008): carbons live, the archive
 *     as the truth, so a reply reaches the index within seconds. An enabled account is the
 *     person's own — no grant is needed to follow it; grants restrict agents. It decrypts OMEMO for
 *     every one of them (ADR 0009 §9): bodies are gated per contact when an agent reads them;
 *   - follows every ENABLED Matrix account (ADR 0007 §5): the SDK's `/sync` long poll
 *     (`set_presence=offline`, through the read-only gate) keeps the client current, a new event
 *     is only a wake-up, and the same history walk `curlew sync` runs writes it. No new switch:
 *     enabling the backend is the opt-in. A device the homeserver logs out is stopped, not retried;
 *   - follows every ENABLED Telegram account the same way: mtcute's update stream is only a
 *     wake-up (`TelegramLive`), the read-only chat sync writes, and the handle never sends;
 *   - takes the receive lease per account, so a `sync` on the same account stands down — two
 *     devices on one account each acknowledge half the copy (`@curlew/store`);
 *   - reconnects a dropped session with backoff, and stops an account the network logged out;
 *   - rebuilds the conversations debounced, and once on stop, with the same address-book step
 *     `indexSync` uses;
 *   - SENDS for the accounts it is holding, when asked over the session bus (ADR 0004, amendment
 *     2026-10-30). A Signal or WhatsApp send cannot run in a second process while this one is
 *     receiving, so `curlew send` hands it here and it goes out on the connection that is already
 *     up. The daemon checks no grant (ADR 0008: grants gate the agent frontends, and this is the
 *     person's send service) and writes neither the log line nor the index row — the caller owns
 *     both, so each happens exactly once whichever process reached the network;
 *   - logs one line per state change to stderr, where journald collects it. Never message text,
 *     chat titles, peer names or phone numbers — a log line is a file that gets copied around,
 *     and the index's privacy rule applies to it.
 *
 * The stop is the other half: `params.signal` aborts, every account's session is closed, every
 * loop is awaited (so the last batch is written and nothing unacknowledged is lost), the
 * conversations are rebuilt once, the database is closed, and the caller exits 0. A daemon that
 * was asked to stop did its job.
 */

import { createHash } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  type ChatSession,
  type DeliverySession,
  type MessageBackend,
  type MessageRef,
  type MessageSender,
  type SendPermit,
  isAttachmentFetcherBackend,
  isChatBackend,
  isDeliveryBackend,
  isMailBackend,
  _,
  fmt,
} from '@curlew/protocol';
import type { DeliveryProgress, DeliverySyncResult, IndexDatabase, RebuildResult } from '@curlew/store';
import {
  ensurePrivateDir,
  FileSink,
  loadAttachmentHandle,
  loadAttachments,
  newestSeq,
  readChanges,
  previewsDir,
  receiveDeliveries,
  resolveDownloadPath,
} from '@curlew/store';
import { MatrixBackend } from '@curlew/matrix';
import { TelegramBackend } from '@curlew/telegram';
import { XmppBackend } from '@curlew/xmpp';
import { builtinRegistry } from '../backends/builtin.ts';
import { backendContext } from '../backends/context.ts';
import { loadConfig, saveConfig, type CurlewConfig } from '../config.ts';
import { AccessBroker, type PromptUi } from '../access-broker.ts';
import { withAllowRule } from '../access.ts';
import { gioNotificationPrompt } from '../lib/access-notifications.ts';
import { gioNoticeSink, type NoticeSink } from '../lib/message-notifications.ts';
import { newNoticeState, planNotices } from '../lib/message-notices.ts';
import { contactNameFromIndex } from '../lib/contact-name.ts';
import type { Capability } from '../grants.ts';
import { configPath } from '@curlew/store';
import { AccountTable } from '../lib/daemon-accounts.ts';
import { DAEMON_WIRE_VERSION, type DaemonSendReply } from '../lib/daemon-bus.ts';
import {
  publishDaemonSend,
  type DaemonFetchHandler,
  type DaemonSendHandler,
  type DaemonSendService,
} from '../lib/daemon-send-service.ts';
import { followAccount, type FollowResult } from './follow.ts';
import { openIndex, rebuildWithAddressBook } from './index-sync.ts';
import { reactThrough } from './react.ts';
import { sendThrough } from './send.ts';

/** How often a running daemon looks whether another process moved the journal (ADR 0007 §2). */
export const CHANGE_POLL_MS = 2_000;

/** How long the conversations wait for the last written batch before they are rebuilt. */
export const REBUILD_DEBOUNCE_MS = 30_000;

export interface DaemonParams {
  /** The index to write; the default is the user's. `:memory:` is a test's. */
  dbPath?: string;
  configPath?: string;
  /** Restrict to one account; omit for all. */
  accountId?: string;
  /** SIGTERM/SIGINT land here. The run ends normally — see the module comment. */
  signal?: AbortSignal;
  /** Short only in tests. */
  rebuildDebounceMs?: number;
  /** One line per state change; defaults to stderr. */
  log?: (line: string) => void;
  /**
   * The delivery backends to receive. Injected by tests; by default the ones the config enables,
   * chosen by the driver the backend implements — never by its name.
   */
  backends?: readonly MessageBackend[];
  /**
   * The XMPP backend whose accounts are followed. Injected by tests; by default the registry's,
   * when the config enables it, and `null` to follow none.
   */
  xmpp?: XmppBackend | null;
  /**
   * The Matrix backend whose accounts are followed. Injected by tests; by default the registry's,
   * when the config enables it, and `null` to follow none.
   */
  matrix?: MatrixBackend | null;
  /**
   * The Telegram backend whose accounts are followed. Injected by tests; by default the registry's,
   * when the config enables it, and `null` to follow none.
   */
  telegram?: TelegramBackend | null;
  /** Short only in tests. */
  changePollMs?: number;
  /** Where the write log goes; injected by tests. */
  writeLogPath?: string;
  /** Injected by tests; the address-book rebuild `indexSync` also uses. */
  rebuild?: (db: IndexDatabase) => Promise<RebuildResult & { contacts: number | null }>;
  /**
   * How the send interface is published; injected by tests, which have no session bus. `null`
   * publishes nothing, which is also what the default does when there is no bus to publish on —
   * the daemon then receives as it always did and a send refuses on the lease this run holds.
   */
  publishSend?: typeof publishDaemonSend | null;
  /** How an agent access prompt is shown; injected by tests, which have no notification server. */
  accessPrompt?: PromptUi;
  /**
   * Where a notification for a new chat message goes; `null` shows none. Absent means the desktop
   * for the user's own index and nothing for any other, so a test's synthetic messages never
   * reach a real notification server.
   */
  noticeSink?: NoticeSink | null;
  /** Short only in tests: how long a prompt waits for an answer. */
  accessTimeoutMs?: number;
}

export interface DaemonAccountResult {
  backend: string;
  accountId: string;
  batches: number;
  added: number;
  removed: number;
  /** Set when this run stopped receiving: a logged-out device, an error, or a lost lease. */
  error: string | null;
  /** Set when ANOTHER holder has the account (a second daemon): this run left it alone. */
  heldBy: string | null;
  /** Set when no lease could be taken because the index was busy — no holder is known. */
  indexBusy: boolean;
  loggedOut: boolean;
}

export interface DaemonResult {
  backends: string[];
  accounts: DaemonAccountResult[];
  added: number;
  removed: number;
  errors: number;
  conversations: (RebuildResult & { contacts: number | null }) | null;
  /** The XMPP accounts that were followed (ADR 0004 §5, ADR 0008). */
  followed: FollowResult[];
}

/** The registry's Matrix backend when the config enables it (the daemon follows it), else `null`. */
export function createMatrixBackend(config: CurlewConfig): MatrixBackend | null {
  const registry = builtinRegistry();
  if (!registry.enabled(config).some((plugin) => plugin.manifest.name === 'matrix')) return null;
  const created = registry.create(config, 'matrix', backendContext('matrix', config));
  return created instanceof MatrixBackend ? created : null;
}

/** The registry's Telegram backend when the config enables it (the daemon follows it), else `null`. */
export function createTelegramBackend(config: CurlewConfig): TelegramBackend | null {
  const registry = builtinRegistry();
  if (!registry.enabled(config).some((plugin) => plugin.manifest.name === 'telegram')) return null;
  const created = registry.create(config, 'telegram', backendContext('telegram', config));
  return created instanceof TelegramBackend ? created : null;
}

/** The registry's XMPP backend when the config enables it (the daemon follows it), else `null`. */
export function createEnabledXmppBackend(config: CurlewConfig): XmppBackend | null {
  const registry = builtinRegistry();
  if (!registry.enabled(config).some((plugin) => plugin.manifest.name === 'xmpp')) return null;
  const created = registry.create(config, 'xmpp', backendContext('xmpp', config));
  return created instanceof XmppBackend ? created : null;
}

/** The enabled delivery-only backends — what a daemon receives and what a `sync` stands down for. */
export function deliveryBackends(config: ReturnType<typeof loadConfig>): MessageBackend[] {
  const registry = builtinRegistry();
  return registry
    .enabled(config)
    .map((plugin) =>
      registry.create(config, plugin.manifest.name, backendContext(plugin.manifest.name, config)),
    )
    .filter((backend) => isDeliveryBackend(backend));
}

/**
 * The process exit code of a finished run.
 *
 * `2` when the run ended with nothing left to receive AND at least one account ended `loggedOut`:
 * the network dropped this device (WhatsApp's ~14-day unlink), a restart cannot relink it, and
 * `Restart=on-failure` would only hammer the network — so systemd is told NOT to restart
 * (`RestartPreventExitStatus=2`) and the unit shows as **failed**, which is the only signal that
 * says "nothing is being received and you have to link the device again".
 *
 * Everything else is `0`, including a normal SIGTERM stop, a run that is still receiving on
 * another account, and a machine with no linked account at all: a daemon that was asked to stop
 * did its job, and a non-zero code on a clean stop would restart-loop.
 */
export function daemonExitCode(run: Pick<DaemonResult, 'accounts'>): 0 | 2 {
  const dead = (account: DaemonAccountResult): boolean =>
    account.loggedOut || account.heldBy !== null || account.error !== null;
  if (run.accounts.length > 0 && run.accounts.every(dead) && run.accounts.some((a) => a.loggedOut)) {
    return 2;
  }
  return 0;
}

/** One log line. Names, counts and timings only — never anything a peer wrote. */
function line(event: DeliveryProgress, log: (line: string) => void): void {
  const who = `${event.backend}/${event.accountId}`;
  switch (event.type) {
    case 'connected':
      return log(`curlew-daemon: ${who} connected`);
    case 'batch':
      return log(
        `curlew-daemon: ${who} batch ${event.batches} written ` +
          `(added ${event.added}, edited ${event.edited}, removed ${event.removed})`,
      );
    case 'reconnect':
      return log(
        `curlew-daemon: ${who} reconnect in ${event.delayMs} ms (attempt ${event.attempt}` +
          `${event.reason ? `, ${event.reason}` : ''})`,
      );
    case 'logged-out':
      return log(
        `curlew-daemon: ${who} logged out — link the device again${event.error ? ` (${event.error})` : ''}`,
      );
    case 'lease-held':
      return log(`curlew-daemon: ${who} is held by ${event.holder} — not receiving it here`);
    case 'lease-busy':
      return log(
        `curlew-daemon: ${who} could not take its receive lease (the index is busy) — not receiving it here`,
      );
    case 'lease-waiting':
      return log(
        `curlew-daemon: ${who} is held by ${event.holder ?? 'another process'} — waiting for the lease`,
      );
    case 'lease-lost':
      return log(`curlew-daemon: ${who} lost the receive lease — stopping that account`);
    case 'lease-unrefreshable':
      return log(
        `curlew-daemon: ${who} could not refresh its receive lease (the index is busy) — stopping that account and taking it back`,
      );
    case 'stopped':
      return log(`curlew-daemon: ${who} stopped (${event.reason})`);
  }
}

/** How a session is found again: the pair a send names, and the pair `onSession` hands over. */
export function sessionKey(backend: string, accountId: string): string {
  return `${backend}/${accountId}`;
}

export interface DaemonSendHandlerOptions {
  /** The live sessions of this run, keyed by `sessionKey` — the map `onSession` keeps up to date. */
  sessions: ReadonlyMap<string, DeliverySession>;
  log: (line: string) => void;
}

export interface DaemonFetchHandlerOptions {
  /** The index the daemon is writing, so the handle can be looked up. */
  db: IndexDatabase;
  /** The backends that can fetch attachments for the accounts this run holds, keyed by `sessionKey`. */
  fetchBackends: ReadonlyMap<
    string,
    MessageBackend & { openAttachments: NonNullable<MessageBackend['openAttachments']> }
  >;
  log: (line: string) => void;
}

/** The directory the daemon keeps one attachment preview in; mirrors the window's `partDir`. */
function previewDirFor(ref: MessageRef, index: number, root: string): string {
  const key = [ref.accountId, ref.folder ?? '', ref.uid ?? '', ref.remoteId ?? '', String(index)].join(
    '\u0000',
  );
  return join(root, createHash('sha256').update(key).digest('hex'));
}

/**
 * Answer one `Send` off the session bus (ADR 0004, amendment 2026-10-30, daemon send).
 *
 * Separate from the transport and from the run so it can be tested without a bus: everything that
 * decides whether a send happens is here.
 *
 * Fail closed, in this order. The account has to be one this run holds a session for and the
 * session has to be able to send on itself, or the caller is told `not-followed` and its own
 * direct path decides what happens next. No grant is checked (ADR 0008): this is the person's
 * send service, and grants restrict the agent frontends, which check them before they get here.
 * The permit lists the one address asked for; the sender checks it again. Only then is a sender
 * opened, and it sends the ONE send plan `curlew send` would have sent (`sendThrough`), on the
 * connection that is already receiving.
 *
 * It writes no log line and indexes nothing: the caller owns both.
 */
export function createDaemonSendHandler(options: DaemonSendHandlerOptions): DaemonSendHandler {
  const { log, sessions } = options;
  return async (request) => {
    const who = sessionKey(request.backend, request.account);
    const session = sessions.get(who);
    if (session === undefined || session.openSender === undefined) {
      log(`curlew-daemon: a send for ${who} is not this daemon's to make — the caller keeps it`);
      return { v: DAEMON_WIRE_VERSION, kind: 'not-followed' };
    }
    let permit: SendPermit;
    try {
      const capability = `${request.backend}.send` as Capability;
      if (request.capability !== capability) {
        throw new Error(
          fmt(_('{capability} is not what {backend} sends under — nothing was sent'), {
            capability: request.capability,
            backend: request.backend,
          }),
        );
      }
      permit = { account: request.account, addresses: [request.to] };
    } catch (error) {
      log(
        `curlew-daemon: a send for ${who} was refused — the request names a capability this backend does not send under`,
      );
      return { v: DAEMON_WIRE_VERSION, kind: 'refused', message: errText(error) };
    }
    let sender: MessageSender;
    try {
      sender = await session.openSender(permit);
    } catch (error) {
      // Nothing is on the wire yet, and saying so is worth a sentence of its own: the caller
      // prints it to someone who has to decide whether to send again.
      return {
        v: DAEMON_WIRE_VERSION,
        kind: 'failed',
        message: fmt(_('the running curlew daemon could not open a sender ({reason}) — nothing was sent'), {
          reason: errText(error),
        }),
      };
    }
    try {
      if (request.reaction !== undefined) {
        await reactThrough(sender, { to: request.to, ...request.reaction }, request.backend);
        log(`curlew-daemon: reacted for ${who} on its open connection`);
        return { v: DAEMON_WIRE_VERSION, kind: 'sent', markdown: false, steps: [] };
      }
      const outcome = await sendThrough(
        sender,
        {
          to: request.to,
          ...(request.text === undefined ? {} : { text: request.text }),
          ...(request.imageUrl === undefined ? {} : { imageUrl: request.imageUrl }),
          ...(request.subject === undefined ? {} : { subject: request.subject }),
          ...(request.attachments === undefined || request.attachments.length === 0
            ? {}
            : { attachments: request.attachments }),
          ...(request.replyTo === undefined ? {} : { replyTo: request.replyTo }),
          ...(request.format === undefined ? {} : { format: request.format }),
        },
        request.backend,
      );
      log(`curlew-daemon: sent ${outcome.steps.length} message(s) for ${who} on its open connection`);
      return { v: DAEMON_WIRE_VERSION, kind: 'sent', markdown: outcome.markdown, steps: outcome.steps };
    } catch (error) {
      log(`curlew-daemon: a send for ${who} did not complete`);
      return { v: DAEMON_WIRE_VERSION, kind: 'failed', message: errText(error) } satisfies DaemonSendReply;
    } finally {
      // Only what this send opened: the session's own connection stays up and receiving.
      await sender.close().catch(() => {});
    }
  };
}

/**
 * Answer one `FetchAttachment` off the session bus (ADR 0010).
 *
 * Like `createDaemonSendHandler`, this is separate from the transport so it can be tested without
 * a bus. The account has to be one this run holds a chat session for and the backend has to be
 * able to fetch attachments, or the caller is told `not-followed` and its own direct path decides.
 * The daemon writes the file to its private previews directory and returns the path: the caller
 * cannot choose the directory, only receive what the daemon wrote.
 */
export function createDaemonFetchHandler(options: DaemonFetchHandlerOptions): DaemonFetchHandler {
  const { db, fetchBackends, log } = options;
  return async (request) => {
    const who = sessionKey(request.backend, request.account);
    const backend = fetchBackends.get(who);
    if (backend === undefined) {
      log(`curlew-daemon: an attachment fetch for ${who} is not this daemon's to make — the caller keeps it`);
      return { v: DAEMON_WIRE_VERSION, kind: 'not-followed' };
    }
    const ref: MessageRef = {
      backend: request.backend,
      accountId: request.account,
      remoteId: request.remoteId,
    };
    const infos = loadAttachments(db, ref);
    const info = infos.find((a) => a.index === request.index);
    const handle = info === undefined ? null : loadAttachmentHandle(db, ref, request.index);
    if (info === undefined || !info.fetchable || handle === null || handle === '') {
      log(`curlew-daemon: an attachment fetch for ${who} found no handle in the index`);
      return {
        v: DAEMON_WIRE_VERSION,
        kind: 'failed',
        message: _('the attachment was not found in the index'),
      };
    }
    const dir = ensurePrivateDir(previewDirFor(ref, request.index, previewsDir()));
    // A stale cached file would make `resolveDownloadPath` pick a colliding name, so clear first.
    for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true });
    const path = resolveDownloadPath(dir, info.filename, 'attachment');
    const sink = new FileSink(path);
    try {
      const fetcher = await backend.openAttachments(request.account);
      const result = await fetcher.fetchAttachment(
        { backend: request.backend, accountId: request.account },
        { kind: info.kind, handle },
        sink,
        { maxBytes: request.maxBytes },
      );
      sink.close();
      log(`curlew-daemon: fetched attachment for ${who} (${result.size} bytes)`);
      return {
        v: DAEMON_WIRE_VERSION,
        kind: 'fetched',
        path,
        filename: basename(path),
        bytes: result.size,
        mimeType: result.mimeType ?? info.mimeType ?? 'application/octet-stream',
      };
    } catch (error) {
      sink.abort(errText(error));
      log(`curlew-daemon: attachment fetch for ${who} failed`);
      return { v: DAEMON_WIRE_VERSION, kind: 'failed', message: errText(error) };
    }
  };
}

/**
 * Receive until `params.signal` aborts, then rebuild the conversations once and close the index.
 *
 * The promise resolves when EVERY account loop has ended — not when the signal arrived — so the
 * caller can close the database knowing no write is still in flight.
 */
export async function runDeliveryDaemon(params: DaemonParams = {}): Promise<DaemonResult> {
  const log = params.log ?? ((text: string) => console.error(text));
  const config = loadConfig(params.configPath ?? configPath());
  const backends = (params.backends ?? deliveryBackends(config)).filter((backend) => {
    if (isDeliveryBackend(backend)) return true;
    // A mail or chat backend here would be a mistake in the caller, not a runtime condition to
    // discover after it connected: those models belong on `curlew sync`.
    if (isMailBackend(backend) || isChatBackend(backend)) {
      log(
        `curlew-daemon: skipping ${backend.manifest.name} — a ${backend.manifest.syncModel} backend is served by \`curlew sync\``,
      );
      return false;
    }
    return true;
  });
  const xmpp = params.xmpp === undefined ? createEnabledXmppBackend(config) : params.xmpp;
  const xmppAccounts =
    xmpp === null
      ? []
      : (await xmpp.listAccounts())
          .map((a) => a.id)
          .filter((id) => !params.accountId || id === params.accountId);
  const matrix = params.matrix === undefined ? createMatrixBackend(config) : params.matrix;
  const matrixAccounts =
    matrix === null
      ? []
      : (await matrix.listAccounts())
          .map((a) => a.id)
          .filter((id) => !params.accountId || id === params.accountId);
  const telegram = params.telegram === undefined ? createTelegramBackend(config) : params.telegram;
  const telegramAccounts =
    telegram === null
      ? []
      : (await telegram.listAccounts())
          .map((a) => a.id)
          .filter((id) => !params.accountId || id === params.accountId);
  if (
    backends.length === 0 &&
    xmppAccounts.length === 0 &&
    matrixAccounts.length === 0 &&
    telegramAccounts.length === 0
  ) {
    throw new Error(
      'nothing to receive — no delivery-only backend is enabled (`curlew backends list`; the daemon receives Signal and WhatsApp), no XMPP or Matrix account is enabled; `curlew sync` stays for mail and the other chats',
    );
  }

  const db = openIndex(params.dbPath);
  const rebuild = params.rebuild ?? rebuildWithAddressBook;
  const debounce = params.rebuildDebounceMs ?? REBUILD_DEBOUNCE_MS;
  // Conversations are derived from what was written, so they are rebuilt when the writes stop —
  // a burst of batches is one rebuild, not one per batch (ADR 0002 §5).
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let conversations: (RebuildResult & { contacts: number | null }) | null = null;
  /**
   * The rebuild in flight, if any. Two are never allowed to overlap: they write the same derived
   * tables, and the second one to finish would be the one whose counts are reported. A rebuild
   * asked for while one is running therefore QUEUES behind it, and the run's stop waits for the
   * queue — a `db.close()` under a running `rebuildConversations` is a use-after-close.
   */
  let inFlight: Promise<void> | null = null;
  const runRebuild = async (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    dirty = false;
    conversations = await rebuild(db);
    log(
      `curlew-daemon: conversations rebuilt (${conversations.conversations} conversations, ` +
        `${conversations.participants} participants)`,
    );
  };
  const rebuildNow = (): Promise<void> => {
    const previous = inFlight;
    const next = (previous ?? Promise.resolve()).then(runRebuild, runRebuild);
    inFlight = next;
    return next.finally(() => {
      if (inFlight === next) inFlight = null;
    });
  };
  const schedule = (): void => {
    dirty = true;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void rebuildNow().catch((err: unknown) =>
        log(`curlew-daemon: the conversations could not be rebuilt: ${errText(err)}`),
      );
    }, debounce);
  };

  const outer = params.signal ?? new AbortController().signal;
  const run = new AbortController();
  const signal = run.signal;
  const forward = (): void => run.abort();
  if (outer.aborted) run.abort();
  else outer.addEventListener('abort', forward, { once: true });
  let followed: FollowResult[] = [];
  let followedMatrix: FollowResult[] = [];
  let followedTelegram: FollowResult[] = [];
  // The sessions this run is holding, so a send asked for over the bus reaches the connection that
  // is already up. A reconnect hands over `null` and then the new session, so a send during one
  // finds nothing and is told `not-followed` rather than going out on a connection that is gone.
  const sessions = new Map<string, DeliverySession>();
  // The backends that can fetch attachments for every account this run holds, chat or delivery.
  const fetchBackends = new Map<
    string,
    MessageBackend & { openAttachments: NonNullable<MessageBackend['openAttachments']> }
  >();
  let sendService: DaemonSendService | null = null;
  // ADR 0007: the account list for `GetAccounts` is built from the progress events the log lines
  // above already name, and the journal's newest row is announced after the daemon's own commits
  // and whenever a poll finds that another process moved it.
  const table = new AccountTable();
  for (const accountId of xmppAccounts) table.seed('xmpp', accountId, new Date());
  for (const accountId of matrixAccounts) table.seed('matrix', accountId, new Date());
  for (const accountId of telegramAccounts) table.seed('telegram', accountId, new Date());
  let lastSeq: number | null = null;
  try {
    lastSeq = newestSeq(db);
  } catch {
    // A busy index is looked at again by the next poll.
  }
  const notices =
    params.noticeSink !== undefined
      ? params.noticeSink
      : params.dbPath === undefined
        ? gioNoticeSink()
        : null;
  const noticeState = newNoticeState();
  const noticeConfigPath = params.configPath ?? configPath();
  const notify = (after: number | null): void => {
    if (!notices) return;
    try {
      const mode = loadConfig(noticeConfigPath).ui.notifications;
      for (const notice of planNotices(db, readChanges(db, after ?? 0).changes, mode, noticeState))
        notices.show(notice);
    } catch (err) {
      log(`curlew-daemon: a notification could not be planned: ${errText(err)}`);
    }
  };
  const announce = (): void => {
    try {
      const newest = newestSeq(db);
      if (newest === null || newest === lastSeq) return;
      const previous = lastSeq;
      lastSeq = newest;
      sendService?.emitChanged(newest);
      notify(previous);
    } catch {
      // A busy index is looked at again by the next poll.
    }
  };
  const progress = (event: DeliveryProgress): void => {
    if (table.apply(event, new Date())) sendService?.emitAccountsChanged();
  };
  const changeWatch = setInterval(announce, params.changePollMs ?? CHANGE_POLL_MS);
  try {
    log(
      `curlew-daemon: receiving from ${backends.map((b) => b.manifest.name).join(', ') || 'no delivery backend'}` +
        `${xmppAccounts.length > 0 ? ` and following ${xmppAccounts.length} xmpp account(s)` : ''}` +
        `${matrixAccounts.length > 0 ? `${xmppAccounts.length > 0 ? ',' : ' and following'} ${matrixAccounts.length} matrix account(s)` : ''}` +
        `${telegramAccounts.length > 0 ? `${xmppAccounts.length + matrixAccounts.length > 0 ? ',' : ' and following'} ${telegramAccounts.length} telegram account(s)` : ''} ` +
        `(${params.accountId ?? 'every account'}) — stop with SIGTERM`,
    );
    // The prompt service (ADR 0009). The policy is read afresh per request, so a rule edited by
    // hand applies at once; "Always" saves through the same path as every other config write.
    const accessConfigPath = params.configPath ?? configPath();
    const accessBroker = new AccessBroker({
      ui:
        params.accessPrompt ??
        gioNotificationPrompt({ nameOf: (ask) => contactNameFromIndex(db, ask.account, ask.contact) }),
      policy: () => loadConfig(accessConfigPath).agentAccess,
      addRule: (ask) => saveConfig(withAllowRule(loadConfig(accessConfigPath), ask), accessConfigPath),
      log,
      timeoutMs: params.accessTimeoutMs,
    });
    const publish = params.publishSend === undefined ? publishDaemonSend : params.publishSend;
    sendService =
      publish === null
        ? null
        : publish(
            createDaemonSendHandler({
              sessions,
              log,
            }),
            {
              log,
              accounts: () => table.reply(),
              access: (request) => accessBroker.request(request),
              fetch: createDaemonFetchHandler({ db, fetchBackends, log }),
              onSessionEnd: (session) => {
                accessBroker.endSession(session);
                log('curlew-daemon: an agent session ended — its temporary access grants are gone');
              },
            },
          );
    for (const backend of backends) {
      void backend
        .listAccounts()
        .then((known) => {
          let seeded = false;
          for (const account of known) {
            if (params.accountId && account.id !== params.accountId) continue;
            seeded = table.seed(backend.manifest.name, account.id, new Date()) || seeded;
          }
          if (seeded) sendService?.emitAccountsChanged();
        })
        .catch(() => {});
    }
    const onFollowSession =
      (backend: MessageBackend) =>
      (account: { backend: string; accountId: string }, session: ChatSession | null): void => {
        const key = sessionKey(account.backend, account.accountId);
        if (session === null || !isAttachmentFetcherBackend(backend)) {
          fetchBackends.delete(key);
        } else {
          fetchBackends.set(key, backend);
        }
      };
    const following = Promise.all(
      xmppAccounts.map((accountId) =>
        followAccount({
          db,
          backend: xmpp as XmppBackend,
          open: (id, permit) => (xmpp as XmppBackend).openGranted(id, permit, { decrypt: true }),
          permit: { account: accountId, addresses: [] },
          signal,
          log,
          onWrite: () => {
            schedule();
            announce();
          },
          onProgress: progress,
          onSession: onFollowSession(xmpp as MessageBackend),
          holder: String(process.pid),
          writeLogPath: params.writeLogPath,
        }),
      ),
    ).then((done) => {
      followed = done;
    });
    const followingMatrix = Promise.all(
      matrixAccounts.map((accountId) =>
        followAccount({
          db,
          backend: matrix as MatrixBackend,
          backendName: 'matrix',
          accountId,
          open: (id) => (matrix as MatrixBackend).connectLive(id),
          permit: { account: accountId, addresses: [] },
          signal,
          log,
          onWrite: () => {
            schedule();
            announce();
          },
          onProgress: progress,
          onSession: onFollowSession(matrix as MessageBackend),
          holder: String(process.pid),
          writeLogPath: params.writeLogPath,
        }),
      ),
    ).then((done) => {
      followedMatrix = done;
    });
    const followingTelegram = Promise.all(
      telegramAccounts.map((accountId) =>
        followAccount({
          db,
          backend: telegram as TelegramBackend,
          backendName: 'telegram',
          accountId,
          open: (id) => (telegram as TelegramBackend).connectLive(id),
          permit: { account: accountId, addresses: [] },
          signal,
          log,
          onWrite: () => {
            schedule();
            announce();
          },
          onProgress: progress,
          onSession: onFollowSession(telegram as MessageBackend),
          holder: String(process.pid),
          writeLogPath: params.writeLogPath,
        }),
      ),
    ).then((done) => {
      followedTelegram = done;
    });
    const [results] = await Promise.all([
      Promise.all(
        backends.map(
          async (backend): Promise<DeliverySyncResult> =>
            receiveDeliveries(db, backend as Parameters<typeof receiveDeliveries>[1], {
              mode: 'follow',
              signal,
              accountId: params.accountId,
              onProgress: (event) => {
                if (event.type === 'batch') {
                  schedule();
                  announce();
                }
                progress(event);
                line(event, log);
              },
              onSession: (account, session) => {
                const key = sessionKey(account.backend, account.accountId);
                if (session === null) {
                  sessions.delete(key);
                  fetchBackends.delete(key);
                } else {
                  sessions.set(key, session);
                  if (isAttachmentFetcherBackend(backend)) fetchBackends.set(key, backend);
                }
              },
            }),
        ),
      ),
      following,
      followingMatrix,
      followingTelegram,
    ]);
    // The writes are in: no more debounced rebuilds are scheduled, and whatever is already running
    // or queued is awaited — `rebuildNow` chains behind it, so this covers a rebuild that started
    // before the last batch was written (then `dirty` is still set and one more pass is due).
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    while (inFlight !== null) await inFlight;
    if (dirty) await rebuildNow();
    const accounts: DaemonAccountResult[] = [
      ...results.flatMap((r) =>
        r.accounts.map((a) => ({
          backend: a.backend,
          accountId: a.accountId,
          batches: a.batches,
          added: a.added,
          removed: a.removed,
          error: a.error,
          heldBy: a.heldBy ?? null,
          indexBusy: a.indexBusy === true,
          loggedOut: a.loggedOut === true,
        })),
      ),
      // A Matrix follow ends the way a delivery account does: `2` when the homeserver dropped
      // every account that was left, so systemd does not restart a device nobody can relink.
      ...followedMatrix.map((f) => ({
        backend: 'matrix',
        accountId: f.accountId,
        batches: f.catchUps,
        added: f.added,
        removed: 0,
        error: null,
        heldBy: f.heldBy,
        indexBusy: false,
        loggedOut: f.loggedOut,
      })),
      ...followedTelegram.map((f) => ({
        backend: 'telegram',
        accountId: f.accountId,
        batches: f.catchUps,
        added: f.added,
        removed: 0,
        error: null,
        heldBy: f.heldBy,
        indexBusy: false,
        loggedOut: f.loggedOut,
      })),
    ];
    const errors = accounts.filter((a) => a.error !== null).length;
    log(
      `curlew-daemon: stopped — ${accounts.length} account(s), ${accounts.reduce((n, a) => n + a.added, 0)} message(s) received, ${errors} error(s)`,
    );
    return {
      backends: backends.map((b) => b.manifest.name),
      accounts,
      added: results.reduce((n, r) => n + r.added, 0),
      removed: results.reduce((n, r) => n + r.removed, 0),
      errors,
      conversations,
      followed: [...followed, ...followedMatrix, ...followedTelegram],
    };
  } finally {
    clearInterval(changeWatch);
    notices?.close();
    // Give the name up before the sessions are gone: a caller that arrives after this gets
    // "no daemon" and takes its own direct path, which is true from here on.
    sendService?.close();
    sessions.clear();
    outer.removeEventListener('abort', forward);
    db.close();
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
