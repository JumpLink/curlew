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
import {
  ACCENT_CHOICES,
  type AccentName,
  BACKGROUND_CHOICES,
  type BackgroundChoice,
  COLOR_SCHEMES,
  isAccentChoice,
  isAccentName,
  isBackgroundChoice,
  isColorScheme,
} from './lib/appearance.ts';
import { isSearchScope, SEARCH_SCOPES, type SearchScope } from './lib/search-scope.ts';
import { type AgentAccessPolicy, defaultAgentAccess, parseAgentAccess } from './agent-access.ts';
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

export interface UiConfig {
  /** Show ordinary mail threads beside messages carrying `Chat-Version: 1.0`. Unset: off, the list is a messenger. */
  showAllEmails: boolean;
  /** What a desktop notification for a new chat message shows: its text, only who wrote, or nothing. */
  notifications: 'preview' | 'sender' | 'off';
  /** A single video in a chat plays muted and looped while on screen. Unset: on, unless the system asks for fewer animations. */
  playVideosSilently?: boolean;
  /** `default` (Curlew's teal), `system` (follow the desktop) or an Adwaita accent name. Unset: `default`. */
  accentColor?: string;
  /** The tint of the window surfaces: `default` (blue), `system` (no tint) or an Adwaita colour name. Unset: `default`. */
  primaryColor?: string;
  /** `system`, `light` or `dark`. Unset: `system`. */
  colorScheme?: string;
  /** `doodles` or `none`. Unset: `doodles`. */
  chatBackground?: string;
  /** Confirm to a Delta Chat peer that a message was read, when it asked for that. Unset: off. */
  sendReadReceipts?: boolean;
  /** The first-run welcome screen was finished or skipped. Unset: not yet, so it may show. */
  welcomeDone?: boolean;
  /**
   * The AI/agent switch: `false` serves no MCP tools and answers every agent policy query with
   * `deny`; `true` is the policy as configured. Unset: off, unless the file already configures
   * agent access (see `aiEnabled`).
   */
  ai?: boolean;
  /** Mail accounts whose "this is an email chat" hint was dismissed; the hint shows once per account. */
  emailChatHintSeen?: string[];
  /** What the conversation search looks at: `all`, `names` (names and numbers) or `messages`. Unset: `all`. */
  searchScope?: SearchScope;
}

export interface CurlewConfig {
  backends: Record<string, BackendConfig>;
  ui: UiConfig;
  /** Per-sender classification overrides, keyed by normalized mail address. */
  senders: Record<string, Classification>;
  /** Write grants (ADR 0004). Absent or empty denies every write. */
  grants: Grant[];
  /**
   * Agent access per account and contact (ADR 0009), with the old `<backend>.send` grants folded
   * in as migrated rules. Parsed and exposed; nothing enforces it yet. Saving writes only the
   * rules the person wrote, never a migrated one.
   */
  agentAccess: AgentAccessPolicy;
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
   * Accounts the person switched off, as `"<backend>/<accountId>"`. They stay linked and keep
   * their messages, but nothing syncs or sends from them. Set from the Accounts page.
   */
  disabledAccounts: string[];
  /**
   * Per mail account, by account id: `deltaChat` opts the account into Delta Chat (only its sent
   * mail carries the `Chat-Version` marker, default off); `plainMail: false` shows only the
   * threads Delta Chat can talk (email chats) of that account and beats `ui.showAllEmails`
   * (default on). Only non-default values are stored; absent means ordinary mail everywhere. The
   * older `deltaChatAccounts` list is still read and folded in here.
   */
  mailAccounts?: Record<string, MailAccountOptions>;
  /**
   * People the person merged into one by hand: each group lists directory participant ids.
   * Presentation only and local — the address book is never written, no message is rewritten.
   */
  mergedPeople: string[][];
  /**
   * Sets of people the merge assistant offered and the person skipped, as participant ids. A set
   * is not offered again until someone joins it.
   */
  declinedMerges: string[][];
  /**
   * People the person pinned to one protocol: participant id to backend. A pin routes the
   * conversation list and binds agents too, so a message to that person never leaves through
   * another network. Local, like a merge.
   */
  pins: Record<string, string>;
  /**
   * What the person chose for how a contact looks, keyed by the smallest participant id of the
   * contact's person set, or `group:<conversation id>` for a group. Presentation only and local, like a merge: the address book is not
   * written. See `choiceFor` for how a choice survives a later merge.
   */
  contactChoices: Record<string, ContactChoice>;
  /**
   * Top-level keys this build does not know, carried through unchanged so a build that does not
   * know a key cannot drop it on save (ADR 0004).
   */
  unknown: Record<string, unknown>;
}

