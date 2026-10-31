/**
 * The session-bus interface `curlew daemon` exports, and the JSON that travels over it (ADR 0004,
 * amendment 2026-10-30, daemon send).
 *
 * Why a bus name and not a socket: owning `eu.jumplink.curlew.Daemon` IS the liveness check. A
 * caller does not stat a file, guess whether the process behind it still lives, or clean up a
 * stale one — it calls, and `NameHasNoOwner` means no daemon is running, which is exactly the
 * branch that falls back to the direct send path. The session bus is also per-user by
 * construction: another user's bus is another bus, and no permission bit has to be got right.
 *
 * Why ONE method taking and returning a JSON string, rather than a typed signature: the request
 * is the parameters of `curlew send` and the reply is a discriminated union with a nested list of
 * sent messages. As a D-Bus signature that is a `a{sv}` in and a deep struct out, written twice —
 * once as a type and once as a `GLib.Variant` builder — and every field added later changes both.
 * As `s` the signature never changes, the types below are the single description of the wire, and
 * `v` makes a version mismatch something the newer side can recognise instead of mis-parse.
 *
 * D-Bus errors stay reserved for the transport and for a defect: a send that was REFUSED (no
 * grant, not a sendable address) or that FAILED (the network said no) is a normal answer with a
 * sentence in it, because the caller has to tell those apart from "there is no daemon".
 */

import { _, fmt } from '@curlew/protocol';

export const DAEMON_BUS_NAME = 'eu.jumplink.curlew.Daemon';
export const DAEMON_OBJECT_PATH = '/eu/jumplink/curlew/Daemon';
export const DAEMON_INTERFACE = 'eu.jumplink.curlew.Daemon1';

export const DAEMON_INTERFACE_XML = `<node>
  <interface name="${DAEMON_INTERFACE}">
    <method name="Send">
      <arg type="s" name="request_json" direction="in"/>
      <arg type="s" name="reply_json" direction="out"/>
    </method>
  </interface>
</node>`;

/**
 * How long a caller waits for the daemon's answer.
 *
 * Generous on purpose: behind this call is a real send, and a WhatsApp send alone waits up to 15 s
 * for the server's acknowledgement while a Signal send may first have to fetch pre-keys for every
 * device of the recipient. A timeout here does NOT mean nothing was sent — the caller says so.
 */
export const DAEMON_SEND_TIMEOUT_MS = 120_000;

/** The wire version. Bump it when a field stops being optional or changes meaning. */
export const DAEMON_WIRE_VERSION = 1;

/**
 * One send, as the calling process asks for it.
 *
 * `capability` and `account` are what the CALLER checked its grants for; the daemon re-checks the
 * same pair against its own freshly loaded config and refuses if it does not hold (fail closed).
 * `backend` lets the daemon find the session without resolving the account again — and a request
 * whose backend does not match the session it found is not followed, not guessed at.
 */
export interface DaemonSendRequest {
  v: number;
  backend: string;
  account: string;
  capability: string;
  to: string;
  text?: string;
  imageUrl?: string;
  subject?: string;
  format?: 'plain' | 'markdown';
}

/** One message the daemon got out, and the body it was sent with — what the caller logs and indexes. */
export interface DaemonSendStep {
  sent: {
    target: string;
    id: string;
    sentAt: string;
    chatRemoteId?: string;
    encrypted?: boolean;
    warning?: string;
  };
  body: string;
}

/**
 * What the daemon answers.
 *
 *   - `sent` — it went out on the daemon's connection. The daemon wrote NO log line and indexed
 *     nothing: the caller owns both, so a message is logged and indexed exactly once no matter
 *     which path carried it.
 *   - `not-followed` — the daemon is running but is not holding this account, so the caller's own
 *     direct path is free to take it.
 *   - `refused` — nothing was sent, and the reason is the user's to act on (no grant, an address
 *     the grant does not name).
 *   - `failed` — the send was attempted and did not complete. `message` is one sentence; whether
 *     anything reached the network is what it has to say.
 */
export type DaemonSendReply =
  | { v: number; kind: 'sent'; markdown: boolean; steps: DaemonSendStep[] }
  | { v: number; kind: 'not-followed' }
  | { v: number; kind: 'refused'; message: string }
  | { v: number; kind: 'failed'; message: string };

/**
 * Read a reply off the wire, or throw. Anything that is not one of the four kinds is a defect on
 * the other side, not a user path, so the message is terse and in English — except the version
 * mismatch, which is what an upgrade with the old daemon still running looks like.
 */
export function parseDaemonSendReply(json: string): DaemonSendReply {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error('the curlew daemon answered something that is not JSON', { cause: error });
  }
  if (typeof value !== 'object' || value === null) throw new Error('the curlew daemon answered no object');
  const reply = value as Partial<DaemonSendReply>;
  if (reply.v !== DAEMON_WIRE_VERSION) {
    throw new Error(
      fmt(
        _(
          'the running curlew daemon speaks send protocol {theirs} and this curlew speaks {ours} — nothing was sent; restart it with `systemctl --user restart curlew-daemon`',
        ),
        { theirs: String(reply.v), ours: String(DAEMON_WIRE_VERSION) },
      ),
    );
  }
  switch (reply.kind) {
    case 'sent':
      if (!Array.isArray((reply as { steps?: unknown }).steps))
        throw new Error('the curlew daemon reported a send without the messages it sent');
      return reply as DaemonSendReply;
    case 'not-followed':
      return reply as DaemonSendReply;
    case 'refused':
    case 'failed':
      if (typeof (reply as { message?: unknown }).message !== 'string')
        throw new Error('the curlew daemon reported a problem without saying what it was');
      return reply as DaemonSendReply;
    default:
      throw new Error(`the curlew daemon answered an unknown reply kind ${String(reply.kind)}`);
  }
}

/** Read a request off the wire, or throw — the daemon's side of the same check. */
export function parseDaemonSendRequest(json: string): DaemonSendRequest {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error('the send request is not JSON', { cause: error });
  }
  if (typeof value !== 'object' || value === null) throw new Error('the send request is not an object');
  const request = value as Partial<DaemonSendRequest>;
  if (request.v !== DAEMON_WIRE_VERSION) {
    throw new Error(
      fmt(
        _(
          'the caller speaks send protocol {theirs} and this curlew daemon speaks {ours} — nothing was sent; restart it with `systemctl --user restart curlew-daemon`',
        ),
        { theirs: String(request.v), ours: String(DAEMON_WIRE_VERSION) },
      ),
    );
  }
  for (const field of ['backend', 'account', 'capability', 'to'] as const) {
    if (typeof request[field] !== 'string' || request[field] === '')
      throw new Error(`the send request has no ${field}`);
  }
  return request as DaemonSendRequest;
}
