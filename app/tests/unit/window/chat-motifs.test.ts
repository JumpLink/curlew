import { describe, expect, it } from '@gjsify/unit';

import { BACKGROUND_CHOICES, DESIGN_PACKS, backgroundToShow } from '../../../src/core/lib/appearance.ts';
import { parseConfig } from '../../../src/core/config.ts';
import { DOODLE_TILE, patternTileSvg, type PatternChoice } from '../../../src/window/chat-doodles.ts';
import { PACK_MOTIFS, SLOTS } from '../../../src/window/chat-motifs.ts';

const drawn = BACKGROUND_CHOICES.filter((choice) => choice !== 'none') as PatternChoice[];

export default async () => {
  await describe('the themed chat backgrounds', async () => {
    await it('gives every pack a pattern that draws something', async () => {
      for (const pack of DESIGN_PACKS) {
        expect(pack.background === 'none').toBe(false);
        expect(backgroundToShow(pack.background)).toBe(pack.background);
        expect(patternTileSvg(pack.background as PatternChoice, 'rgb(1,2,3)', 0.1).length > 200).toBe(true);
      }
    });

    await it('fills every slot of the tile once per themed pack', async () => {
      for (const [name, motifs] of Object.entries(PACK_MOTIFS)) {
        expect(`${name}:${motifs.length}`).toBe(`${name}:${SLOTS.length}`);
      }
    });

    await it('keeps every slot clear of the tile edge so it repeats without a seam', async () => {
      for (const [x, y] of SLOTS) {
        // The slots at the edge (x 22, y 14) hold small fillers, at most 10 px from their centre.
        expect(x >= 20 && x <= DOODLE_TILE - 20).toBe(true);
        expect(y >= 12 && y <= DOODLE_TILE - 20).toBe(true);
      }
    });

    await it('writes well-formed SVG in one colour and none of its own', async () => {
      for (const pattern of drawn) {
        const svg = patternTileSvg(pattern, 'rgb(1,2,3)', 0.1);
        expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
        expect(svg.endsWith('</svg>')).toBe(true);
        expect(svg.split('<g').length).toBe(svg.split('</g>').length);
        expect(svg.split('<').length).toBe(svg.split('>').length);
        expect(svg.includes('viewBox="0 0 240 240"')).toBe(true);
        // The only colour in the file is the one asked for.
        expect(/#[0-9a-fA-F]{3,6}|rgb\((?!1,2,3\))|hsl|url\(|<image|<style/.test(svg)).toBe(false);
      }
    });

    await it('accepts the new backgrounds in the config and still rejects unknown ones', async () => {
      expect(parseConfig('{"backends":{},"ui":{"chatBackground":"forest"}}').ui.chatBackground).toBe(
        'forest',
      );
      expect(
        parseConfig('{"backends":{},"contactChoices":{"p-a":{"background":"sunrise"}}}').contactChoices[
          'p-a'
        ],
      ).toStrictEqual({ background: 'sunrise' });
      let message = '';
      try {
        parseConfig('{"backends":{},"ui":{"chatBackground":"stripes"}}');
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(/chatBackground/.test(message)).toBe(true);
    });
  });
};
