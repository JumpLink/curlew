/**
 * The merge assistant's candidates (docs/design/contacts.md): sets of people in the list whose
 * names look alike. A name is never identity, so nothing here merges anything; it only decides
 * which sets are worth asking about. Where the line lies errs towards NOT asking: the person
 * decides every merge anyway, but a wrong question each day is a feature nobody keeps.
 *
 * Similar means, after folding case, diacritics, punctuation and spacing, and putting
 * "Last, First" into "First Last":
 *  - the same words in any order ("Example Ana" and "Ana Example"), or
 *  - the same first word and a last word that is an initial of the other's ("Ana E." and
 *    "Ana Example"), and
 *  - never a single word alone: "Ana" would match every Ana.
 * A nickname that shares no word with the full name is out of reach on purpose.
 */

import type { ListEntry } from './conversation-list-model.ts';

/** A set of people the assistant asks about in one step. */
export interface CandidateSet {
  /** Stable across runs: the sorted participant ids, so a declined set is recognised again. */
  key: string;
  entries: ListEntry[];
}

/** Declined sets, each the participant ids of the set that was skipped. */
export type DeclinedSets = ReadonlyArray<ReadonlyArray<string>>;

const setKey = (ids: Iterable<string>): string => [...new Set(ids)].sort().join('\u0000');

/** The words of a name in "First Last" order, folded; empty when it has no letters at all. */
export function nameWords(name: string): string[] {
  const swapped = name.includes(',') ? name.split(',').reverse().join(' ') : name;
  return swapped
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');
}

/**
 * Names a service hands out for a contact it no longer knows. Many different people carry one,
 * so it says nothing about identity (Telegram's deleted accounts all read "Deleted Account").
 */
const PLACEHOLDER_NAMES = new Set(['deleted account', 'geloschtes konto', 'unknown', 'unbekannt']);

/** A folded name that this many rows share is a placeholder, whatever it says: people are rarely that alike. */
const CROWD = 3;

/** Whether two names (already split by {@link nameWords}) are close enough; see the module comment. */
function similarWords(x: readonly string[], y: readonly string[]): boolean {
  if (x.length < 2 || y.length < 2) return false;
  if (x.length === y.length && [...x].sort().join(' ') === [...y].sort().join(' ')) return true;
  const [first, last] = [x[0]!, x[x.length - 1]!];
  const [otherFirst, otherLast] = [y[0]!, y[y.length - 1]!];
  if (first !== otherFirst) return false;
  const initialOf = (short: string, long: string) => short.length === 1 && long.startsWith(short);
  return initialOf(last, otherLast) || initialOf(otherLast, last);
}

/** Whether two names are close enough to ask about; see the module comment for the line. */
export function similarNames(a: string, b: string): boolean {
  return similarWords(nameWords(a), nameWords(b));
}

/**
 * The sets to ask about: people whose names are similar, chained (Ana Example ~ Ana E. ~ A.
 * Example is one set only where each link holds). Groups and the note to self never appear, a set
 * the person already declined is skipped, and a set that gained someone is a new set.
 */
export function candidateSets(entries: readonly ListEntry[], declined: DeclinedSets = []): CandidateSet[] {
  return setsOfRows(
    entries.map(candidateRow).filter((row) => row !== null),
    declined,
  );
}

/** One row of the scan: a person worth comparing, with their name already folded. */
export interface CandidateRow {
  entry: ListEntry;
  words: string[];
  /** The words sorted and joined — equal keys mean the same words in any order. */
  key: string;
}

/**
 * The folded words of one row, or null when the row is not compared at all (a group, a person
 * with no identity, a name of fewer than two words).
 *
 * Apart from {@link setsOfRows} because `nameWords` normalises, and on a list of thousands that
 * normalising IS the scan: 222 ms of a 230 ms run on 10 500 conversations (#501). The window
 * therefore folds the names in time-sliced chunks and compares them once they are all in.
 */
