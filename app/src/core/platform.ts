/**
 * What this platform can offer, decided in one place. Windows and macOS ship chat only in 0.1:
 * mail, contacts and calendar need GNOME Online Accounts or Evolution Data Server (Linux), and the
 * Delta Chat part of mail is not yet checked there. Callers take the platform as an argument so
 * Node and GJS tests can inject it.
 */

export type PlatformName = string;

/** The running platform in Node's naming (`linux`, `darwin`, `win32`). */
export function currentPlatform(): PlatformName {
  return (globalThis as { process?: { platform?: string } }).process?.platform ?? 'linux';
}

/** Windows and macOS offer the chat protocols only. */
export function chatOnly(platform: PlatformName = currentPlatform()): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/** Can the backend `name` run here? Mail is the only one that cannot on a chat-only platform. */
export function backendAvailable(name: string, platform: PlatformName = currentPlatform()): boolean {
  return name !== 'mail' || !chatOnly(platform);
}
