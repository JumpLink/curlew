/**
 * GNOME Online Accounts enumeration.
 *
 * Uses the native `Goa` typelib to list configured accounts and which data
 * domains each exposes. Returns plain DTOs — no GObject instances, no secrets
 * (OAuth tokens / passwords are fetched lazily by the future mail layer, never
 * here). Runs unchanged on GJS and on Node/Bun via `@gjsify/node-gi` — see `index.ts`.
 */

import GLib from 'gi://GLib?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import type Goa from 'gi://Goa?version=1.0';

import { GNOME_CLIENT_NAME, GOA_UNAVAILABLE_MESSAGE, NO_ACCOUNTS_MESSAGE } from '@curlew/protocol';
import { errorMessage } from '@curlew/protocol';
import type { GnomeAccount, GnomeCheckResult } from '@curlew/protocol';
import { getRegistry } from './eds.gjs.ts';
import { gnomeError, isGnomeFailure } from './errors.ts';
import { goa } from './libs.gjs.ts';

let clientPromise: Promise<Goa.Client> | null = null;

/**
 * How long `Goa.Client.new` may take before it is cancelled, in milliseconds.
 *
 * A missing session bus fails in milliseconds — measured 2 ms against a dead path — so this
 * is not about that case. It is about a session bus that ACCEPTS the connection and then never
 * answers: `Goa.Client.new` is a D-Bus round trip with no timeout of its own, and against a
 * socket that listens but never replies it never returns at all. Measured on Node before this
 * bound: the check ran until the 30 s harness timeout (exit 124) where it now answers in ~2 s;
 * on GJS the same is true, but there the process could not report anything, so it hung visibly.
 *
 * 5 s: under GLib's own default D-Bus timeout for a method call (25 s) on purpose — this is a
 * user-facing CLI, and a check that takes 25 s to admit it cannot reach GOA is worse than one
 * that admits it in 5. A working GOA answers in well under a second locally, so the bound is
 * never what a healthy session trips.
 */
const GOA_CONNECT_TIMEOUT_MS = 5_000;

/**
 * Promise wrapper around the async GOA client constructor. The @girs types only
 * expose the callback form for the static `new`, so we bridge it by hand rather
 * than relying on Gio._promisify of a static method.
 *
 * The cancellable is what makes the timeout real: it is cancelled by `GLib.timeout_add` and the
 * pending `Client.new` then completes with a cancellation error, which is a rejection rather
 * than a promise that never settles.
 */
