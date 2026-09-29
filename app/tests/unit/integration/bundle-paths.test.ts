import { describe, expect, it } from '@gjsify/unit';

import { countOccurrences, findBakedAddonPaths } from '../../integration/bundle-paths.mjs';

// The relocation probe's verdict on a built bundle is exactly this function's return value, and
// the whole point of the probe is that the gap stays VISIBLE until gjsify fixes the bundler. A
// detector that quietly stopped matching would turn that into a green CI run and a shipped
// bundle nobody can move — so the pattern is pinned here, against a planted absolute path and
// against the shapes that must NOT trip it.
export default async () => {
  await describe('findBakedAddonPaths', async () => {
    await it('catches a planted absolute addon path', async () => {
      const planted = '/build/tree/node_modules/@signalapp/libsignal-client/prebuilds/linux-x64/a.node';
      expect(findBakedAddonPaths(`loadAddon(\`${planted}\`)`)).toStrictEqual([planted]);
    });

    await it('finds each distinct path once, however often it is baked in', async () => {
      const path = '/srv/app/node_modules/pkg/prebuilds/linux-x64/pkg.node';
      // The bundler emits the path twice: once for the load, once for `load.path`.
      expect(findBakedAddonPaths(`${path} ${path} ${path}`)).toStrictEqual([path]);
    });

    await it('ignores a relative prebuild path', async () => {
      // What the fix is expected to bake in: relative to the bundle, resolvable at load time.
      expect(findBakedAddonPaths('loadAddon(`prebuilds/linux-x64/pkg.node`)')).toHaveLength(0);
      expect(findBakedAddonPaths('loadAddon(`./prebuilds/linux-x64/pkg.node`)')).toHaveLength(0);
      expect(findBakedAddonPaths('loadAddon(`${dir}/node_modules/`)')).toHaveLength(0);
    });

    await it('ignores a bundle with no addon at all', async () => {
      expect(findBakedAddonPaths('const g = () => 1; export { g };')).toHaveLength(0);
    });
  });

  await describe('countOccurrences', async () => {
    await it('counts non-overlapping matches', async () => {
      expect(countOccurrences('/a/b /a/b /a/b', '/a/b')).toBe(3);
      // Overlapping is not a real case for a path, but a naive indexOf(1) would say 5.
      expect(countOccurrences('aaaa', 'aa')).toBe(2);
    });

    await it('reports 0 for an absent or empty needle', async () => {
      expect(countOccurrences('/a/b', '/c')).toBe(0);
      expect(countOccurrences('/a/b', '')).toBe(0);
    });
  });
};
