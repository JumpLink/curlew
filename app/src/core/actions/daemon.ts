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
 *     person's own — no grant is needed to follow it; grants restrict agents. The one grant the
 *     daemon still reads is `xmpp.omemo` (what it decrypts), read once at start: the run stops
 *     when that changes;
 *   - follows every ENABLED Matrix account (ADR 0007 §5): the SDK's `/sync` long poll
 *     (`set_presence=offline`, through the read-only gate) keeps the client current, a new event
 *     is only a wake-up, and the same history walk `curlew sync` runs writes it. No new switch:
 *     enabling the backend is the opt-in. A device the homeserver logs out is stopped, not retried;
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

import {
  type DeliverySession,
  type MessageBackend,
  type MessageSender,
  type SendPermit,
  isChatBackend,
  isDeliveryBackend,
  isMailBackend,
  _,
  fmt,
} from '@curlew/protocol';
import type { DeliveryProgress, DeliverySyncResult, IndexDatabase, RebuildResult } from '@curlew/store';
import { newestSeq, receiveDeliveries } from '@curlew/store';
import { MatrixBackend } from '@curlew/matrix';
import { XmppBackend } from '@curlew/xmpp';
import { builtinRegistry } from '../backends/builtin.ts';
import { backendContext } from '../backends/context.ts';
import { loadConfig, type CurlewConfig } from '../config.ts';
import type { Capability, Grant } from '../grants.ts';
import { configPath } from '@curlew/store';
import { AccountTable } from '../lib/daemon-accounts.ts';
import { DAEMON_WIRE_VERSION, type DaemonSendReply } from '../lib/daemon-bus.ts';
import {
  publishDaemonSend,
  type DaemonSendHandler,
  type DaemonSendService,
} from '../lib/daemon-send-service.ts';
import { followAccount, type FollowResult } from './follow.ts';
import { openIndex, rebuildWithAddressBook } from './index-sync.ts';
import { decryptAccounts, OMEMO_CAPABILITY } from './omemo.ts';
import { sendThrough } from './send.ts';

/** How often a running daemon looks whether its decryption grant was edited (it applies on restart only). */
export const GRANT_CHECK_MS = 30_000;

/**
 * The grants a running daemon depends on: what it decrypts (`xmpp.omemo`). Only an edit to THIS
 * stops it. Send grants do not belong here any more (ADR 0008): who the daemon follows is the
 * set of enabled accounts, and `curlew send` reads the send grants itself when it runs.
 * Removed with the plaintext-index step of ADR 0008, when decryption stops depending on a grant.
 */
export function daemonGrants(grants: readonly Grant[]): string {
  return JSON.stringify(grants.filter((g) => g.capability === OMEMO_CAPABILITY));
}

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
  /** Short only in tests. */
  grantCheckMs?: number;
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
  /** The run stopped because the grant it decrypts by (`xmpp.omemo`) was edited. */
  grantsEdited: boolean;
}

