/**
 * `curlew watch` — one JSON line per change-journal row, as it arrives (ADR 0007 §4).
 *
 * Long-lived like `daemon`, so it is not routed through `runAndExit`; SIGTERM/SIGINT end it
 * normally with exit 0.
 */

import { _ } from '@curlew/protocol';
import type { CommandModule } from 'yargs';

import { openIndex } from '../../core/actions/index-sync.ts';
import { runWatch } from '../../core/actions/watch.ts';
import { gioDaemonChangeSource } from '../../core/lib/daemon-watch-client.gjs.ts';
import { pickArgv } from './output.ts';

export const watchCommand: CommandModule = {
  command: 'watch',
  get describe() {
    return _(
      'Print the change journal as it grows, one JSON line per row — the reference listener for the daemon’s Changed signal',
    );
  },
  builder: (yargs) =>
    yargs.option('since', {
      type: 'number',
      describe: _('Start after this journal seq; the default is the newest row, so only new changes print'),
    }),
  handler: (argv) => {
    const raw = argv as Record<string, unknown>;
    const controller = new AbortController();
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.on(signal, () => controller.abort());
    }
    const db = openIndex();
    runWatch({
      db,
      since: pickArgv<number>(raw, 'since'),
      signal: controller.signal,
      out: (line) => console.log(line),
      notice: (text) => console.error(text),
      source: gioDaemonChangeSource(),
    })
      .then(() => {
        db.close();
        process.exit(0);
      })
      .catch((err: unknown) => {
        console.error(err instanceof Error ? err.message : err);
        db.close();
        process.exit(1);
      });
  },
};
