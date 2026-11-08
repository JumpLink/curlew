/**
 * The real client: mtcute's web build (WebSocket + WebCrypto + WebAssembly), which is what runs
 * on GJS through gjsify — the standards path ADR 0001 §7 prefers over a native addon.
 *
 * Everything else in this package talks to `TelegramClientHandle`; this file is the only one
 * that constructs mtcute, so the tests never need the network.
 */

import { _, fmt } from '@curlew/protocol';
import { FileLocation, InputMedia, type ITelegramStorageProvider, type RpcCallMiddleware } from '@mtcute/core';
import { MemoryStorage, networkMiddlewares, TelegramClient, WebPlatform } from '@mtcute/web';
import type { LoginPrompts, TelegramApi, TelegramClientHandle, TelegramLive, TgUser } from './api.ts';
import type { TelegramCredentials } from './credentials.ts';

export interface ClientOptions {
  credentials: TelegramCredentials;
  storage: ITelegramStorageProvider;
  /** Keep receiving updates (the daemon's follow). Off for sync, which only reads. */
  live?: boolean;
}

export type ClientFactory = (options: ClientOptions) => TelegramClientHandle;

/** How long the connection may stay offline before a follow gives up on it and reconnects. */
export const OFFLINE_GRACE_MS = 60_000;

const SESSION_GONE = /^(AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED(_BAN)?)$/;

/** Telegram's own name for an error that says the session is gone, read structurally. */
export function sessionGone(err: unknown): string | null {
  const text = typeof err === 'object' && err !== null ? (err as { text?: unknown }).text : undefined;
  return typeof text === 'string' && SESSION_GONE.test(text) ? text : null;
}

/** mtcute's log levels: 0 off, 1 error, 2 warn, 3 info, 4 debug, 5 verbose. */
const LOG_WARN = 2;

/**
 * How long mtcute may sleep a FLOOD_WAIT away before it gives up and throws.
 *
 * mtcute's default is 10 s, so a longer wait becomes an `RpcError` that stops the run (#72). But
 * Telegram's normal case is SHORT: it asks for about 26 s after ~29 `getHistory` calls, so the
 * default made every run stop after ~29 chats. Sleeping a short wait out is far cheaper than
 * aborting the run; a wait beyond this still stops it, through `asChatRateLimited`.
 *
 * The interactive login uses the same value on purpose. A wait there is just as short and
 * bounded, and aborting costs the user the phone code plus a re-typed login — waiting it out is
 * the better outcome, and mtcute logs the wait while it sleeps, so the pause is not silent.
 */
export const FLOOD_SLEEP_THRESHOLD_MS = 60_000;

/**
 * mtcute's default middlewares, with the flood waiter's threshold raised.
 *
 * `floodSleepThreshold` is not a client option in mtcute 0.32: it is set by building the default
 * stack (`basic`) with `floodWaiter.maxWait`. Passing `middlewares` REPLACES the defaults, so
 * they are built through `basic` rather than hand-rolled — that keeps the media throttle and the
 * internal-error handler in place. `basic` is injectable only so a unit test can assert the
 * value this function hands mtcute without a network.
 */
export function telegramMiddlewares(
  thresholdMs: number = FLOOD_SLEEP_THRESHOLD_MS,
  basic: typeof networkMiddlewares.basic = networkMiddlewares.basic,
): RpcCallMiddleware[] {
  return basic({ floodWaiter: { maxWait: thresholdMs } });
}

/**
 * mtcute's web platform, adjusted for a GJS command line.
 *
 * The device model is what Telegram shows in the user's list of active sessions, so it says
 * which program holds the session. That is the only reason this class exists.
 */
class CurlewPlatform extends WebPlatform {
  override getDeviceModel(): string {
    return 'curlew';
  }

  // Nothing else is overridden. The three that were are gone with the gaps that needed them:
  // gjsify#1835 gives GJS Node's DOM-less `navigator`, and gjsify#1836 made `globalThis` an
  // EventTarget under `--app gjs`, so mtcute's `window.addEventListener('beforeunload')` and its
  // unguarded `'onLine' in navigator` both work. What mtcute gets from them is the browser's
  // answer anyway: there is no page to unload, and a command line has no online/offline signal
  // worth watching — the connection's own errors are what tell curlew it is offline.
}

/**
 * What `live` wraps: mtcute's update stream as a wake-up. mtcute reconnects and fills update gaps
 * itself, so a short offline spell needs nothing from curlew; one that outlasts `graceMs` is
 * reported closed, and the follow loop reconnects with its own backoff.
 */