/**
 * How one contact is shown. `name` and `picture` name one part of a merged contact by its
 * conversation id; `own` is the file name of a picture the person set, kept in the store's
 * contact-pictures directory. An own picture beats a chosen part, which beats the default.
 * `primary`, `accent` and `background` give this one chat its own look (ADR 0013).
 */
export interface ContactChoice {
  /** A name typed by the person; a group has no parts to pick one from. */
  title?: string;
  name?: string;
  picture?: string;
  own?: string;
  primary?: AccentName;
  accent?: AccentName;
  background?: BackgroundChoice;
}

/** What the person chose for one mail account; see `CurlewConfig.mailAccounts`. */
export interface MailAccountOptions {
  deltaChat?: boolean;
  plainMail?: boolean;
}

const KNOWN_KEYS = [
  'backends',
  'ui',
  'senders',
  'grants',
  'agentAccess',
  'encryption',
  'disabledAccounts',
  'deltaChatAccounts',
  'mailAccounts',
  'mergedPeople',
  'declinedMerges',
  'pins',
  'contactChoices',
];

/**
 * What an absent config file means. Mail is enabled by THIS default, not by a special case in
 * the registry: the built-in backend goes through the same "enabled in the config" gate as
 * every other, and a user who disables it in the file gets exactly that.
 */
export function defaultConfig(): CurlewConfig {
  return {
    backends: { mail: { enabled: true } },
    ui: { showAllEmails: false, notifications: 'preview' },
    senders: {},
    grants: [],
    agentAccess: defaultAgentAccess(),
    encryption: {},
    disabledAccounts: [],
    mergedPeople: [],
    declinedMerges: [],
    pins: {},
    contactChoices: {},
    unknown: {},
  };
}

/**
 * Is AI/agent access on? An explicit `ui.ai` wins. Unset means off for a fresh config, but ON for
 * a file that already configures agents (grants, agentAccess rules or switches): such a person set
 * agent access up before the switch existed, and turning it off silently would break that.
 */
export function aiEnabled(config: Pick<CurlewConfig, 'ui' | 'grants' | 'agentAccess'>): boolean {
  if (config.ui.ai !== undefined) return config.ui.ai;
  const policy = config.agentAccess;
  return (
    config.grants.length > 0 ||
    policy.rules.length > 0 ||
    !policy.askWithoutRule ||
    policy.sendFilesUnasked === true
  );
}

/** Set one option of a mail account in memory; the default value is stored as absence. */
function setMailOption(
  config: CurlewConfig,
  accountId: string,
  key: keyof MailAccountOptions,
  value: boolean,
): void {
  const { [accountId]: current, ...others } = config.mailAccounts ?? {};
  const next: MailAccountOptions = { ...current };
  if (value === (key === 'plainMail')) delete next[key];
  else next[key] = value;
  config.mailAccounts = Object.keys(next).length > 0 ? { ...others, [accountId]: next } : others;
}

/**
 * Opt a mail account into Delta Chat or out again, in memory. Out also brings its ordinary email
 * back: an account that lists only email chats must be able to send them.
 */
export function setDeltaChatIn(config: CurlewConfig, accountId: string, on: boolean): void {
  setMailOption(config, accountId, 'deltaChat', on);
  if (!on) setMailOption(config, accountId, 'plainMail', true);
}

/**
 * Show a mail account's ordinary email or only its email chats, in memory. Only email chats
 * means the account sends them, so that opts it into Delta Chat too.
 */
