/**
 * `postbote addon-canary` — load the native addon and report its SHAPE. Nothing else.
 *
 * Exists for one caller: `app/tests/integration/bundle-relocation.mjs`, which copies the built
 * bundle out of the tree and asks it to load libsignal from there. It cannot do that with a
 * command that reads mail or lists accounts, so this is the smallest thing in the binary that
 * exercises the same load path and reports what it got.
 *
 * What it does NOT do, deliberately, because the whole probe rests on it:
 *   - no network. `loadSignalLib()` is a dynamic `import()` of the addon and nothing else: no
 *     Signal server is contacted, no socket is opened, no queue is joined.
 *   - no account, no config, no index, no secret store. Not touched, not read, not created.
 *   - no value. The report is `typeof` strings and counts — shapes. A key count and a typeof
 *     cannot carry an identity, a key or a message, so this output is safe to print in CI.
 * It reports SHAPES rather than "did it work" because a bare exit code cannot tell a loaded
 * addon from an empty namespace object, and the four probed constructors are the Rust-backed
 * ones: if the N-API registration had half-failed, they would be missing while the module object
 * still exists.
 *
 * Off unless `POSTBOTE_CLI_ADDON_CANARY=1`, like the MCP gate canary — and like that one, it is
 * inert anyway: it loads a module and prints typeofs. Enabling it can grant no capability.
 * Hidden from `--help` (`describe: false`) so it never shows up as a feature.
 *
 * The path this exercises is the one that used to be the reason a build could not be shipped:
 * `--app gjs` baked the absolute prebuild path into the bundle, so the addon only loaded on the
 * machine and at the path that built it. gjsify#1899 (ADR 0084) bakes a per-platform table of
 * the `.node` files the package ships instead, and resolves the package at load time through the
 * bundle's own URL — so what this now proves is that the bundle carries no path of the machine
 * that built it. It still needs the addon package INSTALLED where it can see it, which is the
 * limit that fix carries and the shape postbote ships in;
 * `app/tests/integration/bundle-relocation.mjs` asserts both halves.
 */

import type { CommandModule } from 'yargs';

import { loadSignalLib } from '@postbote/signal';

import { runtimeName } from '../../core/runtime.ts';
import { runAndExit } from './output.ts';

export interface AddonCanaryReport {
  /** Marker, so a driver can find this line in a stream of GJS warnings. */
  canary: 'addon';
  runtime: string;
  /** `typeof` of each half of the loaded libsignal module. */
  core: string;
  zk: string;
  /** How many names each half carries — an empty object scores 0, a loaded addon scores ~69. */
  coreExports: number;
  zkExports: number;
  /** `typeof` per probed Rust-backed export. */
  bindings: Record<string, string>;
}

export async function loadAddonCanary(): Promise<AddonCanaryReport> {
  const { core, zk } = await loadSignalLib();
  return {
    canary: 'addon',
    runtime: runtimeName(),
    core: typeof core,
    zk: typeof zk,
    coreExports: Object.keys(core).length,
    zkExports: Object.keys(zk).length,
    bindings: {
      // Rust-backed exports, one from each half of the module: if the N-API registration had
      // half-failed these would be missing while the module objects above still existed.
      'core.IdentityKeyPair': typeof core.IdentityKeyPair,
      'core.SealedSenderDecryptionResult': typeof core.SealedSenderDecryptionResult,
      'zk.ClientZkGroupCipher': typeof zk.ClientZkGroupCipher,
      'zk.GroupMasterKey': typeof zk.GroupMasterKey,
    },
  };
}

export const addonCanaryCommand: CommandModule = {
  command: 'addon-canary',
  // `false` hides it from --help; it is a probe, not a feature.
  describe: false,
  handler: () => {
    if (process.env.POSTBOTE_CLI_ADDON_CANARY !== '1') {
      console.error('addon-canary is a test probe — set POSTBOTE_CLI_ADDON_CANARY=1 to run it');
      process.exit(1);
    }
    // One line: a driver picks it out of a stream of GJS typelib warnings without brace-matching.
    runAndExit(loadAddonCanary, { print: (report) => console.log(JSON.stringify(report)) });
  },
};
