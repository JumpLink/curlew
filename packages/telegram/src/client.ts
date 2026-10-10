/**
 * The real client: mtcute's web build (WebSocket + WebCrypto + WebAssembly), which is what runs
 * on GJS through gjsify — the standards path ADR 0001 §7 prefers over a native addon.
 *
 * Everything else in this package talks to `TelegramClientHandle`; this file is the only one
 * that constructs mtcute, so the tests never need the network.
 */

import type { ITelegramStorageProvider } from '@mtcute/core';
import { MemoryStorage, TelegramClient, WebPlatform } from '@mtcute/web';
import type { LoginPrompts, TelegramApi, TelegramClientHandle, TgUser } from './api.ts';
import type { TelegramCredentials } from './credentials.ts';

export interface ClientOptions {
  credentials: TelegramCredentials;
  storage: ITelegramStorageProvider;
}

export type ClientFactory = (options: ClientOptions) => TelegramClientHandle;

/** mtcute's log levels: 0 off, 1 error, 2 warn, 3 info, 4 debug, 5 verbose. */
const LOG_WARN = 2;

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

/** The one place mtcute's client is constructed. Updates are off: curlew syncs, it does not listen. */
export const createMtcuteClient: ClientFactory = ({ credentials, storage }) => {
  const client = new TelegramClient({
    apiId: credentials.apiId,
    apiHash: credentials.apiHash,
    storage,
    platform: new CurlewPlatform(),
    disableUpdates: true,
    logLevel: LOG_WARN,
  });
  const api: TelegramApi = client;
  return {
    getMe: () => api.getMe(),
    iterDialogs: (params) => api.iterDialogs(params),
    getHistory: (chatId, params) => api.getHistory(chatId, params),
    getMessages: (chatId, messageIds) => api.getMessages(chatId, [...messageIds]),
    destroy: () => client.destroy(),
    connect: () => client.connect(),
    login: async (prompts: LoginPrompts): Promise<TgUser> =>
      client.start({
        phone: () => prompts.phone(),
        code: () => prompts.code(),
        password: () => prompts.password(),
        codeSentCallback: (sent) => {
          if (sent.type === 'email_required') {
            throw new Error('Telegram asks for an email login setup first — finish it in an official app');
          }
          prompts.notify(`Telegram sent the login code via ${sent.type}.`);
        },
        invalidCodeCallback: (kind) => {
          prompts.notify(
            kind === 'code' ? 'That code was not accepted — try again.' : 'Wrong password — try again.',
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
  });
  try {
    await client.connect();
    const dc = await client.call({ _: 'help.getNearestDc' });
    return { thisDc: dc.thisDc, nearestDc: dc.nearestDc };
  } finally {
    await client.destroy();
  }
}
