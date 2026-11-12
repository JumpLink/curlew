import { describe, expect, it } from '@gjsify/unit';

import { parseConfig } from '../../../src/core/config.ts';
import {
  ACCENT_CHOICES,
  accentToImpose,
  ACCENT_NAMES,
  backgroundToShow,
  DESIGN_PACKS,
  isAccentChoice,
  lookClasses,
  lookCss,
  lookOfPack,
  mixHex,
  packOf,
  primaryCss,
  primaryToImpose,
  schemeToImpose,
} from '../../../src/core/lib/appearance.ts';

export default async () => {
  await describe('the accent choice', async () => {
    await it('is Curlew teal unless the person chose otherwise', async () => {
      expect(accentToImpose(undefined)).toBe('teal');
      expect(accentToImpose('default')).toBe('teal');
      expect(accentToImpose('not-a-colour')).toBe('teal');
      expect(accentToImpose('blue')).toBe('blue');
      expect(accentToImpose('green')).toBe('green');
    });

    await it('leaves the desktop accent alone for "system"', async () => {
      expect(accentToImpose('system')).toBe(null);
    });

    await it('knows every choice the preferences offer', async () => {
      expect(ACCENT_CHOICES.every((choice) => isAccentChoice(choice))).toBe(true);
      expect(isAccentChoice('magenta')).toBe(false);
    });

    await it('tints with blue unless the person chose otherwise', async () => {
      expect(primaryToImpose(undefined)).toBe('blue');
      expect(primaryToImpose('default')).toBe('blue');
      expect(primaryToImpose('purple')).toBe('purple');
      expect(primaryToImpose('system')).toBe(null);
    });

    await it('follows the system style unless told otherwise', async () => {
      expect(schemeToImpose(undefined)).toBe('system');
      expect(schemeToImpose('nonsense')).toBe('system');
      expect(schemeToImpose('dark')).toBe('dark');
    });

    await it('mixes a tint into a base colour', async () => {
      expect(mixHex('#000000', [255, 255, 255], 0)).toBe('#000000');
      expect(mixHex('#000000', [255, 255, 255], 1)).toBe('#ffffff');
      expect(mixHex('#ffffff', [0, 0, 0], 0.5)).toBe('#808080');
      const css = primaryCss([53, 132, 228], false);
      expect(/@define-color window_bg_color #[0-9a-f]{6};/.test(css)).toBe(true);
      expect(css.split('\n').length).toBe(7);
    });

    await it('shows the doodles unless the person chose otherwise', async () => {
      expect(backgroundToShow(undefined)).toBe('doodles');
      expect(backgroundToShow('nonsense')).toBe('doodles');
      expect(backgroundToShow('none')).toBe('none');
    });

    await it('is validated in the config', async () => {
      expect(parseConfig('{"backends":{}}').ui.accentColor).toBe(undefined);
      expect(parseConfig('{"backends":{},"ui":{"accentColor":"teal"}}').ui.accentColor).toBe('teal');
      let message = '';
      try {
        parseConfig('{"backends":{},"ui":{"accentColor":"magenta"}}');
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(/accentColor/.test(message)).toBe(true);
      expect(
        parseConfig('{"backends":{},"ui":{"primaryColor":"system","colorScheme":"dark"}}').ui.colorScheme,
      ).toBe('dark');
      let scheme = '';
      try {
        parseConfig('{"backends":{},"ui":{"colorScheme":"sepia"}}');
      } catch (err) {
        scheme = err instanceof Error ? err.message : String(err);
      }
      expect(/colorScheme/.test(scheme)).toBe(true);
      expect(parseConfig('{"backends":{},"ui":{"chatBackground":"none"}}').ui.chatBackground).toBe('none');
      let bad = '';
      try {
        parseConfig('{"backends":{},"ui":{"chatBackground":"stripes"}}');
      } catch (err) {
        bad = err instanceof Error ? err.message : String(err);
      }
      expect(/chatBackground/.test(bad)).toBe(true);
    });
  });

  await describe("a chat's own look", async () => {
    await it('knows the pack its three parts add up to, and only then', async () => {
      for (const pack of DESIGN_PACKS) expect(packOf(lookOfPack(pack))?.id).toBe(pack.id);
      expect(packOf({ primary: 'blue', accent: 'teal' })).toBe(null);
      expect(packOf({ primary: 'blue', accent: 'red', background: 'doodles' })).toBe(null);
      expect(DESIGN_PACKS[0]?.id).toBe('curlew');
    });

    await it('turns a look into the classes its CSS rules hang on', async () => {
      expect(lookClasses({})).toStrictEqual([]);
      expect(lookClasses({ background: 'dots' })).toStrictEqual([]);
      expect(lookClasses({ primary: 'green', accent: 'pink' })).toStrictEqual([
        'look-primary-green',
        'look-accent-pink',
      ]);
    });

    await it('writes rules for every colour in both styles', async () => {
      const colors = Object.fromEntries(ACCENT_NAMES.map((name) => [name, [10, 20, 30] as const]));
      for (const dark of [false, true]) {
        const css = lookCss(colors as Parameters<typeof lookCss>[0], dark);
        for (const name of ACCENT_NAMES) {
          expect(css.includes(`.look-accent-${name} .curlew-own`)).toBe(true);
          expect(css.includes(`toolbarview.look-primary-${name}`)).toBe(true);
        }
      }
    });

    await it('is validated in the config', async () => {
      const parse = (choice: string) =>
        parseConfig(`{"backends":{},"contactChoices":{"p-a":${choice}}}`).contactChoices['p-a'];
      expect(parse('{"primary":"green","accent":"pink","background":"waves"}')).toStrictEqual({
        primary: 'green',
        accent: 'pink',
        background: 'waves',
      });
      for (const bad of ['{"accent":"system"}', '{"primary":"magenta"}', '{"background":"stripes"}']) {
        let message = '';
        try {
          parse(bad);
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        expect(/contactChoices/.test(message)).toBe(true);
      }
    });
  });
};