export function setPlainMailIn(config: CurlewConfig, accountId: string, on: boolean): void {
  setMailOption(config, accountId, 'plainMail', on);
  if (!on) setMailOption(config, accountId, 'deltaChat', true);
}

/** Ids of the mail accounts opted into Delta Chat. */
export function deltaChatAccountIds(config: Pick<CurlewConfig, 'mailAccounts'>): string[] {
  return Object.entries(config.mailAccounts ?? {})
    .filter(([, options]) => options.deltaChat === true)
    .map(([id]) => id);
}

/** Does this mail account show ordinary email? On unless `plainMail` is false. */
export function plainMailOn(config: Pick<CurlewConfig, 'mailAccounts'>, accountId: string): boolean {
  return config.mailAccounts?.[accountId]?.plainMail !== false;
}

/** The policy agents are held to: the configured one, or one that denies everything when AI is off. */
export function effectiveAgentAccess(
  config: Pick<CurlewConfig, 'ui' | 'grants' | 'agentAccess'>,
): AgentAccessPolicy {
  return aiEnabled(config) ? config.agentAccess : { ...config.agentAccess, off: true };
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

  const rawUi = obj.ui ?? {};
  if (typeof rawUi !== 'object' || rawUi === null || Array.isArray(rawUi)) {
    throw new Error('config.ui must be an object');
  }
  const showAllEmails = (rawUi as Record<string, unknown>).showAllEmails ?? false;
  if (typeof showAllEmails !== 'boolean') throw new Error('config.ui.showAllEmails must be true or false');
  const notifications = (rawUi as Record<string, unknown>).notifications ?? 'preview';
  if (notifications !== 'preview' && notifications !== 'sender' && notifications !== 'off')
    throw new Error('config.ui.notifications must be "preview", "sender" or "off"');
  const sendReadReceipts = (rawUi as Record<string, unknown>).sendReadReceipts;
  if (sendReadReceipts !== undefined && typeof sendReadReceipts !== 'boolean')
    throw new Error('config.ui.sendReadReceipts must be true or false');
  const playVideosSilently = (rawUi as Record<string, unknown>).playVideosSilently;
  if (playVideosSilently !== undefined && typeof playVideosSilently !== 'boolean')
    throw new Error('config.ui.playVideosSilently must be true or false');
  const accentColor = (rawUi as Record<string, unknown>).accentColor;
  if (accentColor !== undefined && (typeof accentColor !== 'string' || !isAccentChoice(accentColor)))
    throw new Error(`config.ui.accentColor must be one of ${ACCENT_CHOICES.join(', ')}`);
  const primaryColor = (rawUi as Record<string, unknown>).primaryColor;
  if (primaryColor !== undefined && (typeof primaryColor !== 'string' || !isAccentChoice(primaryColor)))
    throw new Error(`config.ui.primaryColor must be one of ${ACCENT_CHOICES.join(', ')}`);
  const colorScheme = (rawUi as Record<string, unknown>).colorScheme;
  if (colorScheme !== undefined && (typeof colorScheme !== 'string' || !isColorScheme(colorScheme)))
    throw new Error(`config.ui.colorScheme must be one of ${COLOR_SCHEMES.join(', ')}`);
  const chatBackground = (rawUi as Record<string, unknown>).chatBackground;
  if (
    chatBackground !== undefined &&
    (typeof chatBackground !== 'string' || !isBackgroundChoice(chatBackground))
  )
    throw new Error(`config.ui.chatBackground must be one of ${BACKGROUND_CHOICES.join(', ')}`);
  const welcomeDone = (rawUi as Record<string, unknown>).welcomeDone;
  if (welcomeDone !== undefined && typeof welcomeDone !== 'boolean')
    throw new Error('config.ui.welcomeDone must be true or false');
  const ai = (rawUi as Record<string, unknown>).ai;
  if (ai !== undefined && typeof ai !== 'boolean') throw new Error('config.ui.ai must be true or false');
  const seenRaw = (rawUi as Record<string, unknown>).emailChatHintSeen;
  if (seenRaw !== undefined && (!Array.isArray(seenRaw) || seenRaw.some((id) => typeof id !== 'string')))
    throw new Error('config.ui.emailChatHintSeen must be a list of mail account ids');
  const emailChatHintSeen = seenRaw as string[] | undefined;
  const searchScope = (rawUi as Record<string, unknown>).searchScope;
  if (searchScope !== undefined && !isSearchScope(searchScope))
    throw new Error(`config.ui.searchScope must be one of ${SEARCH_SCOPES.join(', ')}`);
  const ui: UiConfig = {
    showAllEmails,
    ...(ai === undefined ? {} : { ai }),
    notifications,
    ...(playVideosSilently === undefined ? {} : { playVideosSilently }),
    ...(sendReadReceipts === undefined ? {} : { sendReadReceipts }),
    ...(accentColor === undefined ? {} : { accentColor }),
    ...(primaryColor === undefined ? {} : { primaryColor }),
    ...(colorScheme === undefined ? {} : { colorScheme }),
    ...(chatBackground === undefined ? {} : { chatBackground }),
    ...(welcomeDone === undefined ? {} : { welcomeDone }),
    ...(emailChatHintSeen === undefined || emailChatHintSeen.length === 0 ? {} : { emailChatHintSeen }),
    ...(searchScope === undefined ? {} : { searchScope }),
  };

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
  const access = parseAgentAccess(obj.agentAccess, grants);
  if (!access.ok) throw new Error(access.errors.join('; '));
  const agentAccess = access.policy;
  const encryption = parseEncryption(obj.encryption);
  const disabledAccounts = parseDisabledAccounts(obj.disabledAccounts);
  const mailAccounts = parseMailAccounts(obj.mailAccounts, parseDeltaChatAccounts(obj.deltaChatAccounts));
  const mergedPeople = parseIdGroups(obj.mergedPeople, 'mergedPeople');
  const declinedMerges = parseIdGroups(obj.declinedMerges, 'declinedMerges');
  const pins = parsePins(obj.pins);
  const contactChoices = parseContactChoices(obj.contactChoices);

  const unknown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!KNOWN_KEYS.includes(key)) unknown[key] = value;
  }

  return {
    backends,
    ui,
    senders,
    grants,
    agentAccess,
    encryption,
    disabledAccounts,
    ...(Object.keys(mailAccounts).length > 0 ? { mailAccounts } : {}),
    mergedPeople,
    declinedMerges,
    pins,
    contactChoices,
    unknown,
  };
}

