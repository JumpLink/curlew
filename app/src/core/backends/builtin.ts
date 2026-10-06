/**
 * The backends that ship with curlew. Each is registered exactly like a third-party plugin
 * would be: a manifest and a factory. Nothing constructs a backend except through the registry.
 */

import { ImapBackend, MAIL_MANIFEST } from '@curlew/imap';
import { MATRIX_MANIFEST, MatrixBackend } from '@curlew/matrix';
import { SIGNAL_MANIFEST, SignalBackend } from '@curlew/signal';
import { TELEGRAM_MANIFEST, TelegramBackend } from '@curlew/telegram';
import { WHATSAPP_MANIFEST, WhatsAppBackend } from '@curlew/whatsapp';
import { XMPP_MANIFEST, XmppBackend } from '@curlew/xmpp';
import { BackendRegistry, type BackendPlugin } from './registry.ts';

export const BUILTIN_PLUGINS: readonly BackendPlugin[] = [
  { manifest: MAIL_MANIFEST, create: () => new ImapBackend() },
  { manifest: TELEGRAM_MANIFEST, create: (context) => new TelegramBackend(context) },
  { manifest: WHATSAPP_MANIFEST, create: (context) => new WhatsAppBackend(context) },
  { manifest: XMPP_MANIFEST, create: (context) => new XmppBackend(context) },
  { manifest: MATRIX_MANIFEST, create: (context) => new MatrixBackend(context) },
  { manifest: SIGNAL_MANIFEST, create: (context) => new SignalBackend(context) },
];

export function builtinRegistry(): BackendRegistry {
  return new BackendRegistry(BUILTIN_PLUGINS);
}
