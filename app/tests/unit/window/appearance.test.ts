import { describe, expect, it } from '@gjsify/unit';

import { parseConfig } from '../../../src/core/config.ts';
import {
  ACCENT_CHOICES,
  accentToImpose,
  backgroundToShow,
  isAccentChoice,
  mixHex,
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
};
