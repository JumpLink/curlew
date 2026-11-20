/**
 * The desktop's accounts, through `@gjsify/system-accounts` (gjsify ADR 0095).
 *
 * The package uses libgoa where the typelib exists and talks to GNOME Online Accounts over D-Bus
 * otherwise (a Flatpak: org.gnome.Platform ships no Goa typelib, the app holds
 * `--talk-name=org.gnome.OnlineAccounts`). Returns plain DTOs — no secrets: credentials are
 * fetched lazily by the mail layer, never here.
 */

import { GNOME_CLIENT_NAME, GOA_UNAVAILABLE_MESSAGE, NO_ACCOUNTS_MESSAGE } from '@curlew/protocol';
import { errorMessage, GnomeUnavailableError } from '@curlew/protocol';
import type { GnomeAccount, GnomeCheckResult } from '@curlew/protocol';
import type { Account, SystemAccounts } from '@gjsify/system-accounts';
import { existsSync } from 'node:fs';
import { getRegistry } from './eds.gjs.ts';
import { isGnomeFailure } from './errors.ts';
import { holdOptionalGiWarnings } from './optional.ts';

let shared: Promise<SystemAccounts> | undefined;

/**
 * The host's account store. Loaded on first use: the `&optional` GI import inside the package
 * costs a top-level await, which only the code that really asks for accounts should pay.
 */
function hostAccounts(): Promise<SystemAccounts> {
  shared ??= loadHostAccounts();
  shared.catch(() => {
    shared = undefined;
  });
  return shared;
}

/**
 * The package's `&optional` Goa import warns when the typelib is missing, which is the normal
 * state in a Flatpak where the D-Bus driver answers instead. The warning is held until the
 * store has been asked: debug when it answers, a warning only when neither route works.
 */
async function loadHostAccounts(): Promise<SystemAccounts> {
  const { value, release } = await holdOptionalGiWarnings(() =>
    import('@gjsify/system-accounts').then((m) => m.createSystemAccounts()),
  );
  let answered = false;
  try {
    answered = await probe(value);
  } catch {
    // unreachable: the held warning is the honest one
  }
  release(answered);
  return value;
}

/** Whether this process runs in a Flatpak sandbox, where Evolution Data Server is absent by design. */
export function inSandbox(): boolean {
  return existsSync('/.flatpak-info') || Boolean(process.env.FLATPAK_ID);
}

/**
 * Whether the store really answers. `capabilities()` only says what the driver could serve, and
 * `listAccounts()` answers an empty list for an unreachable bus as for an empty store, so the
 * one honest probe is a question about an account that cannot exist: `no-account-store` means
 * the daemon is out of reach, `unknown-account` means it answered.
 */
async function probe(accounts: SystemAccounts): Promise<boolean> {
  if (accounts.capabilities().services.length === 0) return false;
  const answer = await accounts.getMailSettings({
    id: 'curlew-probe',
    provider: '',
    providerName: '',
    identity: '',
    label: '',
    services: [],
  });
  return !('reason' in answer) || answer.reason !== 'no-account-store';
}

/** Whether an account store can be asked at all (GOA reachable, by libgoa or over D-Bus). */
export async function accountStoreAvailable(): Promise<boolean> {
  try {
    return await probe(await hostAccounts());
  } catch {
    return false;
  }
}

function mapAccount(account: Account): GnomeAccount {
  return {
    id: account.id,
    provider: account.provider,
    providerName: account.providerName,
    identity: account.identity,
    presentation: account.label,
    capabilities: {
      mail: account.services.includes('mail'),
      calendar: account.services.includes('calendar'),
      contacts: account.services.includes('contacts'),
      files: account.services.includes('files'),
    },
  };
}

/** The store, or the error callers already branch on when there is none. */
async function reachableStore(): Promise<SystemAccounts> {
  let accounts: SystemAccounts;
  try {
    accounts = await hostAccounts();
  } catch (err) {
    throw new GnomeUnavailableError(`account store not available: ${errorMessage(err)}`);
  }
  if (!(await probe(accounts))) {
    throw new GnomeUnavailableError('no account store on this host (GNOME Online Accounts not reachable)');
  }
  return accounts;
}

/** List all configured GNOME Online Accounts as plain DTOs. */
export async function listAccounts(): Promise<GnomeAccount[]> {
  const accounts = await reachableStore();
  return (await accounts.listAccounts()).map(mapAccount);
}

/**
 * The unavailable answer leads with curlew's own sentence and appends the cause.
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
 * locale string — while `curlew check` on the very same host reported the stable sentence.
 *
 * The sentence always leads, for a `GnomeError` too: its message names the CALL that failed
 * ("Goa.Client.new: …"), not the condition, and the locale tail under it is what the reader
 * cannot act on. A missing typelib (`GnomeUnavailableError`) already names itself in
 * curlew's wording and is not routed here by the MCP layer, because @curlew/imap raises the
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
 * It probes BOTH bindings, not just GOA: `curlew check` is the one command whose job is to
 * say what works, and a GOA-only probe reports ok:true on a host with GOA but no EDS — then
 * `curlew contacts` and `curlew calendar` fail on the next command, which is the one
 * answer a reader cannot act on. So the EDS source registry is resolved too; a failure there
 * downgrades the result, naming EDS in the message. Both daemons are on the same session bus,
 * so this costs one more `new_sync` and no extra failure mode.
 */
export async function check(): Promise<GnomeCheckResult> {
  let list: GnomeAccount[];
  try {
    list = await listAccounts();
  } catch (err) {
    return { name: GNOME_CLIENT_NAME, ok: false, message: unavailableMessage(errorMessage(err)) };
  }

  let edsDetail = '';
  try {
    await getRegistry();
  } catch (err) {
    edsDetail = errorMessage(err);
  }

  if (edsDetail && inSandbox() && (await accountStoreAvailable())) {
    const n = list.length;
    return {
      name: GNOME_CLIENT_NAME,
      ok: true,
      message: `OK (${n} account(s) via GNOME Online Accounts; Evolution Data Server is not available in this build)`,
    };
  }

  if (list.length === 0) {
    return edsDetail
      ? { name: GNOME_CLIENT_NAME, ok: false, message: unavailableMessage(edsDetail) }
      : { name: GNOME_CLIENT_NAME, ok: true, message: NO_ACCOUNTS_MESSAGE };
  }
  const counts = new Map<string, number>();
  for (const account of list) counts.set(account.provider || 'unknown', (counts.get(account.provider || 'unknown') ?? 0) + 1);
  const summary = [...counts.entries()].map(([p, n]) => (n > 1 ? `${p}×${n}` : p)).join(', ');
  if (edsDetail) {
    return {
      name: GNOME_CLIENT_NAME,
      ok: false,
      message: unavailableMessage(`accounts readable, Evolution Data Server not: ${edsDetail}`),
    };
  }
  return { name: GNOME_CLIENT_NAME, ok: true, message: `OK (${list.length} account(s): ${summary})` };
}
