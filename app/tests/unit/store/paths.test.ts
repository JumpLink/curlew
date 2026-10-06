import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';

import { attachmentsDir, configPath, dataDir, homeSubdir, indexDbPath, xdgDataHome } from '@curlew/store';

// Every function here takes its environment as a parameter, so the promise these tests check —
// nothing is EVER written inside the repository — is checkable without touching the real one.
export default async () => {
  await describe('xdgDataHome', async () => {
    await it('honours an absolute XDG_DATA_HOME', async () => {
      expect(xdgDataHome({ XDG_DATA_HOME: '/custom/data' })).toBe('/custom/data');
    });

    await it('ignores a RELATIVE XDG_DATA_HOME, per the spec', async () => {
      // A relative value must be treated as unset. Honouring it would resolve against the
      // current directory — which, run from a checkout, is the repository.
      expect(xdgDataHome({ XDG_DATA_HOME: 'relative/path' }).startsWith('/')).toBe(true);
      expect(xdgDataHome({ XDG_DATA_HOME: '' }).endsWith('/.local/share')).toBe(true);
    });

    await it('defaults to ~/.local/share', async () => {
      expect(xdgDataHome({}).endsWith('/.local/share')).toBe(true);
    });
  });

  await describe('dataDir', async () => {
    await it('is always absolute and outside any checkout', async () => {
      // A temporary XDG_DATA_HOME, so the answer never depends on what the real home holds.
      const home = mkdtempSync(join(tmpdir(), 'curlew-paths-'));
      expect(dataDir({ XDG_DATA_HOME: home }).startsWith('/')).toBe(true);
      expect(dataDir({ XDG_DATA_HOME: home }).endsWith('/curlew')).toBe(true);
    });

    await it('follows XDG_DATA_HOME', async () => {
      expect(dataDir({ XDG_DATA_HOME: '/custom/data' })).toBe('/custom/data/curlew');
    });

    await it('can be overridden wholesale', async () => {
      expect(dataDir({ CURLEW_DATA_DIR: '/srv/curlew' })).toBe('/srv/curlew');
    });
  });

  await describe('indexDbPath', async () => {
    await it('defaults inside the data directory', async () => {
      expect(indexDbPath({ XDG_DATA_HOME: '/custom/data' })).toBe('/custom/data/curlew/index.db');
    });

    await it('FORCES a .db suffix onto an override', async () => {
      // Not cosmetic. gjsify's node:sqlite is a libgda wrapper, and libgda appends `.db` to
      // whatever it is given — so `index.sqlite` lands on disk as `index.sqlite.db`, and the
      // next open makes `index.sqlite.db.db`.
      expect(indexDbPath({ CURLEW_DB_PATH: '/tmp/mine.sqlite' })).toBe('/tmp/mine.sqlite.db');
      expect(indexDbPath({ CURLEW_DB_PATH: '/tmp/mine' })).toBe('/tmp/mine.db');
      expect(indexDbPath({ CURLEW_DB_PATH: '/tmp/mine.db' })).toBe('/tmp/mine.db');
    });
  });

  await describe('attachmentsDir', async () => {
    await it('prefers the download directory when one is set', async () => {
      expect(attachmentsDir({ XDG_DOWNLOAD_DIR: '/home/u/Downloads' })).toBe('/home/u/Downloads');
    });

    await it('falls back inside the data directory', async () => {
      expect(attachmentsDir({ XDG_DATA_HOME: '/custom/data' })).toBe('/custom/data/curlew/attachments');
    });

    await it('lets an explicit override win over the download directory', async () => {
      expect(
        attachmentsDir({ XDG_DOWNLOAD_DIR: '/home/u/Downloads', CURLEW_ATTACHMENTS_DIR: '/mnt/mail' }),
      ).toBe('/mnt/mail');
    });

    await it('ignores a relative XDG_DOWNLOAD_DIR', async () => {
      expect(attachmentsDir({ XDG_DOWNLOAD_DIR: 'Downloads', XDG_DATA_HOME: '/d' })).toBe(
        '/d/curlew/attachments',
      );
    });
  });

  // The rename fallback is load-bearing: delivery-only messages in the old directory are the only
  // copy, so an install that has ONLY `postbote/` keeps reading and writing there.
  await describe('the postbote → curlew rename fallback', async () => {
    const fresh = () => mkdtempSync(join(tmpdir(), 'curlew-rename-'));

    await it('a fresh install (neither directory) gets curlew/', async () => {
      const data = fresh();
      expect(dataDir({ XDG_DATA_HOME: data })).toBe(join(data, 'curlew'));
      expect(configPath({ XDG_CONFIG_HOME: data })).toBe(join(data, 'curlew', 'config.json'));
    });

    await it('an old install (only postbote/) keeps using it, and never grows a second directory', async () => {
      const data = fresh();
      mkdirSync(join(data, 'postbote'));
      expect(dataDir({ XDG_DATA_HOME: data })).toBe(join(data, 'postbote'));
      expect(indexDbPath({ XDG_DATA_HOME: data })).toBe(join(data, 'postbote', 'index.db'));
      expect(configPath({ XDG_CONFIG_HOME: data })).toBe(join(data, 'postbote', 'config.json'));
      expect(homeSubdir(data)).toBe(join(data, 'postbote'));
    });

    await it('curlew/ wins when both exist', async () => {
      const data = fresh();
      mkdirSync(join(data, 'postbote'));
      mkdirSync(join(data, 'curlew'));
      expect(dataDir({ XDG_DATA_HOME: data })).toBe(join(data, 'curlew'));
    });

    await it('the old POSTBOTE_* variables are still read, the new ones win', async () => {
      expect(dataDir({ POSTBOTE_DATA_DIR: '/old' })).toBe('/old');
      expect(dataDir({ POSTBOTE_DATA_DIR: '/old', CURLEW_DATA_DIR: '/new' })).toBe('/new');
      expect(configPath({ POSTBOTE_CONFIG: '/old.json' })).toBe('/old.json');
    });
  });
};
