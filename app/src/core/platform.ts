/**
 * What this platform can offer, decided in one place. Windows and macOS ship chat only: mail,
 * contacts and calendar need GNOME Online Accounts or Evolution Data Server (Linux), and the
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

/**
 * How receiving continues when the window is closed. `systemd` is the user unit `curlew setup`
 * writes; `portal` is the Flatpak Background portal; `while-open` has no background service at
 * all (Windows and macOS ship no systemd or session bus), so the window itself receives while it
 * is open and says so. Views ask this instead of checking the platform name.
 */
export type BackgroundService = 'systemd' | 'portal' | 'while-open';

export function backgroundService(
  platform: PlatformName = currentPlatform(),
  sandboxed = false,
): BackgroundService {
  if (chatOnly(platform)) return 'while-open';
  return sandboxed ? 'portal' : 'systemd';
}
