/**
 * The unit text `postbote setup` writes, and the file it must not drift from.
 *
 * A built postbote cannot read `contrib/systemd/postbote-daemon.service` at run time — it is a
 * single-file bundle — so the unit text is a TypeScript constant with this machine's paths filled
 * in. The cost of that is a second copy, and this test is the tax: fed the shipped file's own
 * `%h/postbote` placeholders, `renderUnit` must reproduce its directives EXACTLY.
 *
 * The allowed substitutions are therefore exactly these, and the test defines them by
 * construction:
 *
 *   WorkingDirectory={{HOME}}            → %h/postbote          (a checkout at ~/postbote)
 *   Environment=PATH={{PATH}}            → %h/.local/bin:/usr/local/bin:/usr/bin:/bin
 *   ExecStart=/usr/bin/env {{RUNNER}} {{ARGS}}
 *                                       → gjsify run %h/postbote/app/dist/postbote.gjs.mjs daemon
 *
 * Everything else — every other directive, every key, the section order, the `[Unit]` /
 * `[Service]` / `[Install]` split — must match character for character.
 */

import { describe, expect, it } from '@gjsify/unit';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  SHIPPED_UNIT_REL,
  UNIT_NAME,
  renderUnit,
  unitDirectives,
  unitFilePath,
  unitPath,
  unitPathsFor,
} from '../../../src/core/actions/setup-unit.ts';

/**
 * The repo root, found by walking up from the working directory until the shipped unit is
 * there. Not derived from `import.meta.url`: this suite is BUNDLED into `app/dist/test.gjs.mjs`,
 * so that URL names the bundle, not this file, and a path built from it silently points at the
 * wrong tree.
 */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, SHIPPED_UNIT_REL))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(
    `${SHIPPED_UNIT_REL} not found above ${process.cwd()} — this suite must run from inside the checkout`,
  );
}

/** The shipped unit, read from the repo. Its placeholders are what a packager gets. */
function shippedUnit(): string {
  return readFileSync(join(repoRoot(), SHIPPED_UNIT_REL), 'utf8');
}

export default async function setupUnit(): Promise<void> {
  describe('the systemd unit text', () => {
    it('reproduces the shipped unit when fed the shipped placeholders', () => {
      const rendered = renderUnit({
        home: '%h',
        workdir: '%h/postbote',
        runner: 'gjsify',
        args: 'run %h/postbote/app/dist/postbote.gjs.mjs daemon',
      });
      // A diff here is the whole point: a directive added to one file and not the other.
      expect(unitDirectives(rendered).join('\n')).toBe(unitDirectives(shippedUnit()).join('\n'));
    });

    it('changes ONLY the three substituted lines when the paths are real ones', () => {
      const placeholder = unitDirectives(
        renderUnit({
          home: '%h',
          workdir: '%h/postbote',
          runner: 'gjsify',
          args: 'run %h/postbote/app/dist/postbote.gjs.mjs daemon',
        }),
      );
      const real = unitDirectives(
        renderUnit({
          home: '/home/anna',
          workdir: '/srv/postbote',
          runner: '/opt/bin/gjsify',
          args: 'run /srv/postbote/app/dist/postbote.gjs.mjs daemon',
        }),
      );
      expect(real.length).toBe(placeholder.length);
      const changed = real.filter((line, i) => line !== placeholder[i]);
      expect(changed.length).toBe(3);
      expect(changed.join('\n')).toBe(
        [
          'WorkingDirectory=/srv/postbote',
          'Environment=PATH=/opt/bin:/usr/local/bin:/usr/bin:/bin',
          'ExecStart=/usr/bin/env /opt/bin/gjsify run /srv/postbote/app/dist/postbote.gjs.mjs daemon',
        ].join('\n'),
      );
    });

    it('writes the bundle path as an absolute one, not a guess', () => {
      const text = renderUnit({
        home: '/home/anna',
        workdir: '/home/anna/postbote',
        runner: '/home/anna/.local/bin/gjsify',
        args: 'run /home/anna/postbote/app/dist/postbote.gjs.mjs daemon',
      });
      expect(text.includes('ExecStart=/usr/bin/env /home/anna/.local/bin/gjsify run /home/anna/postbote/app/dist/postbote.gjs.mjs daemon')).toBe(true);
    });

    it('runs the plain command in a published install — no bundle, no gjsify', () => {
      const paths = unitPathsFor({ mode: 'published', home: '/home/anna', checkout: null, gjsify: null, bundle: null });
      expect(paths.runner).toBe('postbote');
      expect(paths.args).toBe('daemon');
      expect(renderUnit(paths).includes('ExecStart=/usr/bin/env postbote daemon')).toBe(true);
    });

    it('falls back to the plain command when a checkout has no gjsify or no bundle', () => {
      // Readiness fails on that machine; the unit must still be writable and runnable.
      expect(unitPathsFor({ mode: 'checkout', home: '/h', checkout: '/h/postbote', gjsify: null, bundle: '/b' }).runner).toBe('postbote');
      expect(unitPathsFor({ mode: 'checkout', home: '/h', checkout: '/h/postbote', gjsify: '/g', bundle: null }).runner).toBe('postbote');
    });

    it('gives a user unit a PATH that can find the runner', () => {
      // A bare name needs the directory `gjsify install` puts it in, which a user unit does not
      // inherit from the shell; an absolute one brings its own.
      expect(unitPath('gjsify', '%h')).toBe('%h/.local/bin:/usr/local/bin:/usr/bin:/bin');
      expect(unitPath('/opt/bin/gjsify', '/home/anna')).toBe('/opt/bin:/usr/local/bin:/usr/bin:/bin');
    });

    it('keeps the restart policy the daemon\'s exit code depends on', () => {
      // Exit 2 means every account is logged out; a restart cannot relink a device.
      expect(UNIT_TEMPLATE_LINES().includes('RestartPreventExitStatus=2')).toBe(true);
      expect(UNIT_TEMPLATE_LINES().includes('Restart=on-failure')).toBe(true);
    });

    it('names one unit everywhere', () => {
      expect(UNIT_NAME).toBe('postbote-daemon.service');
      expect(unitFilePath('/home/anna/.config/systemd/user')).toBe(
        '/home/anna/.config/systemd/user/postbote-daemon.service',
      );
    });
  });
}

function UNIT_TEMPLATE_LINES(): string[] {
  return unitDirectives(
    renderUnit({
      home: '%h',
      workdir: '%h/postbote',
      runner: 'gjsify',
      args: 'run %h/postbote/app/dist/postbote.gjs.mjs daemon',
    }),
  );
}
