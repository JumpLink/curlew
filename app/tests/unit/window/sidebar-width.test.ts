import { describe, expect, it } from '@gjsify/unit';

import { parseConfig } from '../../../src/core/config.ts';
import { UI_SETTINGS } from '../../../src/window/settings-map.ts';
import { clampSidebarWidth } from '../../../src/window/sidebar-width.ts';

export default async () => {
  await describe('sidebar width', async () => {
    await it('keeps a wanted width inside 280 and 600', async () => {
      expect(clampSidebarWidth(100, 1600)).toBe(280);
      expect(clampSidebarWidth(450, 1600)).toBe(450);
      expect(clampSidebarWidth(900, 1600)).toBe(600);
    });
    await it('leaves the chat at least 360 pixels', async () => {
      expect(clampSidebarWidth(600, 920)).toBe(560);
      expect(clampSidebarWidth(500, 1280)).toBe(500);
    });
    await it('keeps the floor in a window too narrow for both', async () => {
      expect(clampSidebarWidth(400, 600)).toBe(280);
    });
    await it('rounds to whole pixels and ignores an unknown window width', async () => {
      expect(clampSidebarWidth(333.6, 0)).toBe(334);
    });
    await it('round-trips ui.sidebarWidth through the config', async () => {
      expect(parseConfig('{}').ui.sidebarWidth).toBe(undefined);
      expect(parseConfig('{"ui":{"sidebarWidth":412}}').ui.sidebarWidth).toBe(412);
      expect(() => parseConfig('{"ui":{"sidebarWidth":100}}')).toThrow();
      expect(() => parseConfig('{"ui":{"sidebarWidth":"wide"}}')).toThrow();
      expect(UI_SETTINGS.sidebarWidth.kind).toBe('state');
    });
  });
};
