/**
 * Reads the `[stall] …` lines dev/perf-session.sh captured and says whether the window stayed
 * responsive: one row per scenario, judged against the budget the stall probe was started with
 * (50 ms, the probe's own default; a frame at 60 Hz is 16).
 *
 * TWO NUMBERS, BECAUSE THEY ARE NOT THE SAME CLAIM.
 *
 * `work` is the worst single piece of work the app NAMED with `timed()` -- reading the index,
 * diffing the rows, building a page, folding the sections. It is the app's own, it is what a
 * regression in this code shows up in, and it is judged everywhere.
 *
 * `block` is the worst gap in the main loop, whatever caused it. It is the number that matches
 * what a person feels, but it also contains GTK's paints, and those depend on the renderer: with
 * no GPU, an empty window blocks for ~500 ms all by itself. So `dev/perf-floor.js` measures an
 * empty window in the same session, and blocks are held against the app only where that floor
 * comes in under budget. Where it does not, the row says so instead of quietly passing or
 * flakily failing.
 *
 * Each log is split at `curlew window: ready`, which the window prints once the first list has
 * been PAINTED. Before it is cold start, which every scenario pays once and which is mostly GTK's
 * own first frame; after it the window is up and a block is a freeze the person feels. The split
 * goes by the timestamp each line carries, not by the order the lines appear in: a block is
 * reported by the tick that follows it, so its line lands after whatever ran during it --
 * including the milestone -- while the block itself began before.
 *
 * `node dev/perf-report.mjs <out-dir> [budget-ms]`. Exits 1 when something enforced is over its
 * budget, so CI fails on a regression instead of printing one.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What the window may block the loop for while it is starting, before the list is on screen.
 *
 * Realizing the window, loading the icon theme and GTK's first layout and snapshot pass all land
 * in one dispatch before any Curlew code runs, and none of it is ours to slice. Measured at
 * 345-379 ms on this workstation, independent of the index size (1 200 and 10 500 conversations
 * give the same figure), so the number below is headroom over that, not a target.
 */
const WARMUP = { ms: 1200, issue: 'JumpLink/curlew#546' };

/**
 * Scenarios that are KNOWN to be over the budget once the window is up, with the issue that
 * tracks each. A raised budget here is a visible, dated exception; silence is not an option
 * (#501). Empty is the goal.
 *
 * @type {Record<string, { ms: number; issue: string }>}
 */
const EXCEPTIONS = {
  // GTK realizing the chat page the first time it enters the split view: 62 ms, of which the app's
  // own share is 9. Only the FIRST chat opened pays it; every later switch is inside the budget.
  switch: { ms: 100, issue: 'JumpLink/curlew#547' },
  // One `LIKE '%needle%'` over every message row: 60 ms on the fixture, and it grows with the
  // message count. Typing is debounced, so this is once per pause, not once per keystroke.
  search: { ms: 100, issue: 'JumpLink/curlew#548' },
};

/** The empty-window probe (dev/perf-floor.js): the environment, not the app. */
const FLOOR = 'floor';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: perf-report.mjs <out-dir> [budget-ms]');
  process.exit(2);
}
const budget = Number(process.argv[3]) || 50;

const STAMPED = / at (\d+(?:\.\d+)?)$/;

/** The blocks and the named work of one log, each on its side of the first painted frame. */
function readLog(path) {
  const text = readFileSync(path, 'utf8');
  let shownAt = null;
  let readyAt = null;
  const blocks = [];
  /** @type {{ label: string; ms: number; at: number }[]} */
  const phases = [];
  for (const line of text.split('\n')) {
    const milestone = /^curlew window: (shown|ready)(?: at (\d+(?:\.\d+)?))?/.exec(line);
    if (milestone) {
      // A log from a build without stamps still tells us the milestone was reached; it just
      // cannot place anything in time, and then line order is all there is.
      const at = milestone[2] === undefined ? Number.POSITIVE_INFINITY : Number(milestone[2]);
      if (milestone[1] === 'shown') shownAt ??= at;
      else readyAt ??= at;
      continue;
    }
    const blocked = /^\[stall\] main loop blocked (\d+(?:\.\d+)?) ms/.exec(line);
    if (blocked) {
      const at = STAMPED.exec(line);
      blocks.push({ ms: Number(blocked[1]), at: at ? Number(at[1]) : readyAt === null ? -1 : Infinity });
      continue;
    }
    const phase = /^\[stall\] (.+?): (\d+(?:\.\d+)?) ms/.exec(line);
    if (phase) {
      const at = STAMPED.exec(line);
      phases.push({
        label: phase[1],
        ms: Number(phase[2]),
        at: at ? Number(at[1]) : readyAt === null ? -1 : Infinity,
      });
    }
  }
  const boundary = readyAt ?? Number.POSITIVE_INFINITY;
  const after = (item) => item.at >= boundary;
  const worstOf = (items) => items.reduce((worst, item) => (item.ms > worst ? item.ms : worst), 0);
  return {
    shown: shownAt !== null,
    ready: readyAt !== null,
    // Cold start is the whole stretch before the first painted frame, however many dispatches it
    // took: a window that blocks twice for 400 ms kept the person waiting 800.
    warmup: blocks.filter((b) => !after(b)).reduce((sum, b) => sum + b.ms, 0),
    block: worstOf(blocks.filter(after)),
    blocks: blocks.filter(after).length,
    work: worstOf(phases.filter(after)),
    phases: phases.filter(after),
  };
}

