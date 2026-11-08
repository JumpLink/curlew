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

/** Whether two names are close enough to ask about; see the module comment for the line. */
export function similarNames(a: string, b: string): boolean {
  const x = nameWords(a);
  const y = nameWords(b);
  if (x.length < 2 || y.length < 2) return false;
  if (x.length === y.length && [...x].sort().join(' ') === [...y].sort().join(' ')) return true;
  const [first, last] = [x[0]!, x[x.length - 1]!];
  const [otherFirst, otherLast] = [y[0]!, y[y.length - 1]!];
  if (first !== otherFirst) return false;
  const initialOf = (short: string, long: string) => short.length === 1 && long.startsWith(short);
  return initialOf(last, otherLast) || initialOf(otherLast, last);
}

/**
 * The sets to ask about: people whose names are similar, chained (Ana Example ~ Ana E. ~ A.
 * Example is one set only where each link holds). Groups and the note to self never appear, a set
 * the person already declined is skipped, and a set that gained someone is a new set.
 */
export function candidateSets(entries: readonly ListEntry[], declined: DeclinedSets = []): CandidateSet[] {
  const people = entries.filter((entry) => entry.kind === 'direct' && entry.personIds.length > 0);
  const parent = people.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      if (similarNames(people[i]!.title, people[j]!.title)) parent[find(j)] = find(i);
    }
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
