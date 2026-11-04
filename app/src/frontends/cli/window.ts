/**
 * `curlew window` — the GTK window (ADR 0009 step 5). Only an explicit command opens it, so a bare
 * `curlew`, and an agent running one, never puts a window on the desktop.
 *
 * The window is its own bundle, imported on demand by `index.ts`: GTK is not in the CLI bundle.
 */

import { _ } from '@curlew/protocol';
import type { CommandModule } from 'yargs';

export const windowCommand: CommandModule = {
  command: 'window',
  get describe() {
    return _('Open the window (agent access rules)');
  },
  handler: async () => {
    if (typeof (globalThis as { imports?: unknown }).imports === 'undefined') {
      console.error(_('The window needs GJS (GTK 4 and libadwaita); this is the Node.js build.'));
      process.exitCode = 1;
      return;
    }
    // Reached only with extra arguments: a plain `curlew window` is handled in `index.ts`.
    console.error(_('curlew window takes no arguments.'));
    process.exitCode = 1;
  },
};
