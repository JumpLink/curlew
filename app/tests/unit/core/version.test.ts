import { describe, expect, it } from '@gjsify/unit';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { VERSION } from '../../../src/core/version.ts';

// One number, several files: app/package.json is the source and everything else must follow it,
// or a release ships a window that says one version and a metainfo that says another.

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'app', 'package.json')) && existsSync(join(dir, 'package.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`repo root not found above ${process.cwd()}`);
}

function jsonVersion(path: string): string {
  return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version;
}

export default async () => {
  await describe('the one version', async () => {
    const root = repoRoot();

    await it('is a semantic version and matches app/package.json', async () => {
      expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
      expect(VERSION).toBe(jsonVersion(join(root, 'app', 'package.json')));
    });

    await it('matches the root package.json and every workspace package', async () => {
      expect(jsonVersion(join(root, 'package.json'))).toBe(VERSION);
      for (const name of readdirSync(join(root, 'packages'))) {
        const file = join(root, 'packages', name, 'package.json');
        if (existsSync(file)) expect(`${name} ${jsonVersion(file)}`).toBe(`${name} ${VERSION}`);
      }
    });

    await it('is the newest release in the metainfo', async () => {
      const xml = readFileSync(join(root, 'app', 'data', 'eu.jumplink.curlew.metainfo.xml'), 'utf8');
      const first = /<release\s+version="([^"]+)"/.exec(xml);
      expect(first?.[1]).toBe(VERSION);
    });

    // `gjsify ship` renders its own metainfo from `gjsify.ship` and never reads the hand-written
    // file, so a release missing from the config ships a Flatpak without `<releases>`
    // (flatpak-builder-lint: releases-info-missing).
    await it('lists the metainfo releases in gjsify.ship.releases', async () => {
      const xml = readFileSync(join(root, 'app', 'data', 'eu.jumplink.curlew.metainfo.xml'), 'utf8');
      const fromXml = [...xml.matchAll(/<release\s+version="([^"]+)"\s+date="([^"]+)"/g)].map(
        (m) => `${m[1]} ${m[2]}`,
      );
      const pkg = JSON.parse(readFileSync(join(root, 'app', 'package.json'), 'utf8')) as {
        gjsify: { ship: { releases?: { version: string; date: string }[] } };
      };
      const fromConfig = (pkg.gjsify.ship.releases ?? []).map((r) => `${r.version} ${r.date}`);
      expect(fromConfig).toStrictEqual(fromXml);
    });
  });
};
