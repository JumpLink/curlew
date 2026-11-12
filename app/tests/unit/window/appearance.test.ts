import { describe, expect, it } from '@gjsify/unit';

import { parseConfig } from '../../../src/core/config.ts';
import {
  ACCENT_CHOICES,
  accentToImpose,
  backgroundToShow,
  isAccentChoice,
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
