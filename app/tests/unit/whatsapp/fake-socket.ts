import type {
  ConnectionFactory,
  SendSocketFactory,
  SocketFactory,
  SocketOptions,
  WaConnection,
  WaEventMap,
  WaEventName,
  WaMessage,
  WaMessageContent,
  WaMessageKey,
  WaSendSocketHandle,
  WaSentMessage,
  WaSocketHandle,
} from '@curlew/whatsapp';
import { SERVER_ACK } from '@curlew/whatsapp';

/**
 * A scriptable stand-in for Baileys' socket. The receive path, the login, a whole sync and a
 * granted send run against these exactly as against WhatsApp — with no network, no phone and no
 * account. Every id, number and name here is synthetic. The manual clock that drives the receive
 * timers lives beside the other fakes, in `../clock.ts`, because Signal's receive suite needs it too.
 */

type Listener = (data: unknown) => void;

/** Baileys' `on`/`off` plus a hand-driven `emit`. Both socket shapes are built on this. */
export class FakeEvents {
  private readonly listeners = new Map<string, Set<Listener>>();

  readonly ev = {
    on: <E extends WaEventName>(event: E, listener: (data: WaEventMap[E]) => void) => {
      let set = this.listeners.get(event);
      if (!set) {
        set = new Set();
        this.listeners.set(event, set);
      }
      set.add(listener as Listener);
    },
    off: <E extends WaEventName>(event: E, listener: (data: WaEventMap[E]) => void) => {
      this.listeners.get(event)?.delete(listener as Listener);
    },
  };

  emit<E extends WaEventName>(event: E, data: WaEventMap[E]): void {
    // A snapshot: a listener may detach itself (or others) while the event is delivered.
    const listeners = [...(this.listeners.get(event) ?? [])];
    for (const listener of listeners) listener(data);
  }

  listenerCount(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}

export class FakeSocket extends FakeEvents implements WaSocketHandle {
  ended = false;
  pairingRequests: string[] = [];
  readonly options: SocketOptions;

  constructor(options: SocketOptions) {
    super();
    this.options = options;
  }

  async requestPairingCode(phoneNumber: string): Promise<string> {
    this.pairingRequests.push(phoneNumber);
    return 'ABCD1234';
  }

  /** Events Baileys would still hold in its buffer; `end()` hands them over first, like the real handle. */
  readonly buffered: Array<() => void> = [];

  hold<E extends WaEventName>(event: E, data: WaEventMap[E]): void {
    this.buffered.push(() => this.emit(event, data));
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const release of this.buffered.splice(0)) release();
    // Baileys reports its own close asynchronously, after the socket is down.
    queueMicrotask(() => this.emit('connection.update', { connection: 'close', lastDisconnect: {} }));
  }
}

/** A factory that records every socket it made; `onCreate` scripts what each one does. */
export function fakeFactory(onCreate: (socket: FakeSocket, index: number) => void = () => {}): {
  create: SocketFactory;
  sockets: FakeSocket[];
} {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    create: (options) => {
      const socket = new FakeSocket(options);
      const index = sockets.length;
      sockets.push(socket);
      // Like Baileys: events come after construction, never synchronously inside it.
      queueMicrotask(() => onCreate(socket, index));
      return socket;
    },
  };
}

/**
 * The send socket, as `openSender` is handed one: it opens, takes exactly one text at a time and
 * answers like Baileys does — a `WaSentMessage` with a server id and timestamp, the sent message
 * echoed back through `messages.upsert` (`emitOwnEvents`), and the server's `SERVER_ACK` through
 * `messages.update`. Each of the three is switchable, because each is a case the sender has an
 * answer for: no ack is a warning, no echo is a chat that only fills in on the next sync.
 */
let nextSend = 1;

export class FakeSendSocket extends FakeEvents implements WaSendSocketHandle {
  ended = false;
  readonly options: SocketOptions;
  /** Every text that got through the gate, in order. */
  readonly sent: Array<{ jid: string; text: string; id: string; seconds: number }> = [];
  /** Confirm each send with `SERVER_ACK`. Off drives the ack timeout. */
  ack = true;
  /** Echo the sent message back, as a real connection does for its own writes. */
  echo = true;
  /** Fail the next `sendText` instead of sending — nothing may be on the wire then. */
  failWith: Error | null = null;
  /** The key the server answers with. Default: this chat, `fromMe`, the generated id. */
  keyFor: ((jid: string, id: string) => WaMessageKey) | null = null;
  private opened = false;
  private openWaiters: Array<() => void> = [];
  private openError: Error | null = null;
  /**
   * Where the echo and the ack of a send are emitted. Its own bus for a socket of its own; on a
   * two-view connection the CONNECTION's bus, which the receive loop is listening to as well —
   * that sharing is what an in-session send actually is.
   */
  private readonly bus: FakeEvents;

  constructor(options: SocketOptions, bus?: FakeEvents) {
    super();
    this.options = options;
    this.bus = bus ?? this;
  }

  /** The connection is up; `ready()` resolves from here on. */
  open(): void {
    this.opened = true;
    for (const waiter of this.openWaiters.splice(0)) waiter();
  }