export function mtcuteLive(
  client: Pick<TelegramClient, 'onUpdate' | 'onConnectionState' | 'onError' | 'startUpdatesLoop'>,
  graceMs: number = OFFLINE_GRACE_MS,
): TelegramLive {
  const arrivals = new Set<() => void>();
  const closers: Array<(end: { reason: string; loggedOut: boolean }) => void> = [];
  let closed = false;
  let offline: ReturnType<typeof setTimeout> | null = null;
  const close = (end: { reason: string; loggedOut: boolean }): void => {
    if (closed) return;
    closed = true;
    if (offline !== null) clearTimeout(offline);
    for (const closer of closers) closer(end);
  };
  client.onUpdate.add(() => {
    for (const listener of arrivals) listener();
  });
  client.onConnectionState.add((state) => {
    if (state === 'offline') {
      offline ??= setTimeout(() => close({ reason: 'offline', loggedOut: false }), graceMs);
    } else if (offline !== null) {
      clearTimeout(offline);
      offline = null;
    }
  });
  client.onError.add((err) => {
    const gone = sessionGone(err);
    if (gone !== null) close({ reason: gone, loggedOut: true });
  });
  return {
    start: () => client.startUpdatesLoop(),
    onArrival: (listener) => {
      arrivals.add(listener);
      return () => arrivals.delete(listener);
    },
    onClosed: (listener) => {
      closers.push(listener);
    },
  };
}

/** The one place mtcute's client is constructed. Updates are off unless `live`: sync only reads. */
export const createMtcuteClient: ClientFactory = ({ credentials, storage, live }) => {
  const client = new TelegramClient({
    apiId: credentials.apiId,
    apiHash: credentials.apiHash,
    storage,
    platform: new CurlewPlatform(),
    disableUpdates: live !== true,
    logLevel: LOG_WARN,
    network: { middlewares: telegramMiddlewares() },
  });
  // Structural check of the reads mtcute's client satisfies as it is; `openMedia` is built below.
  const api: Omit<TelegramApi, 'openMedia' | 'destroy'> = client;
  return {
    getMe: () => api.getMe(),
    iterDialogs: (params) => api.iterDialogs(params),
    getHistory: (chatId, params) => api.getHistory(chatId, params),
    getMessages: (chatId, messageIds) => api.getMessages(chatId, [...messageIds]),
    openMedia: async (chatId, messageId) => {
      const [message] = await client.getMessages(chatId, [messageId]);
      const media = message?.media;
      // Contacts, polls, link previews and paid media have no file of their own to download.
      if (!media || !(media instanceof FileLocation)) return null;
      return { media, chunks: client.downloadAsIterable(media) };
    },
    sendText: (chatId, text) => client.sendText(chatId, text),
    sendFile: (chatId, file) =>
      client.sendMedia(
        chatId,
        file.asPhoto
          ? InputMedia.photo(file.bytes, { caption: file.caption })
          : InputMedia.document(file.bytes, {
              fileName: file.fileName,
              fileMime: file.contentType,
              caption: file.caption,
            }),
      ),
    ...(live === true ? { live: mtcuteLive(client) } : {}),
    destroy: () => client.destroy(),
    connect: () => client.connect(),
    login: async (prompts: LoginPrompts): Promise<TgUser> =>
      client.start({
        phone: () => prompts.phone(),
        code: () => prompts.code(),
        password: () => prompts.password(),
        codeSentCallback: (sent) => {
          if (sent.type === 'email_required') {
            throw new Error(_('Telegram asks for an email login setup first — finish it in an official app'));
          }
          // TRANSLATORS: {channel} is Telegram's own word for the route it used ("sms", "app", …),
          // and arrives untranslated from the server.
          prompts.notify(fmt(_('Telegram sent the login code via {channel}.'), { channel: sent.type }));
        },
        invalidCodeCallback: (kind) => {
          prompts.notify(
            kind === 'code' ? _('That code was not accepted — try again.') : _('Wrong password — try again.'),
          );
        },
      }),
  };
};

/**
 * A credential-free network check: open a connection, run the MTProto auth-key exchange, and make
 * one unauthenticated call. Proves the whole stack (WebSocket, WebCrypto, the WASM crypto, the
 * TL layer) works on this runtime without an account.
 *
 * The api_id is the placeholder `1`, which is no registered app — deliberately nobody's
 * credentials. The server answers `help.getNearestDc` without checking the app; nothing is logged in and nothing is stored (the
 * storage is in memory). Only DC numbers come back — not the country the server geolocated.
 */
export async function probeHandshake(
  storage: ITelegramStorageProvider = new MemoryStorage(),
): Promise<{ thisDc: number; nearestDc: number }> {
  const client = new TelegramClient({
    apiId: 1,
    apiHash: '00000000000000000000000000000000',
    storage,
    platform: new CurlewPlatform(),
    disableUpdates: true,
    logLevel: LOG_WARN,
    network: { middlewares: telegramMiddlewares() },
  });
  try {
    await client.connect();
    const dc = await client.call({ _: 'help.getNearestDc' });
    return { thisDc: dc.thisDc, nearestDc: dc.nearestDc };
  } finally {
    await client.destroy();
  }
}
