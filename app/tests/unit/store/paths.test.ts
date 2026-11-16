import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';

import {
  attachmentsDir,
  dataDir,
  defaultStoreDirs,
  indexDbPath,
  previewsDir,
  storePaths,
  xdgDataHome,
} from '@curlew/store';

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
      // A naming rule of this repo: account files are found by the suffix and existing indexes
      // carry it. (The libgda wrapper once appended `.db` itself; the libsqlite3 one does not.)
      expect(indexDbPath({ CURLEW_DB_PATH: '/tmp/mine.sqlite' })).toBe('/tmp/mine.sqlite.db');
      expect(indexDbPath({ CURLEW_DB_PATH: '/tmp/mine' })).toBe('/tmp/mine.db');
      expect(indexDbPath({ CURLEW_DB_PATH: '/tmp/mine.db' })).toBe('/tmp/mine.db');
    });
  });

  await describe('previewsDir', async () => {
    await it('lives under the cache home, apart from the data', async () => {
      expect(previewsDir({ XDG_CACHE_HOME: '/c' })).toBe('/c/curlew/previews');
      expect(previewsDir({ XDG_CACHE_HOME: 'relative' }).endsWith('/.cache/curlew/previews')).toBe(true);
    });

    await it('is overridable', async () => {
      expect(previewsDir({ CURLEW_PREVIEWS_DIR: '/p', XDG_CACHE_HOME: '/c' })).toBe('/p');
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

  await describe('storePaths (injected directories)', async () => {
    const dirs = { data: '/sandbox/files', cache: '/sandbox/cache', config: '/sandbox/config' };

    await it('derives everything from the given directories, with no ambient environment', async () => {
      const p = storePaths(dirs);
      expect(p.dataDir).toBe('/sandbox/files');
      expect(p.indexDbPath).toBe('/sandbox/files/index.db');
      expect(p.secretsDir).toBe('/sandbox/files/secrets');
      expect(p.contactPicturesDir).toBe('/sandbox/files/contact-pictures');
      expect(p.attachmentsDir).toBe('/sandbox/files/attachments');
      expect(p.previewsDir).toBe('/sandbox/cache/previews');
      expect(p.avatarsDir).toBe('/sandbox/cache/avatars');
      expect(p.sendStagingDir).toBe('/sandbox/cache/outgoing');
      expect(p.configPath).toBe('/sandbox/config/config.json');
    });

    await it('ignores XDG variables entirely', async () => {
      const before = process.env.XDG_DATA_HOME;
      process.env.XDG_DATA_HOME = '/should/not/matter';
      try {
        expect(storePaths(dirs).indexDbPath).toBe('/sandbox/files/index.db');
      } finally {
        if (before === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = before;
      }
    });

    await it('uses the download directory for attachments when given', async () => {
      expect(storePaths({ ...dirs, download: '/sandbox/dl' }).attachmentsDir).toBe('/sandbox/dl');
    });

    await it('still honours explicit CURLEW_* overrides', async () => {
      const p = storePaths(dirs, { CURLEW_SECRETS_DIR: '/s', CURLEW_DB_PATH: '/x/idx' });
      expect(p.secretsDir).toBe('/s');
      expect(p.indexDbPath).toBe('/x/idx.db');
    });

    await it('is what the desktop functions resolve through', async () => {
      const env = { XDG_DATA_HOME: '/d', XDG_CACHE_HOME: '/c', XDG_CONFIG_HOME: '/f' };
      const dirs = defaultStoreDirs(env);
      expect(dirs.data).toBe('/d/curlew');
      expect(dirs.cache).toBe('/c/curlew');
      expect(dirs.config).toBe('/f/curlew');
      expect(dirs.download).toBe(undefined);
      expect(indexDbPath(env)).toBe(storePaths(defaultStoreDirs(env), env).indexDbPath);
    });
  });
};
