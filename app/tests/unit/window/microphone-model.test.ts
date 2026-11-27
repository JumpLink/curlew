import { describe, expect, it } from '@gjsify/unit';

import { parseConfig } from '../../../src/core/config.ts';
import {
  activeMicMode,
  DEFAULT_MIC_MODE,
  MIC_MODE_KEY,
  micLayout,
  micLook,
  offeredModes,
} from '../../../src/window/microphone-model.ts';
import { UI_SETTINGS } from '../../../src/window/settings-map.ts';

export default async () => {
  await describe('microphone model', async () => {
    await it('offers only what this chat and this machine can do', async () => {
      expect(offeredModes({ voice: true, dictate: true })).toStrictEqual(['voice', 'dictate']);
      expect(offeredModes({ voice: true, dictate: false })).toStrictEqual(['voice']);
      expect(offeredModes({ voice: false, dictate: true })).toStrictEqual(['dictate']);
      expect(offeredModes({ voice: false, dictate: false })).toStrictEqual([]);
    });

    await it('starts on a voice message', async () => {
      expect(DEFAULT_MIC_MODE).toBe('voice');
      expect(activeMicMode(undefined, ['voice', 'dictate'])).toBe('voice');
    });

    await it('runs the remembered mode while it is offered', async () => {
      expect(activeMicMode('dictate', ['voice', 'dictate'])).toBe('dictate');
    });

    await it('falls back to the mode that is left, and to none', async () => {
      expect(activeMicMode('dictate', ['voice'])).toBe('voice');
      expect(activeMicMode('voice', ['dictate'])).toBe('dictate');
      expect(activeMicMode('voice', [])).toBe(null);
      expect(activeMicMode(undefined, ['dictate'])).toBe('dictate');
    });

    await it('is a split button with two modes, a plain one with one, hidden with none', async () => {
      expect(micLayout(['voice', 'dictate'])).toBe('split');
      expect(micLayout(['dictate'])).toBe('button');
      expect(micLayout([])).toBe('none');
    });

    await it('gives each mode its own icon and a label naming it', async () => {
      const voice = micLook('voice');
      const dictate = micLook('dictate');
      expect(voice.icon).not.toBe(dictate.icon);
      expect(dictate.icon).toBe('dictate-symbolic');
      expect(voice.label).not.toBe(dictate.label);
    });

    await it('persists the choice as ui.micMode and refuses a stranger', async () => {
      expect(parseConfig('{}').ui.micMode).toBe(undefined);
      expect(parseConfig(`{"ui":{"${MIC_MODE_KEY}":"dictate"}}`).ui.micMode).toBe('dictate');
      expect(() => parseConfig(`{"ui":{"${MIC_MODE_KEY}":"shout"}}`)).toThrow();
      expect(UI_SETTINGS.micMode.kind).toBe('state');
    });
  });
};