const logs = readdirSync(dir)
  .filter((name) => name.endsWith('.log'))
  .sort();
if (logs.length === 0) {
  console.error(`perf-report: no logs in ${dir}`);
  process.exit(2);
}

const read = new Map(logs.map((name) => [name.replace(/\.log$/, ''), readLog(join(dir, name))]));
const floor = read.get(FLOOR);
/**
 * Whether a raw main-loop block in this session is evidence about the app.
 *
 * The test is what the EMPTY window's first frame cost, not what it blocked for afterwards: an
 * empty window has nothing to repaint, so it idles at 0 ms however slow the renderer is, while
 * the app's own paints -- a page of rows entering the list -- cost what a frame of real content
 * costs here. One frame of an empty window is the cheapest frame this environment can draw, so a
 * floor over the budget means no frame is inside it and a block cannot be told from a paint.
 * Measured: 0 ms on a workstation with a GPU, 458 ms under llvmpipe in a container.
 */
const trustBlocks = floor !== undefined && floor.warmup <= budget && floor.block <= budget;
/** The app pays the environment's own first frame on top of its own start-up work. */
const warmupLimit = WARMUP.ms + (floor?.warmup ?? 0);

let failed = false;
const rows = [];
for (const [scenario, log] of read) {
  if (scenario === FLOOR) continue;
  const limit = EXCEPTIONS[scenario]?.ms ?? budget;
  const over = [];
  if (log.work > limit) over.push('WORK OVER');
  if (trustBlocks && log.block > limit) over.push('BLOCK OVER');
  if (log.warmup > warmupLimit) over.push('COLD START OVER');
  // A window that never came up, or never painted its first list, measured nothing at all.
  if (!log.shown) over.push('WINDOW NEVER SHOWN');
  else if (!log.ready) over.push('LIST NEVER PAINTED');
  if (over.length > 0) failed = true;
  rows.push({ scenario, ...log, limit, over });
}
if (rows.length === 0) {
  console.error(`perf-report: ${dir} has the floor probe and nothing else`);
  process.exit(2);
}

const pad = (text, width) => String(text).padEnd(width);
const ms = (value) => `${value.toFixed(0)} ms`;
console.log(
  `${pad('scenario', 12)} ${pad('work', 10)} ${pad('block', 10)} ${pad('blocks', 7)} ${pad('budget', 9)} cold start`,
);
for (const row of rows) {
  const notes = [...row.over];
  const exception = EXCEPTIONS[row.scenario];
  if (exception) notes.push(`(${exception.issue})`);
  console.log(
    `${pad(row.scenario, 12)} ${pad(ms(row.work), 10)} ${pad(ms(row.block), 10)} ${pad(row.blocks, 7)} ${pad(ms(row.limit), 9)} ${pad(ms(row.warmup), 10)}${notes.length > 0 ? `  ${notes.join(' ')}` : ''}`,
  );
}
for (const row of rows) {
  const worst = new Map();
  for (const phase of row.phases) if (phase.ms > (worst.get(phase.label) ?? 0)) worst.set(phase.label, phase.ms);
  const top = [...worst].sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (top.length > 0) console.log(`  ${row.scenario}: ${top.map(([k, v]) => `${k} ${ms(v)}`).join(', ')}`);
}

console.log(
  `\n'work' is the worst single thing the app did and is always enforced; 'block' is the worst gap` +
    `\nin the main loop, whatever caused it. Cold start (up to the first painted frame) is budgeted` +
    `\nseparately at ${ms(warmupLimit)} (${WARMUP.issue}): mostly GTK's own first frame.`,
);
if (floor === undefined) {
  console.log(
    `\nNo ${FLOOR}.log: without the empty-window probe a raw block cannot be told apart from the` +
      `\nrenderer, so blocks are reported here but NOT enforced. Only 'work' is.`,
  );
} else if (trustBlocks) {
  console.log(
    `\nempty window here: ${ms(floor.warmup)} first frame, ${ms(floor.block)} worst block afterwards` +
      ` -- inside\nthe ${budget} ms budget, so blocks are enforced too.`,
  );
} else {
  console.log(
    `\nempty window here: ${ms(floor.warmup)} for its FIRST FRAME, over the ${budget} ms budget with no` +
      `\nCurlew code in the process -- a software renderer. No frame in this session is inside the` +
      `\nbudget, so a block cannot be told from a paint: blocks are reported but NOT enforced, and` +
      `\ncold start is allowed that ${ms(floor.warmup)} on top. 'work' is enforced, and it is the half` +
      `\nthis code owns.`,
  );
}
if (failed) {
  console.error('perf-report: something is over its budget.');
  process.exit(1);
}
console.log('perf-report: every scenario stayed inside its budget.');