/** The registry's Matrix backend when the config enables it (the daemon follows it), else `null`. */
export function createMatrixBackend(config: CurlewConfig): MatrixBackend | null {
  const registry = builtinRegistry();
  if (!registry.enabled(config).some((plugin) => plugin.manifest.name === 'matrix')) return null;
  const created = registry.create(config, 'matrix', backendContext('matrix', config));
  return created instanceof MatrixBackend ? created : null;
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
 * `3` when the run stopped because its decryption grant was edited: it applies on restart only, so the
 * unit has to come back — `Restart=on-failure` restarts any code but 0 and 2. A `0` here left
 * nothing receiving until someone noticed.
 *
 * Everything else is `0`, including a normal SIGTERM stop, a run that is still receiving on
 * another account, and a machine with no linked account at all: a daemon that was asked to stop
 * did its job, and a non-zero code on a clean stop would restart-loop.
 */
export function daemonExitCode(
  run: Pick<DaemonResult, 'accounts'> & Partial<Pick<DaemonResult, 'grantsEdited'>>,
): 0 | 2 | 3 {
  if (run.grantsEdited === true) return 3;
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
      const outcome = await sendThrough(
        sender,
        {
          to: request.to,
          ...(request.text === undefined ? {} : { text: request.text }),
          ...(request.imageUrl === undefined ? {} : { imageUrl: request.imageUrl }),
          ...(request.subject === undefined ? {} : { subject: request.subject }),
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
  // The decryption grant is read ONCE, here (ADR 0004 §1): an edit applies on restart, never
  // halfway through a connection that is already open.
  const grantsAtStart = daemonGrants(config.grants);
  // Follow mode is where a message is seen FIRST, so it decrypts what the grants allow: a row
  // the daemon indexed textless stays that way, because the next sync finds nothing new for it.
  const decrypting = decryptAccounts(config.grants);
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
  if (backends.length === 0 && xmppAccounts.length === 0 && matrixAccounts.length === 0) {
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
  let grantsEdited = false;
  const grantWatch =
    xmppAccounts.length > 0
      ? setInterval(() => {
          try {
            if (daemonGrants(loadConfig(params.configPath ?? configPath()).grants) === grantsAtStart) return;
          } catch {
            // An unreadable config is also a change nobody approved.
          }
          log(
            'curlew-daemon: the decryption grant was edited — stopping; the new set applies after a restart',
          );
          grantsEdited = true;
          run.abort();
        }, params.grantCheckMs ?? GRANT_CHECK_MS)
      : null;
  let followed: FollowResult[] = [];
  let followedMatrix: FollowResult[] = [];
  // The sessions this run is holding, so a send asked for over the bus reaches the connection that
  // is already up. A reconnect hands over `null` and then the new session, so a send during one
  // finds nothing and is told `not-followed` rather than going out on a connection that is gone.
  const sessions = new Map<string, DeliverySession>();
  let sendService: DaemonSendService | null = null;
  // ADR 0007: the account list for `GetAccounts` is built from the progress events the log lines
  // above already name, and the journal's newest row is announced after the daemon's own commits
  // and whenever a poll finds that another process moved it.
  const table = new AccountTable();
  for (const accountId of xmppAccounts) table.seed('xmpp', accountId, new Date());
  for (const accountId of matrixAccounts) table.seed('matrix', accountId, new Date());
  let lastSeq: number | null = null;
  try {
    lastSeq = newestSeq(db);
  } catch {
    // A busy index is looked at again by the next poll.
  }
  const announce = (): void => {
    try {
      const newest = newestSeq(db);
      if (newest === null || newest === lastSeq) return;
      lastSeq = newest;
      sendService?.emitChanged(newest);
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
        `${matrixAccounts.length > 0 ? `${xmppAccounts.length > 0 ? ',' : ' and following'} ${matrixAccounts.length} matrix account(s)` : ''} ` +
        `(${params.accountId ?? 'every account'}) — stop with SIGTERM`,
    );
    const publish = params.publishSend === undefined ? publishDaemonSend : params.publishSend;
    sendService =
      publish === null
        ? null
        : publish(
            createDaemonSendHandler({
              sessions,
              log,
            }),
            { log, accounts: () => table.reply() },
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
    const following = Promise.all(
      xmppAccounts.map((accountId) =>
        followAccount({
          db,
          backend: xmpp as XmppBackend,
          open: (id, permit) =>
            (xmpp as XmppBackend).openGranted(id, permit, { decrypt: decrypting.includes(id) }),
          permit: { account: accountId, addresses: [] },
          signal,
          log,
          onWrite: () => {
            schedule();
            announce();
          },
          onProgress: progress,
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
          holder: String(process.pid),
          writeLogPath: params.writeLogPath,
        }),
      ),
    ).then((done) => {
      followedMatrix = done;
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
                if (session === null) sessions.delete(key);
                else sessions.set(key, session);
              },
            }),
        ),
      ),
      following,
      followingMatrix,
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
      followed: [...followed, ...followedMatrix],
      grantsEdited,
    };
  } finally {
    if (grantWatch !== null) clearInterval(grantWatch);
    clearInterval(changeWatch);
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
