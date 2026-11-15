/**
 * `curlew wasm-canary` — load Telegram's WASM crypto module and report whether it ran.
 *
 * The sibling of `addon-canary`: that one proves the shipped libsignal addon loads, this one
 * proves the shipped `@mtcute/wasm` module does. Both are found beside the bundle at run time, so
 * a package that leaves them out builds, installs and starts — and fails only when the user links
 * an account. `app/tests/integration/bundle-relocation.mjs` and a device check run this instead.
 *
 * No network, no account, no config, no index: it hashes one constant byte and prints the digest
 * length. `--handshake` adds `probeHandshake()` — one unauthenticated MTProto exchange, still no
 * account — so a device check covers WebSocket and WebCrypto too before anyone tries a login.
 * Off unless `CURLEW_CLI_ADDON_CANARY=1`, hidden from `--help`.
 */

import type { CommandModule } from 'yargs';

import { probeHandshake, probeWasmCrypto } from '@curlew/telegram';

import { runtimeName } from '../../core/runtime.ts';
import { runAndExit } from './output.ts';

export interface WasmCanaryReport {
  /** Marker, so a driver can find this line in a stream of GJS warnings. */
  canary: 'wasm';
  runtime: string;
  /** SHA-256 digest length from the WASM module: 32 when it loaded. */
  sha256Bytes: number;
  /** With `--handshake`: whether the MTProto exchange completed (DC numbers are not reported). */
  handshake?: boolean;
}

export async function loadWasmCanary(handshake = false): Promise<WasmCanaryReport> {
  const report: WasmCanaryReport = {
    canary: 'wasm',
    runtime: runtimeName(),
    sha256Bytes: await probeWasmCrypto(),
  };
  if (handshake) {
    await probeHandshake();
    report.handshake = true;
  }
  return report;
}

export const wasmCanaryCommand: CommandModule = {
  command: 'wasm-canary',
  // `false` hides it from --help; it is a probe, not a feature.
  describe: false,
  builder: (yargs) => yargs.option('handshake', { type: 'boolean', default: false, hidden: true }),
  handler: (argv) => {
    if (process.env.CURLEW_CLI_ADDON_CANARY !== '1') {
      console.error('wasm-canary is a test probe — set CURLEW_CLI_ADDON_CANARY=1 to run it');
      process.exit(1);
    }
    runAndExit(() => loadWasmCanary(argv.handshake === true), {
      print: (report) => console.log(JSON.stringify(report)),
    });
  },
};
