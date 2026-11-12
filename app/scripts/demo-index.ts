/**
 * Writes the demo index: `node --experimental-strip-types app/scripts/demo-index.ts <dir>` creates
 * `<dir>/index.db`, `<dir>/config.json` and `<dir>/previews/`. The window does this itself with
 * `CURLEW_DEMO=1`; this wrapper is for a fixed directory. Every name and address is made up.
 */

import { generateDemo } from '../src/core/demo/generate.ts';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: demo-index.ts <dir>');
  process.exit(2);
}
console.log(JSON.stringify(generateDemo(dir)));
