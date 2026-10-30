/**
 * Read-only through a gate, not through good intentions.
 *
 * Everything curlew could ever SEND to Signal passes through one function: the `fetch` of a
 * libsignal chat connection (an HTTP-shaped request over Signal's pinned WebSocket). Every holder
 * of such a `fetch` in this package is wrapped: the link gets `guardedFetch('link', …)`, the sync
 * gets no fetch at all, and a granted send gets `sendFetch(…)` — the per-permit gate at the
 * bottom of this file. Both allowlists are FAIL-CLOSED: a request that is not named is refused
 * before it reaches libsignal.
 *
 * What a linked device must send, verified in Signal-Desktop (`ts/textsecure/AccountManager`,
 * `WebAPI`, `MessageReceiver`) and libsignal (`node/ts/net/Chat.ts`):
 *
 * - at link time: `PUT /v1/devices/link` (the device's password, registration id, encrypted name,
 *   signed and last-resort Kyber pre-keys) and `PUT /v2/keys?identity=aci` (one-time pre-keys; a
 *   device without them still receives, senders fall back to the last-resort key);
 * - during a sync: the acknowledgement of each delivered envelope (a WebSocket response, not a
 *   request — libsignal's `ChatServerMessageAck`; without it the server keeps the message and
 *   redelivers it), and libsignal's own keep-alives.
 *
 * What a linked device does NOT have to send, and curlew therefore never sends: delivery and
 * read receipts, typing indicators, sync requests to the phone (contacts, groups, configuration),
 * retry requests for undecryptable messages (`DecryptionErrorMessage`), profile or group fetches,
 * signed pre-key rotation and one-time key refills. Widen this list only with a test naming the
 * request and a reason in this comment. A granted message send is not on it either: it never
 * becomes reachable from `link` or `sync`, only from a permit (see the send gate below).
 */

export type GatePhase = 'link' | 'sync';

export interface ChatRequestLike {
  verb: string;
  path: string;
  headers: ReadonlyArray<[string, string]>;
  body?: Uint8Array;
}

const ALLOWED: Record<GatePhase, ReadonlyArray<{ verb: string; path: RegExp; why: string }>> = {
  link: [
    { verb: 'PUT', path: /^\/v1\/devices\/link$/, why: 'register this device with the code the phone sent' },
    { verb: 'PUT', path: /^\/v2\/keys\?identity=aci$/, why: 'publish one-time pre-keys once' },
  ],
  sync: [],
};

export class ReadOnlyViolation extends Error {
  constructor(phase: GatePhase, request: ChatRequestLike) {
    super(`curlew is read-only: refused ${request.verb} ${request.path.split('?')[0]} during ${phase}`);
    this.name = 'ReadOnlyViolation';
  }
}

/** Throws unless the request is on the allowlist of `phase`. */
export function checkRequest(phase: GatePhase, request: ChatRequestLike): void {
  const allowed = ALLOWED[phase].some((rule) => rule.verb === request.verb && rule.path.test(request.path));
  if (!allowed) throw new ReadOnlyViolation(phase, request);
}

export interface ChatResponseLike {
  status: number;
  message?: string;
  body?: Uint8Array;
}

export type ChatFetch = (request: ChatRequestLike) => Promise<ChatResponseLike>;

/** Wrap a connection's `fetch` in the gate. */
export function guardedFetch(phase: GatePhase, fetch: ChatFetch): ChatFetch {
  return async (request) => {
    checkRequest(phase, request);
    return fetch(request);
  };
}

// ── the send gate ───────────────────────────────────────────────────────

/**
 * A granted send does NOT widen the phases above: it gets a SECOND gate, built per permit in
 * `openSender`, over its own chat connection. `sync` stays empty, so the receive session has no
 * reachable send endpoint whatever the grants say — the only way to reach one is to hold a permit.
 *
 * What a plain-text 1:1 send needs, and all it is allowed:
 *
 * - `GET /v2/keys/{aci}/{device|*}` — the recipient's pre-key bundles, to start a session with a
 *   device curlew has never written to. Allowed only for a service id the permit names (plus the
 *   user's own ACI, which the caller puts in the permitted list for the sync transcript).
 * - `PUT /v1/messages/{aci}` — the encrypted message itself, again only to a permitted service id.
 *   The own ACI is permitted so the user's other devices get the `SyncMessage.Sent` transcript;
 *   without it the phone never shows what curlew wrote.
 *
 * Everything else is refused, including the link endpoints `ALLOWED.link` names: a send handle
 * must not be able to re-register the device. Profile fetches, receipts, typing indicators and
 * key refills stay unreachable from here too — widen this only with a test naming the request.
 */

/** A service id in a Signal path: the bare ACI UUID. curlew sends to ACIs, never to a PNI. */
const SERVICE_ID = String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`;

const PRE_KEYS = new RegExp(String.raw`^/v2/keys/(${SERVICE_ID})/(?:\*|\d+)(?:\?.*)?$`, 'i');
const SEND = new RegExp(String.raw`^/v1/messages/(${SERVICE_ID})(?:\?.*)?$`, 'i');

/**
 * Why a request is refused for a sender permitted to write to `recipients`, or null when it may
 * go out. A service id no permit names is refused without naming it: the caller knows what it
 * asked for, and a refusal is not a place to put other people's ACIs.
 */
export function sendRefusal(request: ChatRequestLike, recipients: readonly string[]): string | null {
  const verb = request.verb.toUpperCase();
  const permits = (id: string): boolean => recipients.some((r) => r.toLowerCase() === id.toLowerCase());
  if (verb === 'GET') {
    const keys = PRE_KEYS.exec(request.path);
    if (keys) return permits(keys[1]) ? null : 'the pre-keys of someone no grant names';
  }
  if (verb === 'PUT') {
    const send = SEND.exec(request.path);
    if (send) return permits(send[1]) ? null : 'a message to someone no grant names';
  }
  return `${verb} ${request.path.split('?')[0]} is not part of sending a message`;
}

export class SendViolation extends Error {
  constructor(reason: string) {
    super(`curlew refused to send: ${reason}`);
    this.name = 'SendViolation';
  }
}

/**
 * Wrap a chat connection's `fetch` for ONE granted sender. `recipients` is copied, so a later
 * change to the permit cannot widen a handle that is already open.
 */
export function sendFetch(fetch: ChatFetch, recipients: readonly string[]): ChatFetch {
  const permitted = [...recipients];
  return async (request) => {
    const reason = sendRefusal(request, permitted);
    if (reason) throw new SendViolation(reason);
    return fetch(request);
  };
}
