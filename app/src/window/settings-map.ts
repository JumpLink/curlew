/**
 * Where every config key can be changed in the window. The tables are typed by the config's own
 * keys, so a new key without an entry fails `check`, and the unit test holds them against
 * `parseConfig`. A key with no place in the window must say why: file only, or state the app keeps.
 */

import type { CurlewConfig, UiConfig } from '../core/config.ts';

export type SettingPlace =
  | { kind: 'window'; where: string }
  | { kind: 'state'; why: string }
  | { kind: 'file'; why: string };

export const UI_SETTINGS: Record<keyof UiConfig, SettingPlace> = {
  showAllEmails: { kind: 'window', where: 'Preferences, Conversations' },
  notifications: { kind: 'window', where: 'Preferences, Notifications' },
  playVideosSilently: { kind: 'window', where: 'Preferences, Media' },
  sendReadReceipts: { kind: 'window', where: 'Preferences, Conversations' },
  accentColor: { kind: 'window', where: 'Preferences, Appearance' },
  primaryColor: { kind: 'window', where: 'Preferences, Appearance' },
  colorScheme: { kind: 'window', where: 'Preferences, Appearance' },
  chatBackground: { kind: 'window', where: 'Preferences, Appearance' },
  welcomeDone: { kind: 'state', why: 'set when the welcome screen is finished or skipped' },
  ai: { kind: 'window', where: 'Preferences, AI' },
  emailChatHintSeen: { kind: 'state', why: 'set when the email-chat hint is dismissed' },
  searchScope: { kind: 'window', where: 'Conversation list, search scope' },
};

export const CONFIG_SETTINGS: Record<keyof CurlewConfig, SettingPlace> = {
  backends: { kind: 'window', where: 'Accounts, Protocols (switch and terms)' },
  ui: { kind: 'window', where: 'see UI_SETTINGS' },
  senders: { kind: 'file', why: 'sender classification is corrected with `curlew conversations classify`' },
  grants: { kind: 'window', where: 'Agent access (migrated rules)' },
  agentAccess: { kind: 'window', where: 'Agent access, only while AI features are on' },
  encryption: { kind: 'window', where: 'Account page, XMPP: Require encryption' },
  disabledAccounts: { kind: 'window', where: 'Account page: Use this account' },
  deltaChatAccounts: { kind: 'window', where: 'Account page, mail: Use for Delta Chat' },
  mergedPeople: { kind: 'window', where: 'Contact page and merge assistant' },
  declinedMerges: { kind: 'window', where: 'Merge assistant (Skip)' },
  pins: { kind: 'window', where: 'Conversation header, protocol picker' },
  contactChoices: { kind: 'window', where: 'Contact page' },
  unknown: { kind: 'state', why: 'keys of newer builds, carried through unchanged' },
};

/** Per-backend `backends.<name>.settings` are the backend's own and have no window row. */
export const BACKEND_SETTINGS_PLACE: SettingPlace = {
  kind: 'file',
  why: 'backend-specific non-secret options are edited in config.json',
};
