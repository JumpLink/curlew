/**
 * Keyed diff for the conversation list: which rows on screen can stay, and which have to be built.
 *
 * Why it exists (#501): tearing the list down and building it again is what froze the window. On
 * a synthetic index of 10 500 conversations, `Gtk.ListBox.remove_all()` over ~6 000 live rows took
 * 703 ms in ONE dispatch, 219 ms of which was GTK's unrealize pass -- and that pass is atomic, so
 * no amount of slicing breaks it up. A refresh after the daemon synced changes a handful of rows
 * at most, so the answer is not to slice the teardown but to avoid it: a row whose key is
 * unchanged draws the same pixels and is kept, widget and all.
 *
 * Keys come from {@link ../window/conversation-list-model.ts}: everything the row renders, joined.
 */

export interface RowDiff {
  /** Positions in the old list whose rows must go, ascending. */
  remove: number[];
  /** Positions in the NEW list whose rows must be built, ascending. */
  insert: number[];
}

/**
 * The rows to drop and to build so that `old` becomes `next`.
 *
 * Apply it as: drop every `remove` row (by widget, so shifting positions do not matter), then for
 * each `i` in `insert`, in order, build `next[i]` and insert it at position `i`. What is left over
 * is then exactly `next`, because the kept rows are in `next`'s own order: of the rows that could
 * stay, only a longest run that is already in order does, and the few that sit in the wrong place
 * are built again rather than moved (a move in a `Gtk.ListBox` is a remove and an insert anyway).
 */
export function diffKeys(old: readonly string[], next: readonly string[]): RowDiff {
  const wanted = new Map<string, number[]>();
  for (let i = next.length - 1; i >= 0; i--) {
    const at = wanted.get(next[i]!);
    if (at) at.push(i);
    else wanted.set(next[i]!, [i]);
  }
  const remove: number[] = [];
  /** Old position → the position it would take in `next`. */
  const candidates: Array<{ from: number; to: number }> = [];
  for (let i = 0; i < old.length; i++) {
    // Duplicate keys are possible in principle (the same conversation under two sections), so a
    // key is claimed once: the second row with it is built again.
    const at = wanted.get(old[i]!);
    const to = at?.pop();
    if (to === undefined) remove.push(i);
    else candidates.push({ from: i, to });
  }
  const order = longestIncreasing(candidates.map((candidate) => candidate.to));
  const stays = new Set(order);
  const taken = new Set<number>();
  for (let i = 0; i < candidates.length; i++) {
    if (stays.has(i)) taken.add(candidates[i]!.to);
    else remove.push(candidates[i]!.from);
  }
  remove.sort((a, b) => a - b);
  const insert: number[] = [];
  for (let i = 0; i < next.length; i++) if (!taken.has(i)) insert.push(i);
  return { remove, insert };
}

/** Positions of a longest strictly increasing subsequence of `values`, ascending. */
function longestIncreasing(values: readonly number[]): number[] {
  if (values.length === 0) return [];
  /** Position of the smallest tail of a run of each length. */
  const tails: number[] = [];
  const before: number[] = Array.from({ length: values.length }, () => -1);
  for (let i = 0; i < values.length; i++) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (values[tails[mid]!]! < values[i]!) low = mid + 1;
      else high = mid;
    }
    if (low > 0) before[i] = tails[low - 1]!;
    tails[low] = i;
  }
  const out: number[] = [];
  for (let i = tails[tails.length - 1]!; i !== -1; i = before[i]!) out.push(i);
  return out.reverse();
}
