import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { choiceFor, lookOf, withChoice } from '../../../src/core/contact-choices.ts';
import {
  peopleChoose,
  peopleDecline,
  peopleMerge,
  peoplePin,
  pinFor,
  peopleUnmerge,
  withMerge,
  withoutMerge,
  withPin,
} from '../../../src/core/actions/people.ts';
import { defaultConfig, loadConfig, parseConfig, saveConfig } from '../../../src/core/config.ts';

export default async () => {
  await describe('merging people by hand', async () => {
    await it('joins people into one group and absorbs a group that shares one of them', async () => {
      expect(withMerge([], ['a', 'b'])).toStrictEqual([['a', 'b']]);
      expect(withMerge([['a', 'b']], ['b', 'c'])).toStrictEqual([['a', 'b', 'c']]);
      expect(
        withMerge(
          [
            ['a', 'b'],
            ['x', 'y'],
          ],
          ['b', 'c'],
        ),
      ).toStrictEqual([
        ['x', 'y'],
        ['a', 'b', 'c'],
      ]);
      expect(withMerge([['a', 'b']], ['c'])).toStrictEqual([['a', 'b']]);
    });

    await it('undoes a whole merge when any of its people is named', async () => {
      expect(
        withoutMerge(
          [
            ['a', 'b'],
            ['x', 'y'],
          ],
          ['b'],
        ),
      ).toStrictEqual([['x', 'y']]);
      expect(withoutMerge([['a', 'b']], ['z'])).toStrictEqual([['a', 'b']]);
    });

    await it('keeps the groups in the config file and drops the key when none is left', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-people-'));
      try {
        const path = join(dir, 'config.json');
        saveConfig(defaultConfig(), path);
        peopleMerge(['p-a', 'p-b'], path);
        expect(loadConfig(path).mergedPeople).toStrictEqual([['p-a', 'p-b']]);
        peopleUnmerge(['p-b'], path);
        expect(loadConfig(path).mergedPeople).toStrictEqual([]);
        expect(readFileSync(path, 'utf8').includes('mergedPeople')).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('remembers a skipped set once, whatever the order of its people', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-people-'));
      try {
        const path = join(dir, 'config.json');
        saveConfig(defaultConfig(), path);
        peopleDecline(['p-b', 'p-a'], path);
        peopleDecline(['p-a', 'p-b'], path);
        expect(loadConfig(path).declinedMerges).toStrictEqual([['p-b', 'p-a']]);
        expect(() => parseConfig('{"declinedMerges": [[1]]}')).toThrow(/declinedMerges/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('finds the pin of a person through the merged group, smallest id first', async () => {
      const groups = [['p-a', 'p-b']];
      expect(pinFor(groups, { 'p-b': 'signal' }, ['p-a'])).toBe('signal');
      expect(pinFor(groups, { 'p-a': 'xmpp', 'p-b': 'signal' }, ['p-b'])).toBe('xmpp');
      expect(pinFor(groups, { 'p-b': 'signal' }, ['p-z'])).toBe(null);
      expect(pinFor([], {}, [])).toBe(null);
    });

    await it('pins every id of a person and releases them together', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-people-'));
      try {
        const path = join(dir, 'config.json');
        saveConfig(defaultConfig(), path);
        peoplePin(['p-a', 'p-b'], 'signal', path);
        expect(loadConfig(path).pins).toStrictEqual({ 'p-a': 'signal', 'p-b': 'signal' });
        peoplePin(['p-a'], 'telegram', path);
        expect(loadConfig(path).pins).toStrictEqual({ 'p-a': 'telegram', 'p-b': 'signal' });
        peoplePin(['p-a', 'p-b'], null, path);
        expect(loadConfig(path).pins).toStrictEqual({});
        expect(withPin({ x: 'mail' }, ['y'], 'xmpp')).toStrictEqual({ x: 'mail', y: 'xmpp' });
        expect(() => parseConfig('{"pins": {"p": 3}}')).toThrow(/pins/);
        expect(() => parseConfig('{"pins": []}')).toThrow(/pins/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('refuses a malformed list and deduplicates inside a group', async () => {
      expect(() => parseConfig('{"mergedPeople": "p-a"}')).toThrow();
      expect(() => parseConfig('{"mergedPeople": [["p-a", 3]]}')).toThrow();
      expect(parseConfig('{"mergedPeople": [["p-a", "p-a", "p-b"]]}').mergedPeople).toStrictEqual([
        ['p-a', 'p-b'],
      ]);
    });
  });

  await describe('how a contact looks', async () => {
    await it('stores a choice under the smallest id and finds it from any id of the set', async () => {
      const choices = withChoice({}, ['p-b', 'p-a'], { name: 'c1', own: 'x.png' });
      expect(choices).toStrictEqual({ 'p-a': { name: 'c1', own: 'x.png' } });
      expect(choiceFor(choices, ['p-b', 'p-a'])?.key).toBe('p-a');
      // The choice made for a single person still applies once that person is merged with others.
      expect(choiceFor(choices, ['p-a', 'p-z'])?.choice.name).toBe('c1');
      expect(choiceFor(choices, ['p-q'])).toBeNull();
    });

    await it('patches one field at a time and drops a choice that ends up empty', async () => {
      let choices = withChoice({}, ['p-a'], { name: 'c1', picture: 'c2' });
      choices = withChoice(choices, ['p-a'], { picture: null });
      expect(choices).toStrictEqual({ 'p-a': { name: 'c1' } });
      choices = withChoice(choices, ['p-a'], { name: null });
      expect(choices).toStrictEqual({});
    });

    await it("keeps a chat's look beside its picture and clears it with null", async () => {
      let choices = withChoice({}, ['p-a'], {
        own: 'x.png',
        primary: 'green',
        accent: 'pink',
        background: 'dots',
      });
      expect(lookOf(choiceFor(choices, ['p-a'])?.choice)).toStrictEqual({
        primary: 'green',
        accent: 'pink',
        background: 'dots',
      });
      choices = withChoice(choices, ['p-a'], { primary: null, accent: null, background: null });
      expect(choices).toStrictEqual({ 'p-a': { own: 'x.png' } });
      expect(lookOf(undefined)).toStrictEqual({});
    });

    await it('moves a choice to the new smallest id when people merge', async () => {
      const merged = withChoice({ 'p-b': { name: 'c1' } }, ['p-a', 'p-b'], { picture: 'c2' });
      expect(merged).toStrictEqual({ 'p-a': { name: 'c1', picture: 'c2' } });
    });

    await it('writes, reads back and refuses malformed choices', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-choices-'));
      try {
        const path = join(dir, 'config.json');
        saveConfig(defaultConfig(), path);
        peopleChoose(['p-a', 'p-b'], { name: 'c1', own: 'x.png' }, path);
        expect(loadConfig(path).contactChoices).toStrictEqual({ 'p-a': { name: 'c1', own: 'x.png' } });
        peopleChoose(['p-a', 'p-b'], { name: null, own: null }, path);
        expect(loadConfig(path).contactChoices).toStrictEqual({});
        expect(readFileSync(path, 'utf8')).not.toContain('contactChoices');
        expect(() => parseConfig('{"contactChoices": []}')).toThrow(/contactChoices/);
        expect(() => parseConfig('{"contactChoices": {"p": {"own": "../x.png"}}}')).toThrow(/contactChoices/);
        expect(() => parseConfig('{"contactChoices": {"p": {"name": 3}}}')).toThrow(/contactChoices/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