export function candidateRow(entry: ListEntry): CandidateRow | null {
  if (entry.kind !== 'direct' || entry.personIds.length === 0) return null;
  const words = nameWords(entry.title);
  return words.length >= 2 ? { entry, words, key: [...words].sort().join(' ') } : null;
}

/**
 * The second half of {@link candidateSets}, on rows whose names are already folded.
 *
 * Bucketing alone is not enough. Both rules need a shared word, but a first name is shared by
 * very many people — 9 500 contacts over a few dozen first names is a bucket of hundreds, and
 * comparing every pair in it is 1.7 million `similarWords` calls (222 ms, #501). So neither rule
 * is evaluated pairwise:
 *  - same words in any order: rows with the same {@link CandidateRow.key} match by definition,
 *    so the bucket is joined in one pass. After the CROWD filter such a bucket holds at most two.
 *  - the initial rule: it can only hold when one of the two last words is a SINGLE letter, so
 *    only those rows drive a join, each against the rows whose last word begins with that letter.
 * The relation that comes out is the one `similarWords` defines, pair for pair.
 */
export function setsOfRows(named: readonly CandidateRow[], declined: DeclinedSets = []): CandidateSet[] {
  const crowd = new Map<string, number>();
  for (const { key } of named) crowd.set(key, (crowd.get(key) ?? 0) + 1);
  const rows = named.filter(
    ({ words, key }) => !PLACEHOLDER_NAMES.has(words.join(' ')) && (crowd.get(key) ?? 0) < CROWD,
  );
  const people = rows.map(({ entry }) => entry);
  const parent = people.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const union = (i: number, j: number): void => {
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[b] = a;
  };
  const lastOf = (i: number): string => rows[i]!.words[rows[i]!.words.length - 1]!;
  // Same words in any order: one pass per group of equal keys.
  const sameWords = new Map<string, number>();
  rows.forEach(({ key }, i) => {
    const seen = sameWords.get(key);
    if (seen === undefined) sameWords.set(key, i);
    else union(seen, i);
  });
  // The initial rule, within one first word: only a single-letter last word can match.
  const byFirst = new Map<string, number[]>();
  rows.forEach(({ words }, i) => {
    const bucket = byFirst.get(words[0]!);
    if (bucket) bucket.push(i);
    else byFirst.set(words[0]!, [i]);
  });
  for (const members of byFirst.values()) {
    const singles = members.filter((i) => lastOf(i).length === 1);
    if (singles.length === 0) continue;
    const byInitial = new Map<string, number[]>();
    for (const i of members) {
      const initial = lastOf(i)[0]!;
      const bucket = byInitial.get(initial);
      if (bucket) bucket.push(i);
      else byInitial.set(initial, [i]);
    }
    for (const i of singles) for (const j of byInitial.get(lastOf(i)) ?? []) if (i !== j) union(i, j);
  }
  const groups = new Map<number, ListEntry[]>();
  people.forEach((entry, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), entry]);
  });
  const skipped = new Set(declined.map((ids) => setKey(ids)));
  return [...groups.values()]
    .filter((group) => group.length >= 2)
    .map((group) => ({ key: setKey(group.flatMap((entry) => entry.personIds)), entries: group }))
    .filter((set) => !skipped.has(set.key))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** The participant ids of a set, for `config.declinedMerges`. */
export const personIdsOf = (set: CandidateSet): string[] => set.key.split('\u0000');

/** What one answer of the assistant writes to the config. */
export interface SetAnswer {
  /** Participant ids to merge; empty when fewer than two rows are ticked. */
  merge: string[];
  /** The full set, to remember it as skipped: always, since the person has now answered it. */
  decline: string[];
}

/**
 * Answer one set with the rows still ticked. A merge of a subset also declines the whole set, so
 * the person is not asked about the left-out rows again.
 */
export function answerSet(set: CandidateSet, tickedRowIds: ReadonlySet<string>): SetAnswer {
  const ticked = set.entries.filter((entry) => tickedRowIds.has(entry.id));
  const merge = ticked.length >= 2 ? [...new Set(ticked.flatMap((entry) => entry.personIds))].sort() : [];
  return { merge, decline: personIdsOf(set) };
}