function parseDeltaChatAccounts(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string' || v === ''))
    throw new Error('config.deltaChatAccounts must be a list of mail account ids');
  return [...new Set(raw as string[])];
}

function parseMailAccounts(
  raw: unknown,
  legacyDeltaChat: readonly string[],
): Record<string, MailAccountOptions> {
  const bad = () =>
    new Error('config.mailAccounts must map mail account ids to {deltaChat?, plainMail?} booleans');
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) throw bad();
  const out: Record<string, MailAccountOptions> = {};
  const entries = Object.entries((raw ?? {}) as Record<string, unknown>);
  for (const [id, value] of entries) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw bad();
    const { deltaChat, plainMail } = value as Record<string, unknown>;
    if (
      (deltaChat !== undefined && typeof deltaChat !== 'boolean') ||
      (plainMail !== undefined && typeof plainMail !== 'boolean')
    )
      throw bad();
    // Lists only email chats, so it must send them: `plainMail: false` implies `deltaChat`.
    const options: MailAccountOptions = {
      ...(deltaChat === true || plainMail === false ? { deltaChat: true } : {}),
      ...(plainMail === false ? { plainMail } : {}),
    };
    if (Object.keys(options).length > 0) out[id] = options;
  }
  // The old list: an account it names is opted into Delta Chat, unless mailAccounts says otherwise.
  for (const id of legacyDeltaChat) {
    if (typeof (raw as Record<string, { deltaChat?: boolean }> | undefined)?.[id]?.deltaChat === 'boolean')
      continue;
    out[id] = { ...out[id], deltaChat: true };
  }
  return out;
}

