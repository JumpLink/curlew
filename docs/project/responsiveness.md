# Staying responsive on a large index

The window must never freeze. It did: switching from one chat to another on a real index made
GNOME offer to kill Curlew ("eu.jumplink.curlew is not responding"), and one window burned five
hours of CPU in under four hours of wall clock (#501, #541). Every unit test was green while that
happened, because the cost was not in a function — it was in how many widgets the list asked GTK
to hold.

## The budget

**50 ms.** Over that, a click or a keystroke visibly waits; at 100 ms a person starts clicking
again. One frame at 60 Hz is 16 ms, so the budget is already three frames of slack. The window
measures it itself: `CURLEW_DEBUG_STALL=1` starts a 16 ms tick and logs every gap longer than
`CURLEW_DEBUG_STALL_MS` (default 50) as `[stall] main loop blocked N ms at T`, and `timed()` names
the work that did it. Every line carries `at T`, milliseconds since the process started, because a
block is reported by the tick AFTER it: without the stamp a 200 ms block appears in the log behind
whatever ran during it, on the wrong side of any boundary you want to draw.

### Two numbers, because they are not the same claim

`dev/perf-report.mjs` prints both:

- **`work`** — the worst single thing the app *named* with `timed()`: reading the index, diffing
  the rows, building a page, folding the sections. This is the app's own, it is where a regression
  in this code lands, and it is **always enforced**.
- **`block`** — the worst gap in the main loop, whatever caused it. This is the number that
  matches what a person feels, but it also contains GTK's paints, and those depend on the
  renderer.

That second caveat is not theoretical. `dev/perf-floor.js` runs an **empty** `Adw` window in the
same session, with the same 16 ms tick and no Curlew code in the process. Its **first frame** costs
0 ms on this workstation and **458 ms** in a GPU-less container — nine times the budget, before the
app exists. That first frame is the measurement that decides, and the distinction matters: an empty
window has nothing to repaint, so it idles at 0 ms however slow the renderer is. Judging the
environment by what the floor blocks for *after* its first frame passed llvmpipe as healthy in the
first container run, while the app's own paints there — a page of rows entering the list — blocked
for 186-434 ms. One frame of an empty window is the cheapest frame the environment can draw; if
that is over the budget, no frame is inside it, and a block cannot be told from a paint.

So raw blocks are held against the app only where that floor comes in under budget. Where it does
not, the row prints the block and says it is not enforced, rather than failing flakily or passing
quietly, and cold start is allowed the floor's first frame on top of its own budget.

### Cold start

Budgeted separately, and it ends at the first *painted* frame. `curlew window: ready` is logged
from the window's frame clock (`after-paint`) once the first list has been drawn — not when the
rows were read, because holding rows is not showing them. GTK realizing the window, loading the
icon theme and running its first layout and snapshot pass costs 350-500 ms before any Curlew code
runs, is not sliceable from JS, and does not move with the index size. The paint of the filled
list belongs to the same stretch: with a GPU it is a few milliseconds, with llvmpipe ~180 ms, and
budgeting it as a stall *after* the window was up would blame the list for GTK's first frame
(#546). A slow first frame still may not excuse a stall while typing — that is the point of
splitting the two.

## Running the measurement

```bash
dev/perf.sh --build                   # 10 500 conversations / 100 000 messages, a few minutes
dev/perf.sh --small                   # the CI size: 1 200 / 12 000, about 80 seconds
dev/perf.sh --only switch --keep      # one scenario, and keep the fixture and the logs
dev/perf.sh --budget 20               # a tighter budget, to find what is merely inside 50 ms
```

It writes a synthetic index (`app/scripts/perf-index.ts` → `app/tests/fixtures/large-index.ts`:
invented names, bodies and addresses — **the real index is never an input to a measurement**),
then plays four scenarios on it in one private `mutter` and reports what each one cost:

| Scenario  | What it does |
|---|---|
| `startup` | cold start: first frame, the list read, the row build, the duplicate scan |
| `refresh` | the config changes while the window is up — a background reload of the whole list |
| `search`  | a word typed one character at a time |
| `switch`  | four chats opened in turn, the first of them the one with the long history |
| `floor`   | an empty window — the environment's own cost, always run, never skipped by `--only` |

`startup` reports almost no `work`, and that is not an empty measurement: everything it does — the
read, the diff, the first page of rows, the duplicate scan — happens *before* the first painted
frame, so it is counted in that scenario's cold start (133 ms of the 1 200 budget here) rather than
after it. What `startup` enforces is that the window came up, painted a filled list, and did not
spend longer than the cold-start budget getting there. The scenarios that measure work after the
window is up are the other three.

The fixture is tens of megabytes and lives under `/tmp`, removed again unless `--keep`. Each
scenario gets its own copy, so one that marks a chat read does not change what the next measures.

**Measure on a quiet machine.** Cold start rose from 365 ms to 1 856 ms at load average 9 while
other work ran on this workstation. Run `uptime` first; a loaded run tells you nothing. The same
goes for the disk: one run under I/O pressure on a 98 %-full disk read a page of messages in
5 426 ms where three runs of the same scenario took 6, 2 and 6 ms. If a single read is suddenly
three orders of magnitude slow and nothing else moved, check `/proc/pressure/io` before believing
it.

## In CI

`.github/workflows/ci.yml` runs `./dev/perf.sh --small` in the `build-and-test` job and fails when
something enforced is over its budget. The container needs `gtk4 libadwaita gstreamer1` (the window
bundle imports Gtk, Gdk, Gsk, Adw and Gst at module load, so a missing typelib fails the import,
not a call) and `mutter mesa-dri-drivers dbus-daemon` for the compositor `dev/headless.sh` starts.
Measured in a `fedora:44` container: the window maps with mutter's "surfaceless renderer without
GPU", so no `/dev/dri` is needed.

**What CI can and cannot prove.** With llvmpipe the floor's first frame is ~460 ms, so in CI the
raw-block numbers are printed but not enforced and cold start gets that 460 ms on top; `work` is
enforced, and that is the half this code owns. The run says which mode it used in its last lines,
so a gate that stopped checking something is visible rather than reassuring. On a workstation with
a GPU the floor is 0 ms and everything is enforced — which is why the full-size run belongs in the
PR that changes the list, not only in CI.

`dev/headless.sh` is the in-repo compositor wrapper — a `mutter --headless` with one virtual
monitor and a private D-Bus session, so a run opens no window on anybody's desktop and reaches
none of the person's apps over the bus. Setting `HEADLESS_RUN` uses werkstatt's richer
`scripts/headless-run` instead (that one also does screenshots and monitor scaling).

### Documented exceptions

`EXCEPTIONS` in `dev/perf-report.mjs` holds the scenarios known to be over budget, each with the
issue that owns the remaining cost. A raised budget is printed on every run next to its issue
number — **a scenario is never silently excused**, and the goal is an empty table. Today:

- `switch` → #547, GTK realizing the chat page the first time it enters the split view (~54 ms of
  a 62 ms block; only the first chat opened pays it)
- `search` → #548, one `LIKE '%needle%'` over every message row (60 ms, and it grows with the
  message count)

