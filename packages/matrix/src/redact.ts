/**
 * What the Matrix SDK's logger may print. A log line is a file that gets copied and pasted into
 * bug reports (ADR 0002 §6: no ids of rooms or people), and the SDK's warnings carry exactly
 * those: sender, room, event id, device key, megolm session id. Pure, so both runtimes test it.
 */

import { _n, fmt } from '@curlew/protocol';
import { envValue } from '@curlew/store';

/** Order matters: ids first, so the key rule only sees what is left over. */
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/@[^\s:@]+:[A-Za-z0-9.-]+(:\d+)?/g, '@…'],
  [/![A-Za-z0-9+/=_-]+(:[A-Za-z0-9.-]+(:\d+)?)?/g, '!…'],
  [/\$[A-Za-z0-9+/=_-]+(:[A-Za-z0-9.-]+(:\d+)?)?/g, '$…'],
  [/[A-Za-z0-9+/=_-]{20,}/g, '…'],
];

/** The text with every Matrix user, room and event id and every key-like token replaced by `…`. */
export function redactSdkText(text: string): string {
  return REDACTIONS.reduce((out, [pattern, mark]) => out.replace(pattern, mark), text);
}

/**
 * A per-event decryption warning, whatever follows the prefix: the JS SDK's own, and the Rust
 * crypto machine's, which a long-running follow repeats for every event it still has no key for.
 */
export function isDecryptionWarning(text: string): boolean {
  return text.includes('Error decrypting event') || text.includes('Failed to decrypt a room event');
}

/**
 * How much of the SDK's own logging survives. `warn` is the default: login and sync are normal
 * operation, not a transcript, and the SDK narrates both at info and below. `CURLEW_MATRIX_LOG`
 * (`trace`, `debug`, `info`, `warn`, `error`, `silent`) turns that up or off for a diagnosis —
 * the output is redacted either way. Read at every call, so a run and a test can change it.
 */
export const SDK_LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'silent'] as const;
export type SdkLogLevel = (typeof SDK_LOG_LEVELS)[number];

/** `CURLEW_MATRIX_LOG`, or `warn` when it is unset or names no level. */
export function sdkLogLevel(env: NodeJS.ProcessEnv = process.env): SdkLogLevel {
  const wanted = envValue(env, 'MATRIX_LOG')?.toLowerCase() ?? '';
  return (SDK_LOG_LEVELS as readonly string[]).includes(wanted) ? (wanted as SdkLogLevel) : 'warn';
}

/** Rank of a message level; the SDK says `warn`, the lines we print say `warning`. */
const LEVEL_RANK: Readonly<Record<string, number>> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  warning: 3,
  error: 4,
};

/** Whether a message at `level` gets past `limit`; an unknown level is shown, not hidden. */
export function sdkLogAdmits(limit: SdkLogLevel, level: string): boolean {
  if (limit === 'silent') return false;
  const rank = LEVEL_RANK[level];
  return rank === undefined || rank >= LEVEL_RANK[limit];
}

let undecryptable = 0;

/**
 * Count one undecryptable event instead of logging it: a sync without a key backup logs ~200 of
 * them. The caller that ends a run reports the total once.
 */
export function noteUndecryptable(): void {
  undecryptable++;
}

/** Read and reset the count. */
export function takeUndecryptable(): number {
  const n = undecryptable;
  undecryptable = 0;
  return n;
}

/** The one content-free line for a count; null when there is nothing to say. */
export function undecryptableSummary(n: number): string | null {
  if (n <= 0) return null;
  return fmt(_n('matrix: {n} event not decryptable', 'matrix: {n} events not decryptable', n), { n });
}

/** Print the summary for everything counted since the last call, if anything. */
export function reportUndecryptable(print: (line: string) => void = console.error): void {
  const line = undecryptableSummary(takeUndecryptable());
  if (line) print(line);
}

/**
 * The line an SDK message becomes, or null when it is counted or below the limit. A non-string,
 * non-Error argument is never printed: a logged object can carry an event's content.
 */
export function sdkLogLine(
  level: string,
  args: readonly unknown[],
  limit: SdkLogLevel = sdkLogLevel(),
): string | null {
  const text = args
    .map((m) => (typeof m === 'string' ? m : m instanceof Error ? m.message : '[…]'))
    .join(' ');
  if (isDecryptionWarning(text)) {
    noteUndecryptable();
    return null;
  }
  if (!sdkLogAdmits(limit, level)) return null;
  return `matrix ${level}: ${redactSdkText(text)}`;
}
