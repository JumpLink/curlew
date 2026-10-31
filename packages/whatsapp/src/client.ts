/**
 * The real socket: Baileys' multi-device client (WebSocket + noise handshake + libsignal +
 * the `whatsapp-rust-bridge` WASM), which runs on GJS through gjsify.
 *
 * Everything else in this package talks to `WaSocketHandle` or, behind a grant,
 * `WaSendSocketHandle`; this file is the only one that constructs Baileys, so the tests never
 * need the network.
 *
 * The RECEIVE socket (`createBaileysSocket`) is read-only, and why that holds (Baileys
 * 7.0.0-rc14, file references into its source):
 *   - No send path is reachable: `WaSocketHandle` exposes events, the pairing-code request and
 *     `end` — not `sendMessage`, `readMessages`, `sendPresenceUpdate` or `chatModify`.
 *   - `markOnlineOnConnect: false`: on open, Baileys announces `unavailable` instead of
 *     `available` (Socket/chats.ts, the `connection.update` handler), so contacts never see
 *     this device online, and the phone keeps getting its notifications.
 *   - Read receipts are sent only by `readMessages` (Socket/messages-send.ts), which nothing
 *     calls. What Baileys does send for every delivered message is the DELIVERY receipt —
 *     type `inactive` while not online (Socket/messages-recv.ts, `handleMessage`) — the grey
 *     double tick every linked device sends, and the signal for the server to forget the
 *     message. Without it the server would re-deliver forever.
 *   - `end()` closes the socket; it never calls `logout()`, which would unlink the device.
 *   - What Baileys DOES write on every connect is protocol housekeeping the multi-device
 *     protocol requires of any linked device: it uploads fresh Signal pre-keys when the server
 *     runs low (Socket/socket.ts, `uploadPreKeys` after the digest check and the pre-key count
 *     check), resyncs the app state after the first history sync (Socket/chats.ts,
 *     `doAppStateSync` → `resyncAppState`) and clears the server's dirty bits for what it
 *     synced (`cleanDirtyBits`). None of it touches a chat's content, a message's read state or
 *     what contacts see of this device.
 *
 * The SEND view (`WaConnection.openSend`) keeps all of that and adds exactly one write,
 * `sendMessage` with a plain text — see its own comment.
 *
 * The logger is silent: Baileys logs protocol objects (keys, message nodes) at info and debug,
 * and nothing of that may reach a terminal scrollback or an MCP transcript.
 */

import { _, fmt } from '@curlew/protocol';
import { makeWASocket, type proto } from 'baileys';
import type { WaSendSocketHandle, WaSocketHandle } from './api.ts';
import { disconnectReason } from './api.ts';
import type { SecretStoreAuthState } from './auth-state.ts';

export interface SocketOptions {
  auth: SecretStoreAuthState;
  /**
   * Ask the phone for the FULL history on linking, instead of the recent months. Only takes
   * effect when a device is linked. Off by default: a full history can be a six-digit message
   * count, and each one costs a write.
   */
  fullHistory?: boolean;
}

export type SocketFactory = (options: SocketOptions) => WaSocketHandle;

/**
 * One Baileys connection under TWO views — the shape `createBaileysConnection` returns.
 *
 * WhatsApp allows one connection per linked device, so a send that happens while the daemon
 * holds the receive lease cannot open a second socket: it has to use the daemon's. That is what
 * `openSend()` is for, and the split is what keeps the read-only guarantee intact while allowing
 * it: the receive path is handed `handle` and nothing else, and `handle` is a `WaSocketHandle`,
 * which has no way to write (`api.ts`). A send-capable view exists only where someone asked for
 * one, behind a permit.
 */
export interface WaConnection {
  /** The receive view: events, pairing code, and a real `end()` that closes the connection. */
  readonly handle: WaSocketHandle;
  /**
   * A send-capable view of the SAME connection. Its `end()` is a NO-OP: whoever opened the
   * connection owns its lifetime, and a sender that closed it would take the receive loop down
   * with it. Close the connection through `handle.end()`.
   */
  openSend(): WaSendSocketHandle;
}

export type ConnectionFactory = (options: SocketOptions) => WaConnection;

/**
 * Baileys builds its own WebSocket, and for a long time it could not do so on GJS: `@gjsify/ws`
 * read a plain object in the second positional argument as `protocols` (gjsify#1809), so
 * Baileys' `origin` and headers were dropped and the handshake failed. This file used to
 * override `WebSocketClient.prototype.connect` to work around it.
 *
 * That override is gone: `@gjsify/ws` 0.53.0 normalises the arguments the way `ws` documents
 * them, measured on GJS against a real server — `new WebSocket(url, { origin, headers })`
 * reaches the wire with both, and Baileys' own `connect()` now suffices. Nothing here
 * monkey-patches a library again; a third occurrence would mean measuring, not patching.
 */

/** A logger that says nothing — see the file comment. */
function silentLogger(): Parameters<typeof makeWASocket>[0]['logger'] {
  const noop = () => {};
  const logger = {
    level: 'silent',
    child: () => logger,
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
  };
  return logger as unknown as Parameters<typeof makeWASocket>[0]['logger'];
}

/**
 * The one place Baileys' socket is constructed — for both views.
 *
 * The options are the receive options throughout; sending adds no option, only the
 * `sendMessage` call in `openSend`. The one thing the unified socket carries that a pure
 * receive socket did not is the `getMessage` callback over `outgoing`, and that map stays empty
 * until someone sends: when a recipient's device cannot decrypt a message it asks the sender to
 * send it again, and Baileys answers such a retry receipt out of this callback. It holds only
 * what THIS connection sent — curlew keeps no store of outgoing message content.
 */
