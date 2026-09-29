/**
 * A fake machine and a fake person for the setup run: nothing here is a terminal, a phone, a
 * session bus or an account. The whole wizard is driven through these two objects, which is the
 * point of the split — and it is also what lets the QR's security property be TESTED rather than
 * asserted in a comment.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommandRunner, RunOptions, RunResult } from '../../../src/core/actions/setup-host.ts';
import type { SetupContext, SetupPrompter } from '../../../src/core/actions/setup.ts';

/**
 * A throwaway XDG root for the fakes' config and index. Not `~/.config`: a stage that enables a
 * backend really does write the config file, and a test must never write into the developer's
 * — nor read the index that is already there, which would make "is it set up?" depend on whose
 * machine the suite runs on.
 */
export const SANDBOX = mkdtempSync(join(tmpdir(), 'postbote-setup-'));

/** A pairing payload that looks real enough that its appearance anywhere else is a real finding. */
export const FAKE_PAIRING_PAYLOAD = 'ts01://AQIDcGFpcmluZy1zZWNyZXQtc3ludGhldGljLW5vLXNlZQ';

export interface FakeHostCall {
  argv: readonly string[];
  options: RunOptions | undefined;
  captured: boolean;
}

export interface FakeHost extends CommandRunner {
  readonly calls: FakeHostCall[];
  readonly files: Map<string, string>;
  /** Answer `which()` and `run()` for a command name. */
  readonly commands: Map<string, { path: string; code: number; output: string }>;
  /** Every line handed to `notify`, joined — what a person would have seen. */
  transcript(): string;
}

/**
 * A host that records. `stdio` is NOT a concept here: a call records whether it asked to capture,
 * which is how the tests see that nothing wraps a linking call.
 */
export function fakeHost(overrides: Partial<Record<string, string>> = {}): FakeHost {
  const calls: FakeHostCall[] = [];
  const files = new Map<string, string>();
  const commands = new Map<string, { path: string; code: number; output: string }>();
  const env: Record<string, string> = { HOME: '/home/tester', ...overrides };
  const host: FakeHost = {
    calls,
    files,
    commands,
    bundlePath: () => env.POSTBOTE_BUNDLE ?? '/home/tester/app/dist/postbote.gjs.mjs',
    which: (command) => host.commands.get(command)?.path ?? null,
    run(argv, options): RunResult {
      const captured = options?.capture === true;
      calls.push({ argv, options, captured });
      const answer = host.commands.get(argv[0] ?? '');
      // The default answer is 1 — a command this machine has never run. A fake that reported 0
      // for everything would say "enabled", "linked" and "verified" for a machine with nothing
      // on it, which is the one thing a wizard's own detection must not do.
      return { code: answer?.code ?? 1, output: captured ? (answer?.output ?? '') : '' };
    },
    readFile: (path) => files.get(path) ?? null,
    writeFile: (path, text) => {
      files.set(path, text);
    },
    mkdirp: () => {},
    exists: (path) => files.has(path),
    home: () => env.HOME ?? '/home/tester',
    cwd: () => env.PWD ?? '/home/tester/postbote',
    env: (name) => env[name],
    isCheckout: (dir) => host.files.has(`${dir}/package.json`) && host.files.has(`${dir}/app/package.json`),
    transcript: () => '',
  };
  return host;
}

export interface FakePrompter extends SetupPrompter {
  /** Every `notify` message, in order. */
  readonly notified: string[];
  /** Every question asked, in order (`ask` and `confirm` alike). */
  readonly asked: string[];
  /** Answers handed out, in order. `confirm` takes from here too. */
  readonly answers: (string | boolean)[];
}

/**
 * A person who answers from a script. `ask`/`confirm` shift `answers`; a `confirm` with no
 * answer left is NO, because an unanswered question must never enable anything.
 */
export function fakePrompter(answers: (string | boolean)[] = []): FakePrompter {
  const notified: string[] = [];
  const asked: string[] = [];
  const queue = [...answers];
  const next = (): string | boolean | undefined => queue.shift();
  return {
    notified,
    asked,
    answers: queue,
    async ask(label) {
      asked.push(label);
      const value = next();
      notified.push(`${label}: ${String(value ?? '')}`);
      return typeof value === 'string' ? value : '';
    },
    notify(message) {
      notified.push(message);
    },
    async confirm(question) {
      asked.push(question);
      const value = next();
      notified.push(`${question} ${value === true ? 'y' : 'n'}`);
      return value === true;
    },
  };
}

export interface FakeContextOptions {
  mode?: 'checkout' | 'published';
  checkout?: string | null;
  prompter?: FakePrompter;
  host?: FakeHost;
  configPath?: string;
  indexPath?: string;
  /** What `link` does instead of linking a real device. Default: emit a QR and finish. */
  link?: (backend: string, prompter: SetupPrompter) => Promise<void>;
  /** What the account counter answers. Default: nothing linked, on every backend. */
  countAccounts?: (backend: string) => Promise<number>;
  /** Backends the fake config has enabled, by name. */
  enabled?: string[];
  env?: Record<string, string>;
}

export interface FakeContext extends SetupContext {
  readonly prompter: FakePrompter;
  readonly host: FakeHost;
  readonly linked: string[];
}

export function fakeContext(options: FakeContextOptions = {}): FakeContext {
  const prompter = options.prompter ?? fakePrompter();
  const host = options.host ?? fakeHost(options.env);
  const linked: string[] = [];
  return {
    mode: options.mode ?? 'checkout',
    checkout: options.checkout === undefined ? '/home/tester/postbote' : options.checkout,
    prompter,
    host,
    configPath: options.configPath ?? join(SANDBOX, 'postbote', 'config.json'),
    indexPath: options.indexPath ?? join(SANDBOX, 'postbote', 'index.db'),
    countAccounts: options.countAccounts ?? (async () => 0),
    link: options.link ?? (async (backend, p) => {
      linked.push(backend);
      p.notify(`▓▒░ pairing: ${FAKE_PAIRING_PAYLOAD} ░▒▓`);
      p.notify('scanned — linked');
    }),
    done: new Map(),
    linked,
  };
}
