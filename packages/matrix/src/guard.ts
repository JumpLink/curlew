/**
 * The read-only gate: every HTTP request matrix-js-sdk makes for curlew goes through
 * `readOnlyFetch`, and anything that would change what other people see is refused before it
 * leaves the process.
 *
 * A client library does not know it is meant to be read-only. matrix-js-sdk marks the user
 * online on every `/sync` unless told otherwise (an omitted `set_presence` means `online`, per the
 * client-server spec), and one wrong call elsewhere could send a read receipt, a typing notice or
 * a message. Configuring the SDK right (`disablePresence`) is the first line; this allowlist is the
 * second, and it fails closed: a request that matches no rule is refused with an error that stops
 * the sync, instead of being sent.
 *
 * Allowed, besides every GET:
 *   - login/logout (the login flow and cleaning up a failed one)
 *   - creating the sync filter (server-side, private to the user)
 *   - the E2EE key protocol: uploading this device's keys, querying and claiming others', and
 *     to-device messages (room-key requests and Olm session repair). None of it is visible as
 *     content; without it the device could decrypt nothing.
 * GET `/sync` is allowed only with `set_presence=offline`.
 *
 * Sending is NOT on that allowlist and never becomes so: `readOnlyFetch` refuses the send PUT,
 * for every room, whatever the grants say. A granted send uses `sendFetch` instead — a SECOND
 * wrapper, built per permit in `openSender`, that allows exactly `PUT …/send/m.room.message/…`
 * for exactly the room ids that permit names and falls back to `refusal` for everything else.
 * Two consequences worth the duplication: the sync client, which is the only thing matrix-js-sdk
 * ever touches, has no reachable send endpoint at all; and because the rule names the event type
 * `m.room.message` literally, even a granted handle cannot PUT an `m.room.encrypted` — the
 * second line of defence behind the sender's own encryption check.
 *
 * Pure: functions over (method, URL), so they are unit-tested on both runtimes.
 */

const CLIENT = String.raw`^/_matrix/client/(?:v3|r0|v1|unstable)`;

const ALLOWED: ReadonlyArray<{ method: string; path: RegExp; why: string }> = [
  { method: 'POST', path: new RegExp(`${CLIENT}/login$`), why: 'log in' },
  { method: 'POST', path: new RegExp(`${CLIENT}/logout$`), why: 'log a failed login out again' },
  { method: 'POST', path: new RegExp(`${CLIENT}/user/[^/]+/filter$`), why: 'the sync filter' },
  { method: 'POST', path: new RegExp(`${CLIENT}/keys/(?:upload|query|claim)$`), why: 'E2EE keys' },
  { method: 'PUT', path: new RegExp(`${CLIENT}/sendToDevice/[^/]+/[^/]+$`), why: 'E2EE to-device' },
];

/** Why a request is refused, or null when it may go out. */
export function refusal(method: string, url: string): string | null {
  const verb = method.toUpperCase();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `not a URL: ${url}`;
  }
  const path = parsed.pathname;
  if (verb === 'GET' || verb === 'HEAD') {
    if (new RegExp(`${CLIENT}/sync$`).test(path) && parsed.searchParams.get('set_presence') !== 'offline') {
      return 'a /sync without set_presence=offline would mark the user online';
    }
    return null;
  }
  if (ALLOWED.some((rule) => rule.method === verb && rule.path.test(path))) return null;
  return `${verb} ${path} is not on curlew's read-only allowlist`;
}

/** The one endpoint a send uses: `PUT /rooms/{roomId}/send/m.room.message/{txnId}`. */
const SEND = new RegExp(String.raw`${CLIENT}/rooms/([^/]+)/send/m\.room\.message/[^/]+$`);

/**
 * Why a request is refused for a sender permitted to write to `rooms`, or null when it may go out.
 *
 * Everything `refusal` allows stays allowed (the encryption-state read is a GET), plus the send
 * PUT for a permitted room. A room id the permit does not name is refused without naming it: the
 * caller already knows which address it asked for, and a refusal is not a place to put room ids.
 */
export function sendRefusal(method: string, url: string, rooms: readonly string[]): string | null {
  if (method.toUpperCase() === 'PUT') {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return `not a URL: ${url}`;
    }
    const match = SEND.exec(parsed.pathname);
    if (match) {
      return rooms.includes(decodeURIComponent(match[1]))
        ? null
        : 'a message to a room no grant names';
    }
  }
  return refusal(method, url);
}

export class ReadOnlyViolation extends Error {
  constructor(reason: string) {
    super(`curlew is read-only: refused to send ${reason}`);
    this.name = 'ReadOnlyViolation';
  }
}

/** Every refusal of this process, for a caller (and a test) to prove the gate never tripped. */
export const refusals: string[] = [];

/** Wrap a fetch so it refuses every request `decide` names a reason for. */
function guardedFetch(
  inner: typeof globalThis.fetch,
  decide: (method: string, url: string) => string | null,
  ledger: string[] | null,
): typeof globalThis.fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
    const reason = decide(method, url);
    if (reason) {
      ledger?.push(reason);
      return Promise.reject(new ReadOnlyViolation(reason));
    }
    return inner(input, init);
  };
}

/** Wrap a fetch so it refuses every request `refusal` names — the sync and login client. */
export function readOnlyFetch(inner: typeof globalThis.fetch): typeof globalThis.fetch {
  return guardedFetch(inner, refusal, refusals);
}

/**
 * Wrap a fetch for ONE granted sender: the send PUT for exactly these rooms, and otherwise the
 * read-only gate. `rooms` is copied, so a later change to the permit cannot widen this handle.
 *
 * Deliberately NOT written into `refusals`: that ledger is what a sync session reads to decide it
 * was never asked to write (`healthy()` in client.ts fails the run on any entry). A send refused
 * here already fails its own call loudly, and must not fail a sync that happens to run in the
 * same process. The pure `sendRefusal` is what a test asserts on.
 */
export function sendFetch(
  inner: typeof globalThis.fetch,
  rooms: readonly string[],
): typeof globalThis.fetch {
  const permitted = [...rooms];
  return guardedFetch(inner, (method, url) => sendRefusal(method, url, permitted), null);
}
