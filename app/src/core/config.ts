/**
 * The curlew config file — `$XDG_CONFIG_HOME/curlew/config.json`.
 *
 * It holds decisions only the user can make: which backends are enabled, when their terms were
 * accepted, how a sender is classified when the automatic call was wrong, and which writes are
 * granted (off unless listed). None of it can be
 * rebuilt from a server, so it is kept apart from the index, which can.
 *
 * Parsing is pure (`parseConfig`) so the shape is tested on both runtimes; reading and writing
 * the file is a thin layer on top.
 */

import type { Classification } from '@curlew/protocol';
import { normalizeAddress } from '@curlew/protocol';
import { configPath, ensurePrivateDir } from '@curlew/store';
import { type Grant, type ParseGrantsOptions, parseGrants } from './grants.ts';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface BackendConfig {
  enabled: boolean;
  /** ISO-8601 time the user accepted the backend's terms notice. */
  termsAcceptedAt?: string;
  /**
   * The backend's own NON-SECRET settings, handed to it unvalidated: only the backend knows what
   * they mean. Flat scalars only. Never a credential — this file is backed up as plain `state`;
   * secrets go to the backend's SecretStore (Telegram refuses an api_hash here).
   */
  settings?: Record<string, string | number | boolean>;
}

export interface CurlewConfig {
  backends: Record<string, BackendConfig>;
  /** Per-sender classification overrides, keyed by normalized mail address. */
  senders: Record<string, Classification>;
  /** Write grants (ADR 0004). Absent or empty denies every write. */
  grants: Grant[];
  /**
   * Peers this account must never be sent plain text, keyed like a grant target (ADR 0006 §7).
   *
   * `"<account>/<address>"` for one peer, `"<account>"` for every peer of that account. The only
   * value is `"required"`: the key exists to be extended (a `"preferred"` would be a different
   * policy), not to be a boolean that cannot grow.
   *
   * It closes the one door §7 leaves open — a peer with NO OMEMO devices, where plain text is
   * what they can read. Everything else on the send path already refuses.
   */
  encryption: Record<string, 'required'>;
  /**
   * Top-level keys this build does not know, carried through unchanged so a build that does not
   * know a key cannot drop it on save (ADR 0004).
   */
  unknown: Record<string, unknown>;
}

const KNOWN_KEYS = ['backends', 'senders', 'grants', 'encryption'];

/**
 * What an absent config file means. Mail is enabled by THIS default, not by a special case in
 * the registry: the built-in backend goes through the same "enabled in the config" gate as
 * every other, and a user who disables it in the file gets exactly that.
 */
export function defaultConfig(): CurlewConfig {
  return { backends: { mail: { enabled: true } }, senders: {}, grants: [], encryption: {}, unknown: {} };
}

/** Parse and validate the file's text. Throws with the offending key named. */
export function parseConfig(text: string, options: ParseGrantsOptions = {}): CurlewConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`config is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new Error('config must be a JSON object');
  const obj = raw as Record<string, unknown>;

  const backends: Record<string, BackendConfig> = {};
  const rawBackends = obj.backends ?? {};
  if (typeof rawBackends !== 'object' || rawBackends === null || Array.isArray(rawBackends)) {
    throw new Error('config.backends must be an object');
  }
  for (const [name, value] of Object.entries(rawBackends as Record<string, unknown>)) {
    const entry = value as Record<string, unknown> | null;
    if (typeof entry !== 'object' || entry === null || typeof entry.enabled !== 'boolean') {
      throw new Error(`config.backends.${name}.enabled must be true or false`);
    }
    let settings: Record<string, string | number | boolean> | undefined;
    if (entry.settings !== undefined) {
      if (typeof entry.settings !== 'object' || entry.settings === null || Array.isArray(entry.settings)) {
        throw new Error(`config.backends.${name}.settings must be an object`);
      }
      settings = {};
      for (const [key, v] of Object.entries(entry.settings as Record<string, unknown>)) {
        if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
          throw new Error(`config.backends.${name}.settings.${key} must be a string, number or boolean`);
        }
        settings[key] = v;
      }
    }
    backends[name] = {
      enabled: entry.enabled,
      ...(typeof entry.termsAcceptedAt === 'string' ? { termsAcceptedAt: entry.termsAcceptedAt } : {}),
      ...(settings ? { settings } : {}),
    };
  }

  const senders: Record<string, Classification> = {};
  const rawSenders = obj.senders ?? {};
  if (typeof rawSenders !== 'object' || rawSenders === null || Array.isArray(rawSenders)) {
    throw new Error('config.senders must be an object');
  }
  for (const [address, value] of Object.entries(rawSenders as Record<string, unknown>)) {
    const key = normalizeAddress('email', address);
    if (!key) throw new Error(`config.senders: ${JSON.stringify(address)} is not a mail address`);
    if (value !== 'conversational' && value !== 'automated') {
      throw new Error(`config.senders.${address} must be "conversational" or "automated"`);
    }
    senders[key] = value;
  }

  const grants = parseGrants(obj.grants, options);
  const encryption = parseEncryption(obj.encryption);

  const unknown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!KNOWN_KEYS.includes(key)) unknown[key] = value;
  }

  return { backends, senders, grants, encryption, unknown };
}

/**
 * Validate `config.encryption`. Throws with the offending key named — a misspelled target here
 * would silently mean "plain text is fine for this peer", which is the opposite of what someone
 * writing the key asked for.
 */
function parseEncryption(raw: unknown): Record<string, 'required'> {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new Error('config.encryption must be an object of "<account>[/<address>]": "required"');
  const out: Record<string, 'required'> = {};
  for (const [target, value] of Object.entries(raw as Record<string, unknown>)) {
    if (target.length === 0 || target.trim() !== target)
      throw new Error('config.encryption: a target must not be empty or padded with whitespace');
    if (value !== 'required') throw new Error(`config.encryption.${target} must be "required"`);
    out[target] = value;
  }
  return out;
}

/** Read the config, or the default when there is no file yet. */
export function loadConfig(path = configPath()): CurlewConfig {
  if (!existsSync(path)) return defaultConfig();
  return parseConfig(readFileSync(path, 'utf8'));
}

/**
 * Write the config atomically, mode 0600 in a 0700 directory: the sender overrides are other
 * people's addresses.
 */
export function saveConfig(config: CurlewConfig, path = configPath()): void {
  ensurePrivateDir(dirname(path));
  const part = `${path}.part`;
  const { unknown, grants, encryption, ...known } = config;
  const carried = Object.fromEntries(Object.entries(unknown).filter(([key]) => !KNOWN_KEYS.includes(key)));
  const out = {
    ...carried,
    ...known,
    ...(grants.length > 0 ? { grants } : {}),
    ...(Object.keys(encryption).length > 0 ? { encryption } : {}),
  };
  writeFileSync(part, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  chmodSync(part, 0o600);
  renameSync(part, path);
}