function parseContactChoices(raw: unknown): Record<string, ContactChoice> {
  if (raw === undefined) return {};
  const bad = () =>
    new Error(
      'config.contactChoices must map participant ids (or group:<conversation id>) to {title?, name?, picture?, own?, primary?, accent?, background?} choices',
    );
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw bad();
  const out: Record<string, ContactChoice> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (id === '' || typeof value !== 'object' || value === null || Array.isArray(value)) throw bad();
    const { title, name, picture, own, primary, accent, background } = value as Record<string, unknown>;
    for (const part of [title, name, picture, own, primary, accent, background]) {
      if (part !== undefined && (typeof part !== 'string' || part === '')) throw bad();
    }
    if (typeof own === 'string' && /[/\\]/.test(own)) throw bad();
    for (const colour of [primary, accent]) {
      if (colour !== undefined && !isAccentName(colour as string)) throw bad();
    }
    if (background !== undefined && !isBackgroundChoice(background as string)) {
      throw bad();
    }
    const choice: ContactChoice = {
      ...(title !== undefined ? { title: title as string } : {}),
      ...(name !== undefined ? { name: name as string } : {}),
      ...(picture !== undefined ? { picture: picture as string } : {}),
      ...(own !== undefined ? { own: own as string } : {}),
      ...(primary !== undefined ? { primary: primary as AccentName } : {}),
      ...(accent !== undefined ? { accent: accent as AccentName } : {}),
      ...(background !== undefined ? { background: background as BackgroundChoice } : {}),
    };
    if (Object.keys(choice).length > 0) out[id] = choice;
  }
  return out;
}

function parsePins(raw: unknown): Record<string, string> {
  if (raw === undefined) return {};
  const bad = () => new Error('config.pins must map participant ids to a backend name');
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw bad();
  const out: Record<string, string> = {};
  for (const [id, backend] of Object.entries(raw as Record<string, unknown>)) {
    if (id === '' || typeof backend !== 'string' || backend === '') throw bad();
    out[id] = backend;
  }
  return out;
}

function parseIdGroups(raw: unknown, key: string): string[][] {
  if (raw === undefined) return [];
  const bad = () => new Error(`config.${key} must be a list of lists of participant ids`);
  if (!Array.isArray(raw)) throw bad();
  return raw.map((group) => {
    if (!Array.isArray(group) || group.some((id) => typeof id !== 'string' || id === '')) throw bad();
    return [...new Set(group as string[])];
  });
}

function parseDisabledAccounts(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(v)))
    throw new Error('config.disabledAccounts must be a list of "<backend>/<accountId>"');
  return [...new Set(raw as string[])];
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
  const {
    unknown,
    grants,
    agentAccess,
    encryption,
    disabledAccounts,
    mailAccounts,
    mergedPeople,
    declinedMerges,
    pins,
    contactChoices,
    ...known
  } = config;
  const writtenRules = agentAccess.rules.filter((rule) => !rule.migrated);
  const carried = Object.fromEntries(Object.entries(unknown).filter(([key]) => !KNOWN_KEYS.includes(key)));
  const out = {
    ...carried,
    ...known,
    ...(grants.length > 0 ? { grants } : {}),
    ...(writtenRules.length > 0 || !agentAccess.askWithoutRule || agentAccess.sendFilesUnasked
      ? {
          agentAccess: {
            askWithoutRule: agentAccess.askWithoutRule,
            ...(agentAccess.sendFilesUnasked ? { sendFilesUnasked: true } : {}),
            rules: writtenRules,
          },
        }
      : {}),
    ...(Object.keys(encryption).length > 0 ? { encryption } : {}),
    ...(disabledAccounts.length > 0 ? { disabledAccounts } : {}),
    ...(mailAccounts && Object.keys(mailAccounts).length > 0 ? { mailAccounts } : {}),
    ...(mergedPeople.length > 0 ? { mergedPeople } : {}),
    ...(declinedMerges.length > 0 ? { declinedMerges } : {}),
    ...(Object.keys(pins).length > 0 ? { pins } : {}),
    ...(Object.keys(contactChoices).length > 0 ? { contactChoices } : {}),
  };
  writeFileSync(part, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  chmodSync(part, 0o600);
  renameSync(part, path);
}
