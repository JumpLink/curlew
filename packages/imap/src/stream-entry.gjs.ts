/**
 * Narrow GJS entry for @curlew/imap/stream: the Gio opener and the pure client, nothing else.
 *
 * The main entry reaches `@curlew/store` (node:sqlite) and `@gjsify/system-accounts`, which the
 * Android shell cannot resolve yet. A shell that only needs to reach a mailbox imports this.
 */

export { openEndpointStream, openTlsStream } from './transport.gjs.ts';
export { ImapClient } from './client.ts';