  async ready(): Promise<void> {
    if (this.openError) throw this.openError;
    if (this.opened) return;
    await new Promise<void>((resolve) => this.openWaiters.push(resolve));
    if (this.openError) throw this.openError;
  }

  async sendText(jid: string, text: string): Promise<WaSentMessage> {
    if (this.failWith) {
      const error = this.failWith;
      this.failWith = null;
      throw error;
    }
    // Message ids are unique per account, not per connection: a second send must not reuse the
    // id of the first, or its local echo collides with the one already in the index.
    const n = nextSend++;
    const id = `WA${n}`;
    const seconds = 1_767_270_000 + n;
    this.sent.push({ jid, text, id, seconds });
    const key = this.keyFor?.(jid, id) ?? { remoteJid: jid, fromMe: true, id };
    // Baileys emits both of these after `sendMessage` resolved, through `process.nextTick`.
    queueMicrotask(() => {
      if (this.echo) {
        this.bus.emit('messages.upsert', {
          type: 'append',
          messages: [{ key, message: { conversation: text }, messageTimestamp: seconds }],
        });
      }
      if (this.ack) this.bus.emit('messages.update', [{ key, update: { status: SERVER_ACK } }]);
    });
    return { key, messageTimestamp: seconds };
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.openError ??= new Error('the WhatsApp connection closed: connection closed');
    for (const waiter of this.openWaiters.splice(0)) waiter();
  }
}

/** A factory for send sockets; each one opens on its own, as a connection does. */
export function fakeSendFactory(onCreate: (socket: FakeSendSocket, index: number) => void = () => {}): {
  create: SendSocketFactory;
  sockets: FakeSendSocket[];
} {
  const sockets: FakeSendSocket[] = [];
  return {
    sockets,
    create: (options) => {
      const socket = new FakeSendSocket(options);
      const index = sockets.length;
      sockets.push(socket);
      queueMicrotask(() => {
        onCreate(socket, index);
        if (!socket.ended) socket.open();
      });
      return socket;
    },
  };
}

/**
 * One connection under the two views `createBaileysConnection` returns: the receive handle, and
 * a send view over the SAME event bus. The sharing is the point — the echo and the server's ack
 * of an in-session send arrive where the daemon's receive loop is listening, as they do on a real
 * connection, and the receive view still has no way to write.
 *
 * `ready()` follows the handle's `connection.update`, so the script that opens the connection is
 * also what lets a send through. The send view's `end()` is a no-op here as it is there; it only
 * counts, so a test can show the receive loop survives a sender's `close()`.
 */
export class FakeConnection implements WaConnection {
  readonly handle: FakeSocket;
  /** The send views opened off this connection, in order — one per `openSend()`. */
  readonly sends: FakeSendSocket[] = [];
  /** How often a send view's no-op `end()` was called. */
  sendViewEnds = 0;
  private opened = false;

  constructor(options: SocketOptions) {
    this.handle = new FakeSocket(options);
    this.handle.ev.on('connection.update', (update) => {
      if (update.connection === 'open') {
        this.opened = true;
        for (const send of this.sends) send.open();
      } else if (update.connection === 'close') {
        // Every open view reports the drop, as the real connection's `opened` promise does.
        for (const send of this.sends) send.end();
      }
    });
  }

  openSend(): WaSendSocketHandle {
    const send = new FakeSendSocket(this.handle.options, this.handle);
    this.sends.push(send);
    if (this.opened) send.open();
    return {
      ev: this.handle.ev,
      ready: () => send.ready(),
      sendText: (jid, body) => send.sendText(jid, body),
      end: () => {
        this.sendViewEnds++;
      },
    };
  }
}

/** A factory of two-view connections — what `WhatsAppBackendOptions.createConnection` takes. */
export function fakeConnectionFactory(
  onCreate: (connection: FakeConnection, index: number) => void = () => {},
): { create: ConnectionFactory; connections: FakeConnection[] } {
  const connections: FakeConnection[] = [];
  return {
    connections,
    create: (options) => {
      const connection = new FakeConnection(options);
      const index = connections.length;
      connections.push(connection);
      // Like Baileys: events come after construction, never synchronously inside it.
      queueMicrotask(() => onCreate(connection, index));
      return connection;
    },
  };
}

// ── synthetic identities ──────────────────────────────────────────────

export const ANNA_PN = '4915100000001@s.whatsapp.net';
export const ANNA_LID = '100000000000001@lid';
export const BEN_LID = '100000000000002@lid';
export const GROUP = '120363000000000001@g.us';

export function text(body: string): WaMessageContent {
  return { conversation: body };
}

export function waMessage(
  chat: string,
  id: string,
  seconds: number,
  content: WaMessageContent | null,
  extra: Partial<WaMessage> & { fromMe?: boolean; participant?: string; remoteJidAlt?: string } = {},
): WaMessage {
  const { fromMe, participant, remoteJidAlt, ...rest } = extra;
  return {
    key: {
      remoteJid: chat,
      id,
      fromMe: fromMe ?? false,
      ...(participant ? { participant } : {}),
      ...(remoteJidAlt ? { remoteJidAlt } : {}),
    },
    message: content,
    messageTimestamp: seconds,
    ...rest,
  };
}
