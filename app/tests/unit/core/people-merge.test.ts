import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
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
};
