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
 * The SEND socket (`createBaileysSendSocket`) keeps all of that and adds exactly one write,
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

/** The one place Baileys' socket is constructed. */
export const createBaileysSocket: SocketFactory = ({ auth, fullHistory = false }) => {
  const sock = makeWASocket({
    auth: auth.state,
    logger: silentLogger(),
    markOnlineOnConnect: false,
    syncFullHistory: fullHistory,
    // Keep every history chunk the phone sends: Baileys' default drops the FULL one, and a
    // dropped chunk is gone — the phone does not send it twice.
    shouldSyncHistoryMessage: () => true,
    // Only used to re-send the user's own messages on a retry request; this socket sends none.
    getMessage: async () => undefined,
  });
  sock.ev.on('creds.update', () => auth.saveCreds());
  return {
    ev: sock.ev as unknown as WaSocketHandle['ev'],
    requestPairingCode: (phoneNumber) => sock.requestPairingCode(phoneNumber),
    end: () => {
      // Hand over what Baileys still buffers BEFORE closing: `end()` destroys the buffer, and
      // the messages in it were already acknowledged — the server will not send them again.
      sock.ev.flush();
      void sock.end(undefined).catch(() => {});
    },
  };
};

export type SendSocketFactory = (options: SocketOptions) => WaSendSocketHandle;

/**
 * The second socket shape: one connection that may ALSO send, built only by
 * `WhatsAppBackend.openSender` and only behind a `whatsapp.send` grant (ADR 0004).
 *
 * It is a separate factory rather than a flag on the one above, because the read-only guarantee
 * of the receive path is structural: `createBaileysSocket` returns a handle with no send method,
 * so no amount of wiring can make a sync write. This one exposes exactly one write,
 * `sendText(jid, text)`, and `guard.ts` wraps even that before the sender sees it.
 *
 * Three details beyond the receive socket:
 *
 *   - `linkPreview: null`. `generateWAMessageContent` calls `generateLinkPreviewIfRequired` only
 *     when the field is `undefined`, and that would fetch a URL found in the message text over
 *     plain HTTP from this machine. `null` is the documented way to say no preview.
 *   - `getMessage` answers from what THIS handle sent. When a recipient's device cannot decrypt a
 *     message it asks the sender to send it again; Baileys answers such a retry receipt out of
 *     this callback. It only holds this handle's own sends: curlew has no store of outgoing
 *     message content, and a handle that has been closed answers nothing (see `send.ts`).
 *   - `ready()`. Baileys' `sendNode` throws `Connection Closed` while the WebSocket is not open,
 *     so a send waits for `connection: 'open'` instead of racing it.
 */
export const createBaileysSendSocket: SendSocketFactory = ({ auth }) => {
  /** What this handle sent, for a retry receipt — keyed by the message id Baileys generated. */
  const outgoing = new Map<string, proto.IMessage>();
  const sock = makeWASocket({
    auth: auth.state,
    logger: silentLogger(),
    markOnlineOnConnect: false,
    // A send is not the place to ask the phone for history; what the server hands over anyway is
    // kept (the receive journal takes it), but nothing is requested.
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => true,
    getMessage: async (key) => (key.id ? outgoing.get(key.id) : undefined),
  });
  sock.ev.on('creds.update', () => auth.saveCreds());

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

  return {
    ev: sock.ev as unknown as WaSendSocketHandle['ev'],
    ready: async () => {
      await opened;
      // Opened and then dropped: `opened` is already resolved, so only this reports it.
      if (closed) throw closed;
    },
    sendText: async (jid, text) => {
      const sent = await sock.sendMessage(jid, { text, linkPreview: null });
      if (!sent) throw new Error(_('WhatsApp did not take the message — nothing was sent'));
      if (sent.key.id && sent.message) outgoing.set(sent.key.id, sent.message);
      return sent;
    },
    end: () => {
      // Same as the receive socket: hand over what Baileys still buffers BEFORE closing. This
      // connection is handed the offline queue too, and those messages were already acknowledged.
      sock.ev.flush();
      void sock.end(undefined).catch(() => {});
    },
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
