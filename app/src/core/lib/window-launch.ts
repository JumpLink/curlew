/**
 * How the daemon starts a window, kept free of GObject so both runtimes test it.
 *
 * A process the daemon spawns stays in the daemon's cgroup, and a systemd unit's stop kills
 * its whole cgroup: restarting `curlew-daemon` closed a window opened from a notification,
 * mid-send. Under systemd the window therefore gets a transient scope of its own, named the
 * way desktops name launched apps, so it outlives the service that started it.
 */

/** Drops the desktop entry's field codes (`%U`, `%f`, ...); a notification click passes no files. */
export function entryArgv(argv: readonly string[]): string[] {
  return argv.filter((arg) => !/^%[a-zA-Z]$/.test(arg));
}

/** The `systemd-run` call that starts `argv` in its own user scope. */
export function scopedArgv(systemdRun: string, appId: string, suffix: string, argv: readonly string[]): string[] {
  return [systemdRun, '--user', '--scope', '--collect', '--quiet', `--unit=app-${appId}-${suffix}.scope`, '--', ...entryArgv(argv)];
}
