/**
 * The backends that ship with curlew. Each is registered exactly like a third-party plugin
 * would be: a manifest and a factory. Nothing constructs a backend except through the registry.
 */

import { MAIL_MANIFEST, openTlsStream } from '@curlew/imap';
import { ImapSendBackend } from '@curlew/imap/send';
import { MATRIX_MANIFEST, MatrixBackend } from '@curlew/matrix';
import { SIGNAL_MANIFEST, SignalBackend, loadSignalLib } from '@curlew/signal';
import { TELEGRAM_MANIFEST, TelegramBackend } from '@curlew/telegram';
import { WHATSAPP_MANIFEST, WhatsAppBackend } from '@curlew/whatsapp';
import { XMPP_MANIFEST, XmppBackend } from '@curlew/xmpp';
import { backendAvailable, currentPlatform } from '../platform.ts';
import { BackendRegistry, type BackendPlugin } from './registry.ts';

export const BUILTIN_PLUGINS: readonly BackendPlugin[] = [
  { manifest: MAIL_MANIFEST, create: (context) => new ImapSendBackend(openTlsStream, context) },
  { manifest: TELEGRAM_MANIFEST, create: (context) => new TelegramBackend(context) },
  { manifest: WHATSAPP_MANIFEST, create: (context) => new WhatsAppBackend(context) },
  { manifest: XMPP_MANIFEST, create: (context) => new XmppBackend(context) },
  { manifest: MATRIX_MANIFEST, create: (context) => new MatrixBackend(context) },
  {
    manifest: SIGNAL_MANIFEST,
    create: (context) => new SignalBackend(context),
    ready: () => loadSignalLib().then(() => undefined),
  },
];

/** The backends that can run on `platform`; on Windows and macOS that is every chat protocol, not mail. */
export function builtinRegistry(platform = currentPlatform()): BackendRegistry {
  return new BackendRegistry(BUILTIN_PLUGINS.filter((p) => backendAvailable(p.manifest.name, platform)));
}
