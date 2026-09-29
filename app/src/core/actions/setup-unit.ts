/**
 * The receiving daemon's systemd USER unit, as text this process carries.
 *
 * WHY a constant and not the file: a built postbote is a single-file GJS bundle, so at run time
 * it cannot read `contrib/systemd/postbote-daemon.service` off disk, and building on gjsify's
 * static-read inlining is not an option (that is on gjsify `main`, not in the pinned
 * `@gjsify/cli` 0.49.0). The unit therefore lives here, with this machine's real paths filled in
 * — and `setup-unit.test.ts` fails the moment this text and the shipped file disagree, so it
 * cannot quietly become a second copy of the unit.
 *
 * The shipped file keeps its `%h/postbote` placeholders for packagers: fed the same placeholders,
 * this template must reproduce its directives exactly. That is the whole test.
 */

import { dirname, join } from 'node:path';

/** The unit's name — one string, so the file, the `systemctl` calls and the report agree. */
export const UNIT_NAME = 'postbote-daemon.service';

/** Where the shipped copy lives, relative to the repo root. Named in the file it writes. */
export const SHIPPED_UNIT_REL = 'contrib/systemd/postbote-daemon.service';

export interface UnitPaths {
  /** The home directory, or `%h` — systemd expands that itself inside a user unit. */
  home: string;
  /**
   * What the daemon's working directory is. A checkout runs out of its own tree, because the
   * native addon's absolute prebuild path is baked in at build time and a copied tree starts and
   * then dies (AGENTS.md); a published install has no tree and runs out of `$HOME`.
   */
  workdir: string;
  /**
   * What `ExecStart` invokes. A checkout runs the built bundle through gjsify, because the native
   * addon's absolute prebuild path is baked in at build time (see AGENTS.md); a published install
   * has no bundle and just runs the command.
   */
  runner: string;
  /** The arguments for the runner: `run <bundle> daemon` in a checkout, `daemon` published. */
  args: string;
}

/** The PATH a user unit gets. systemd reports "Command gjsify is not executable" without it. */
export function unitPath(runner: string, home: string): string {
  // A runner named by absolute path brings its own directory; a bare name needs the one
  // `gjsify install` puts it in, which is the shell profile's and not the unit's.
  const first = runner.startsWith('/') ? dirname(runner) : `${home}/.local/bin`;
  return `${first}:/usr/local/bin:/usr/bin:/bin`;
}

/**
 * The unit text. Comments are the shipped file's own, except the first two lines, which say that
 * `postbote setup` wrote this copy and what to verify — a person reading the installed file has
 * to know the paths in it are theirs and that a check exists.
 */
export const UNIT_TEMPLATE = `# Written by \`postbote setup\`. The paths below are this machine's.
# ${SHIPPED_UNIT_REL} is the same unit, written for a checkout at ~/postbote.
# Verify: systemd-analyze --user verify <this file>
[Unit]
# No After=/PartOf=graphical-session.target on purpose: logging out must not stop a receiver
# whose whole point is staying connected, and the address book it uses for the participant link
# is optional (a daemon without it still receives; the link comes on the next rebuild).
# \`loginctl enable-linger\` is what lets a user unit run at all without a session.
# StartLimit* belong to [Unit], not [Service] (systemd ignores them there) — a restart storm,
# say a config that no longer names a backend, must not fill the disk.
Description=postbote — receive Signal and WhatsApp into the local index
Documentation=https://github.com/jumplink/postbote/blob/main/docs/adr/0002-receiving-daemon.md
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory={{HOME}}
Environment=PATH={{PATH}}
ExecStart=/usr/bin/env {{RUNNER}} {{ARGS}}
# A dropped socket is retried by the daemon itself (with backoff). A restart here is for
# what it cannot retry: an index that cannot be opened, a backend that will not load.
Restart=on-failure
# Exit 2 is "every account is logged out and nothing is receiving" (see daemonExitCode). A
# restart cannot relink a device — it would only hammer the network — so the unit is left
# FAILED and visible instead: \`systemctl --user status postbote-daemon\`, then
# \`postbote accounts add whatsapp|signal\`.
RestartPreventExitStatus=2
RestartSec=30
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`;

/** Render the unit for one machine. */
export function renderUnit(paths: UnitPaths): string {
  return UNIT_TEMPLATE.replace('{{HOME}}', paths.workdir)
    .replace('{{PATH}}', unitPath(paths.runner, paths.home))
    .replace('{{RUNNER}}', paths.runner)
    .replace('{{ARGS}}', paths.args);
}

/**
 * The lines that systemd reads, in order: no comment, no blank line. The comparison that keeps
 * this template and the shipped file honest is made on these and nothing else, so a comment
 * rewording is not a divergence and a changed directive is.
 */
export function unitDirectives(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** The unit paths for a run: a checkout runs its own bundle, a published install the command. */
export function unitPathsFor(input: {
  mode: 'checkout' | 'published';
  home: string;
  /** Absolute path of the checkout, or null for a published install. */
  checkout: string | null;
  /** Absolute path of `gjsify`, or null in a published install. */
  gjsify: string | null;
  /** Absolute path of the bundle this process is running from, or null. */
  bundle: string | null;
}): UnitPaths {
  if (input.mode === 'published' || input.gjsify === null || input.bundle === null) {
    // No tree and no baked addon path: run the installed command out of $HOME, where the global
    // bin lives. `gjsify run <bundle>` is the checkout's spelling and does not exist here.
    return { home: input.home, workdir: input.home, runner: 'postbote', args: 'daemon' };
  }
  return {
    home: input.home,
    workdir: input.checkout ?? input.home,
    runner: input.gjsify,
    args: `run ${input.bundle} daemon`,
  };
}

/** The file the unit goes to, under the XDG config home. */
export function unitFilePath(unitDir: string): string {
  return join(unitDir, UNIT_NAME);
}