## Why the list is built the way it is

`Gtk.ListBox` does not virtualise. Each insert costs a pass over the rows already there — 0.9 ms
at row 2 500, 4.5 ms at 3 400, 6.9 ms at 5 900 — so filling ~6 000 rows is quadratic, and
`remove_all()` over them is the mirror image (703 ms, of which 219 ms is GTK's atomic unrealize
pass and cannot be sliced). No amount of batching fixes that: the total work is the problem. Three
things follow, and a change that undoes any of them brings the freeze back:

1. **A bounded window of rows** (`PAGE` in `conversation-list.ts`): the list plans every row the
   filters allow but builds only about four screens' worth, and grows it as the scroller moves.
2. **A keyed diff** (`list-diff-model.ts`): a row whose key is unchanged keeps its widget, so a
   refresh that changes one row of a thousand touches one row. The keys are
   `entryRowKey`/`sectionRowKey` — they must move with everything a row *draws* and with nothing
   else, which is what their tests assert from both sides.
3. **Idle work bounded in TIME, not in steps** (`idle-work-model.ts`): a fixed batch size is
   always wrong, because the cost of a batch is not its count — 40 rows cost 25-50 ms here and
   3 ms elsewhere. Each turn runs steps until its few milliseconds are spent. This is a gap in
   gjsify (gjsify/gjsify#2765) and becomes a re-export once that lands.

Searching runs off `Gtk.SearchEntry`'s own debounced `search-changed` (150 ms, restarted by each
change), so touch-typing a name costs one rebuild rather than nine — a second timer on top would
only delay the answer. The first read shows placeholder rows (`skeleton-rows.ts`) instead of the empty state —
but **a skeleton may never hide a stall**: the budget is enforced over the same run that shows it.