function newGoaClient(lib: typeof Goa, cancellable: Gio.Cancellable): Promise<Goa.Client> {
  return new Promise((resolve, reject) => {
    lib.Client.new(cancellable, (_source, res) => {
      try {
        resolve(lib.Client.new_finish(res));
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Lazily create and cache the GOA client (one live D-Bus connection per process).
 *
 * This is the ONE error boundary for GOA: a missing `Goa` typelib leaves as a
 * `GnomeUnavailableError` (from `goa.get()`), every other native failure — the session bus is
 * unreachable, the connect did not answer within `GOA_CONNECT_TIMEOUT_MS` — as a `GnomeError`
 * naming the call. Without it the raw `GLib.Error` crosses into the CLI, where it is not even
 * an `instanceof Error` under GJS.
 */
export async function getClient(): Promise<Goa.Client> {
  if (!clientPromise) {
    const p = (async () => {
      const lib = await goa.get();
      const cancellable = new Gio.Cancellable();
      let timedOut = false;
      // SOURCE_REMOVE drops the source once it fires, so a client that arrives in time leaves
      // no timer behind to hold the event loop open.
      const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, GOA_CONNECT_TIMEOUT_MS, () => {
        timedOut = true;
        cancellable.cancel();
        return GLib.SOURCE_REMOVE;
      });
      try {
        return await newGoaClient(lib, cancellable);
      } catch (err) {
        throw gnomeError(
          timedOut
            ? `Goa.Client.new: timed out after ${GOA_CONNECT_TIMEOUT_MS} ms — the session bus accepted the connection but never answered`
            : 'Goa.Client.new',
          err,
        );
      } finally {
        GLib.Source.remove(timer);
      }
    })();
    // Drop the cache on failure so a later call can retry.
    p.catch(() => {
      if (clientPromise === p) clientPromise = null;
    });
    clientPromise = p;
  }
  return clientPromise;
}

/** Map one Goa.Object → plain DTO. Returns null for objects without an account. */
function mapAccount(obj: Goa.Object): GnomeAccount | null {
  const account = obj.get_account();
  if (!account) return null;
  return {
    id: account.id ?? '',
    provider: account.provider_type ?? '',
    providerName: account.provider_name ?? '',
    identity: account.identity ?? '',
    presentation: account.presentation_identity ?? '',
    capabilities: {
      mail: !!obj.get_mail() && !account.mail_disabled,
      calendar: !!obj.get_calendar() && !account.calendar_disabled,
      contacts: !!obj.get_contacts() && !account.contacts_disabled,
      files: !!obj.get_files() && !account.files_disabled,
    },
    auth: {
      oauth2: !!obj.get_oauth2_based(),
      password: !!obj.get_password_based(),
    },
  };
}

/** Do the work. Everything here may raise a native error; `listAccounts` owns the boundary. */
async function listAccountsImpl(): Promise<GnomeAccount[]> {
  const client = await getClient();
  const accounts: GnomeAccount[] = [];
  for (const obj of client.get_accounts()) {
    // mapAccount reads ~12 properties off two GObjects; each can raise on its own, and on
    // GJS an unwrapped GLib.Error is not `instanceof Error` and JSON-serializes to `{}`.
    const dto = mapAccount(obj);
    if (dto) accounts.push(dto);
  }
  return accounts;
}

/** List all configured GNOME Online Accounts as plain DTOs. */
export async function listAccounts(): Promise<GnomeAccount[]> {
  try {
    return await listAccountsImpl();
  } catch (err) {
    if (isGnomeFailure(err)) throw err;
    throw gnomeError('listAccounts', err);
  }
}

/**
 * The unavailable answer leads with postbote's own sentence and appends the cause.
 * A raw Gio error ("Verbindung ist gescheitert: …", or whatever the host locale
 * says) is not something a reader can act on, and it is what used to reach the CLI
 * verbatim — but dropping it entirely would make a missing typelib
 * indistinguishable from an unreachable session bus, so it stays as the tail.
 */
function unavailableMessage(detail: string): string {
  const trimmed = detail.trim();
  return trimmed ? `${GOA_UNAVAILABLE_MESSAGE} — ${trimmed}` : GOA_UNAVAILABLE_MESSAGE;
}

/**
 * The one place a GOA/EDS failure is turned into something a caller can act on.
 *
 * Exported so every entry point routes through it, not just `check()`. The MCP server answers
 * `{"error": <message>}` straight from the thrown value, so a path that skipped this reported
 * `Goa.Client.new: Verbindungen ist gescheitert: Datei oder Verzeichnis nicht gefunden` — a raw
 * locale string — while `postbote check` on the very same host reported the stable sentence.
 *
 * The sentence always leads, for a `GnomeError` too: its message names the CALL that failed
 * ("Goa.Client.new: …"), not the condition, and the locale tail under it is what the reader
 * cannot act on. A missing typelib (`GnomeUnavailableError`) already names itself in
 * postbote's wording and is not routed here by the MCP layer, because @curlew/imap raises the
 * same class for "needs GJS", which this sentence would misdescribe. Prepending is what
 * makes the failure kinds distinguishable — typelib or bus missing, whatever the host language.
 */
export function describeUnavailable(err: unknown): string {
  return unavailableMessage(isGnomeFailure(err) ? err.message : errorMessage(err));
}

/**
 * Connectivity probe. Reports three states without leaking PII:
 *   - GOA or EDS unreachable (typelib or session) → ok:false
 *   - 0 accounts                                  → ok:true (hint to add one)
 *   - N accounts                                  → ok:true (count + provider types only)
 *
 * It probes BOTH bindings, not just GOA: `postbote check` is the one command whose job is to
 * say what works, and a GOA-only probe reports ok:true on a host with GOA but no EDS — then
 * `postbote contacts` and `postbote calendar` fail on the next command, which is the one
 * answer a reader cannot act on. So the EDS source registry is resolved too; a failure there
 * downgrades the result, naming EDS in the message. Both daemons are on the same session bus,
 * so this costs one more `new_sync` and no extra failure mode.
 */
export async function check(): Promise<GnomeCheckResult> {
  let objs: Goa.Object[];
  try {
    const client = await getClient();
    objs = client.get_accounts();
  } catch (err) {
    return { name: GNOME_CLIENT_NAME, ok: false, message: unavailableMessage(errorMessage(err)) };
  }

  let edsDetail = '';
  try {
    await getRegistry();
  } catch (err) {
    edsDetail = errorMessage(err);
  }

  if (objs.length === 0) {
    return edsDetail
      ? { name: GNOME_CLIENT_NAME, ok: false, message: unavailableMessage(edsDetail) }
      : { name: GNOME_CLIENT_NAME, ok: true, message: NO_ACCOUNTS_MESSAGE };
  }
  const counts = new Map<string, number>();
  for (const obj of objs) {
    const account = obj.get_account();
    const provider = account?.provider_type ?? 'unknown';
    counts.set(provider, (counts.get(provider) ?? 0) + 1);
  }
  const summary = [...counts.entries()].map(([p, n]) => (n > 1 ? `${p}×${n}` : p)).join(', ');
  if (edsDetail) {
    return {
      name: GNOME_CLIENT_NAME,
      ok: false,
      message: unavailableMessage(`accounts readable, Evolution Data Server not: ${edsDetail}`),
    };
  }
  return { name: GNOME_CLIENT_NAME, ok: true, message: `OK (${objs.length} account(s): ${summary})` };
}
