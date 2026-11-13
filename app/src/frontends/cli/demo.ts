/**
 * `curlew demo` — the window on made-up data (no accounts, nothing real, nothing sent). Handled in
 * `index.ts` like `curlew window`; this module keeps it in `--help` and answers on Node.
 */

import { _ } from '@curlew/protocol';
import type { CommandModule } from 'yargs';

export const demoCommand: CommandModule = {
  command: 'demo',
  get describe() {
    return _('Open the window on made-up demo data (same as CURLEW_DEMO=1 curlew window)');
  },
  handler: async () => {
    if (typeof (globalThis as { imports?: unknown }).imports === 'undefined') {
      console.error(_('The window needs GJS (GTK 4 and libadwaita); this is the Node.js build.'));
      process.exitCode = 1;
      return;
    }
    console.error(_('curlew demo takes no arguments.'));
    process.exitCode = 1;
  },
};
