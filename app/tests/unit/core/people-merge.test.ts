import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { peopleMerge, peopleUnmerge, withMerge, withoutMerge } from '../../../src/core/actions/people.ts';
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

    await it('refuses a malformed list and deduplicates inside a group', async () => {
      expect(() => parseConfig('{"mergedPeople": "p-a"}')).toThrow();
      expect(() => parseConfig('{"mergedPeople": [["p-a", 3]]}')).toThrow();
      expect(parseConfig('{"mergedPeople": [["p-a", "p-a", "p-b"]]}').mergedPeople).toStrictEqual([
        ['p-a', 'p-b'],
      ]);
    });
  });
};
