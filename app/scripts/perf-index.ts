/**
 * Writes the synthetic LARGE index the responsiveness measurements run against (#501, #541):
 * `node --experimental-strip-types app/scripts/perf-index.ts <dir> [chats] [messages]` creates
 * `<dir>/index.db` and `<dir>/config.json`. Every name, address and body is made up; the real
 * index is never an input to a measurement.
 */

import { generateLargeIndex } from '../tests/fixtures/large-index.ts';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: perf-index.ts <dir> [chats] [messages]');
  process.exit(2);
}
const num = (value: string | undefined): number | undefined =>
  value === undefined ? undefined : Number(value);
console.log(
  JSON.stringify(generateLargeIndex(dir, { chats: num(process.argv[3]), messages: num(process.argv[4]) })),
);
