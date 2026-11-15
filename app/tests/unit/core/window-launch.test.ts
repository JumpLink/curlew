import { describe, expect, it } from '@gjsify/unit';

import { entryArgv, scopedArgv } from '../../../src/core/lib/window-launch.ts';

export default async () => {
  await describe('window launch', async () => {
    await it('drops desktop entry field codes', async () => {
      expect(entryArgv(['curlew', 'window', '%U', '%f'])).toStrictEqual(['curlew', 'window']);
    });

    await it('keeps arguments that merely contain a percent sign', async () => {
      expect(entryArgv(['curlew', '--label=50%', '%%'])).toStrictEqual(['curlew', '--label=50%', '%%']);
    });

    await it('starts the window in a scope of its own', async () => {
      expect(
        scopedArgv('/usr/bin/systemd-run', 'eu.jumplink.curlew', '42', ['curlew', 'window', '%U']),
      ).toStrictEqual([
        '/usr/bin/systemd-run',
        '--user',
        '--scope',
        '--collect',
        '--quiet',
        '--unit=app-eu.jumplink.curlew-42.scope',
        '--',
        'curlew',
        'window',
      ]);
    });
  });
};
