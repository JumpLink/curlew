/**
 * The write log — one line per granted write (ADR 0004 §7).
 *
 * Time, capability, target, frontend and the id of what was sent. Never the text: the log is a
 * file that gets copied around. The line is appended AFTER the write, because it carries the id
 * the write returned and a line written first would claim a send that never left. A line that
 * cannot be appended throws, so the caller reports the call as failed — the write happened and
 * its record did not, and the person has to hear that.
 */

import { dataDir, ensurePrivateDir } from '@curlew/store';
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type WriteFrontend = 'cli' | 'mcp' | 'daemon';

export interface WriteLogEntry {
  /** `<area>.<verb>`, for example `xmpp.send`. */
  capability: string;
  /** The grant's target, for example `<account>/<address>`. */
  target: string;
  frontend: WriteFrontend;
  /** The id of what was created or sent; a presence has none. */
  id?: string;
  /** What happened when it is not a plain write, for example `presence available`. */
  note?: string;
}

export const WRITE_LOG_FILE = 'writes.log';

export function writeLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), WRITE_LOG_FILE);
}

/** Append one JSON line. `path` is injected by tests. */
export function appendWriteLog(
  entry: WriteLogEntry,
  options: { path?: string; now?: () => Date } = {},
): void {
  const path = options.path ?? writeLogPath();
  const at = (options.now ?? (() => new Date()))().toISOString();
  ensurePrivateDir(dirname(path));
  appendFileSync(path, `${JSON.stringify({ at, ...entry })}\n`, { mode: 0o600 });
}