export const createBaileysConnection: ConnectionFactory = ({ auth, fullHistory = false }) => {
  /** What this connection sent, for a retry receipt — keyed by the message id Baileys generated. */
  const outgoing = new Map<string, proto.IMessage>();
  const sock = makeWASocket({
    auth: auth.state,
    logger: silentLogger(),
    markOnlineOnConnect: false,
    syncFullHistory: fullHistory,
    // Keep every history chunk the phone sends: Baileys' default drops the FULL one, and a
    // dropped chunk is gone — the phone does not send it twice.
    shouldSyncHistoryMessage: () => true,
    getMessage: async (key) => (key.id ? outgoing.get(key.id) : undefined),
  });
  sock.ev.on('creds.update', () => auth.saveCreds());

  // Tracked for `openSend().ready()`: Baileys' `sendNode` throws `Connection Closed` while the
  // WebSocket is not open, so a send waits for `connection: 'open'` instead of racing it. Watched
  // from the moment the connection exists, because a send view may be opened long after.
  let markOpen = () => {};
  let markFailed = (_error: Error) => {};
  const opened = new Promise<void>((resolve, reject) => {
    markOpen = resolve;
    markFailed = reject;
  });
  // Nothing awaits this before the first send, and an unawaited rejection is a process warning
  // on Node and a console message on GJS. `ready()` is where it is reported.
  opened.catch(() => {});
  let closed: Error | null = null;
  sock.ev.on('connection.update', (update) => {
    if (update.connection === 'open') {
      markOpen();
      return;
    }
    if (update.connection !== 'close') return;
    closed ??= new Error(
      fmt(_('the WhatsApp connection closed: {reason}'), { reason: disconnectReason(update) }),
    );
    markFailed(closed);
  });

  const handle: WaSocketHandle = {
    ev: sock.ev as unknown as WaSocketHandle['ev'],
    requestPairingCode: (phoneNumber) => sock.requestPairingCode(phoneNumber),
    end: () => {
      // Hand over what Baileys still buffers BEFORE closing: `end()` destroys the buffer, and
      // the messages in it were already acknowledged — the server will not send them again.
      sock.ev.flush();
      void sock.end(undefined).catch(() => {});
    },
  };

  return {
    handle,
    openSend: () => ({
      ev: sock.ev as unknown as WaSendSocketHandle['ev'],
      ready: async () => {
        await opened;
        // Opened and then dropped: `opened` is already resolved, so only this reports it.
        if (closed) throw closed;
      },
      sendText: async (jid, text) => {
        // `linkPreview: null`. `generateWAMessageContent` calls `generateLinkPreviewIfRequired`
        // only when the field is `undefined`, and that would fetch a URL found in the message
        // text over plain HTTP from this machine. `null` is the documented way to say no preview.
        const sent = await sock.sendMessage(jid, { text, linkPreview: null });
        if (!sent) throw new Error(_('WhatsApp did not take the message — nothing was sent'));
        if (sent.key.id && sent.message) outgoing.set(sent.key.id, sent.message);
        return sent;
      },
      // See `WaConnection.openSend`: the connection's owner closes it, never a send view.
      end: () => {},
    }),
  };
};

/** The receive view of a fresh connection — a handle with no way to write, and nothing else. */
export const createBaileysSocket: SocketFactory = (options) => createBaileysConnection(options).handle;

export type SendSocketFactory = (options: SocketOptions) => WaSendSocketHandle;

/**
 * A connection of its OWN that may send — what `WhatsAppBackend.openSender` builds when no
 * daemon holds the device, and only behind a `whatsapp.send` grant (ADR 0004).
 *
 * It is the send view of a fresh connection plus a real `end()`, because here the sender IS the
 * connection's owner. A send is not the place to ask the phone for history, so `fullHistory` is
 * off; what the server hands over anyway is kept (the send path journals it, `send.ts`).
 */
export const createBaileysSendSocket: SendSocketFactory = (options) => {
  const connection = createBaileysConnection({ ...options, fullHistory: false });
  return {
    ...connection.openSend(),
    // Hand over what Baileys still buffers before closing — this connection is handed the
    // offline queue too, and those messages were already acknowledged.
    end: () => connection.handle.end(),
  };
};

/**
 * A credential-free network check: open a socket for a fresh, unlinked device and wait for the
 * first QR code — which proves the WebSocket, the noise handshake, protobuf and the WASM bridge
 * work on this runtime — then close. Nothing is linked; the QR code is never shown or returned.
 */
export async function probeQr(
  auth: SecretStoreAuthState,
  timeoutMs = 60_000,
  createSocket: SocketFactory = createBaileysSocket,
): Promise<{ ms: number; qrLength: number }> {
  const started = Date.now();
  const sock = createSocket({ auth });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no QR code within ${timeoutMs} ms`)), timeoutMs);
      sock.ev.on('connection.update', (update) => {
        if (update.qr) {
          clearTimeout(timer);
          resolve({ ms: Date.now() - started, qrLength: update.qr.length });
        } else if (update.connection === 'close') {
          clearTimeout(timer);
          reject(new Error('the connection closed before a QR code arrived'));
        }
      });
    });
  } finally {
    sock.end();
    auth.flush();
  }
}
