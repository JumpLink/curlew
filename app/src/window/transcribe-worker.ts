/** Runs `curlew transcribe` as a child process and reads its JSON lines, so no decode touches the main loop. */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import system from 'system';

import {
  decideOffer,
  languageOf,
  type Offer,
  type TranscribeStatus,
  type TranscriptResult,
} from './transcribe-model.ts';

/** The worker is this very build's CLI bundle next to the window's, else the launcher on the path. */
function command(args: readonly string[]): string[] {
  const gjs = GLib.find_program_in_path('gjs');
  const bundle = system.programPath ? join(dirname(system.programPath), 'curlew.gjs.mjs') : null;
  if (gjs && bundle && existsSync(bundle)) return [gjs, '-m', bundle, 'transcribe', ...args];
  const launcher = GLib.find_program_in_path('curlew');
  if (launcher) return [launcher, 'transcribe', ...args];
  throw new Error('curlew is not on the path');
}

const environment = (): Record<string, string | undefined> =>
  Object.fromEntries(GLib.listenv().map((key) => [key, GLib.getenv(key) ?? undefined]));

/** Spawns the worker and hands every stdout line to `onLine`; aborting kills it. */
function run(
  args: readonly string[],
  onLine: (value: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let process: Gio.Subprocess;
    try {
      process = Gio.Subprocess.new(
        command([...args, '--lang', languageOf(environment())]),
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
      );
    } catch (err) {
      reject(err);
      return;
    }
    const kill = (): void => process.force_exit();
    signal?.addEventListener('abort', kill, { once: true });
    const input = new Gio.DataInputStream({ baseStream: process.get_stdout_pipe()! });
    let failed: string | null = null;
    const next = (): void => {
      input.read_line_async(GLib.PRIORITY_DEFAULT, null, (_source, res) => {
        let line: Uint8Array | null;
        try {
          [line] = input.read_line_finish(res);
        } catch (err) {
          reject(err);
          return;
        }
        if (line === null) {
          process.wait_async(null, () => {
            signal?.removeEventListener('abort', kill);
            if (signal?.aborted) reject(new Error('aborted'));
            else if (failed !== null) reject(new Error(failed));
            else if (!process.get_successful()) reject(new Error('The speech worker stopped'));
            else resolve();
          });
          return;
        }
        try {
          const value = JSON.parse(new TextDecoder().decode(line)) as Record<string, unknown>;
          if (typeof value.error === 'string') failed = value.error;
          else onLine(value);
        } catch {
          // A stray log line from a native library is not a protocol line.
        }
        next();
      });
    };
    next();
  });
}

export async function workerStatus(): Promise<TranscribeStatus> {
  let status: TranscribeStatus | null = null;
  await run(['--status'], (v) => {
    status = v as unknown as TranscribeStatus;
  });
  if (!status) throw new Error('No status from the speech worker');
  return status;
}

let last: Offer = { kind: 'hidden' };
let probing: Promise<Offer> | null = null;

/** What the window may offer, read once from the worker; hidden when the worker cannot say. */
export function probeOffer(): Promise<Offer> {
  probing ??= workerStatus()
    .then(decideOffer)
    .catch((): Offer => ({ kind: 'hidden' }))
    .then((offer) => {
      last = offer;
      return offer;
    });
  return probing;
}

/** The last answer of `probeOffer`, for a menu that cannot wait. */
export const currentOffer = (): Offer => last;

export async function workerInstall(
  onProgress: (received: number, total: number) => void,
  signal: AbortSignal,
): Promise<boolean> {
  let ok = false;
  await run(
    ['--install'],
    (v) => {
      if (Array.isArray(v.progress)) onProgress(Number(v.progress[0]), Number(v.progress[1]));
      if (typeof v.ok === 'boolean') ok = v.ok;
    },
    signal,
  );
  if (ok) probing = null;
  return ok;
}

export async function workerTranscribe(path: string, signal: AbortSignal): Promise<TranscriptResult> {
  let result: TranscriptResult | null = null;
  await run(
    [path],
    (v) => {
      if (v.result) result = v.result as TranscriptResult;
    },
    signal,
  );
  if (!result) throw new Error('The speech worker returned no text');
  return result;
}
