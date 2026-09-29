/**
 * `postbote daemon` — receive from every enabled delivery-only backend until stopped.
 *
 * Long-lived by design, so NOT wired through `runAndExit`: the promise settles when the run is
 * over, not when the handler returns. The signals are installed here, in the frontend, because
 * they are the platform's: `process.on('SIGTERM')`/`'SIGINT'` deliver under gjsify through
 * `GLibUnix.signal_add` (measured on GJS 1.88.1, gjsify 0.49.0), and the handler runs on the JS
 * thread while the CLI's main loop pumps the context.
 *
 * What SIGTERM must NOT do is kill the process: a batch in flight was already acknowledged to the
 * network, so it has to be written first. The signal therefore only aborts — every session is
 * closed, every loop awaited, the conversations rebuilt once, the index closed, and then exit 0.
 */

import type { CommandModule } from 'yargs';

import { REBUILD_DEBOUNCE_MS, runDeliveryDaemon } from '../../core/actions/daemon.ts';
import { pickArgv, printJson } from './output.ts';

export const daemonCommand: CommandModule = {
  command: 'daemon',
  describe:
    'Receive from every enabled delivery-only backend (Signal, WhatsApp) until stopped — the systemd unit in contrib/ runs this',
  builder: (yargs) =>
    yargs
      .option('account', {
        type: 'string',
        describe: 'Restrict to one account id; omit for all',
      })
      .option('rebuild-debounce', {
        type: 'number',
        describe: `Milliseconds of quiet before the conversations are rebuilt (default ${REBUILD_DEBOUNCE_MS})`,
      }),
  handler: (argv) => {
    const raw = argv as Record<string, unknown>;
    const controller = new AbortController();
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.on(signal, () => {
        if (controller.signal.aborted) return;
        // A second signal (or a third) does not change the plan: the run is already stopping.
        console.error(`postbote-daemon: ${signal} — stopping after the last batch is written`);
        controller.abort();
      });
    }
    runDeliveryDaemon({
      accountId: pickArgv<string>(raw, 'account'),
      rebuildDebounceMs: pickArgv<number>(raw, 'rebuild-debounce'),
      signal: controller.signal,
    })
      .then((result) => {
        printJson(result);
        process.exit(0);
      })
      .catch((err: unknown) => {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      });
  },
};
