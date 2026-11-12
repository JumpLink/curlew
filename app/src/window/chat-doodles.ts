/**
 * The tile behind a conversation (ADR 0013): our own line drawings, one colour, drawn at a few
 * percent opacity. No mascot of another project is used, see the ADR for why.
 */

/** Logical size of one tile; it is rendered at twice that and repeats in both directions. */
export const DOODLE_TILE = 240;

// Every motif is drawn around (0, 0) and placed with a transform, none touches the tile's edge.
const MOTIFS = `
<g transform="translate(40 40) rotate(-10)"><path d="M-14 -10 h28 a4 4 0 0 1 4 4 v14 a4 4 0 0 1 -4 4 h-12 l-8 8 v-8 h-8 a4 4 0 0 1 -4 -4 v-14 a4 4 0 0 1 4 -4 z"/></g>
<g transform="translate(120 38) rotate(8)"><path d="M-16 -2 L18 -14 L6 16 L0 4 Z M0 4 L18 -14"/></g>
<g transform="translate(200 44) rotate(14)"><path d="M0 12 C-18 -2 -10 -16 0 -6 C10 -16 18 -2 0 12 Z"/></g>
<g transform="translate(80 14)"><path d="M0 -10 L2.5 -2.5 L10 0 L2.5 2.5 L0 10 L-2.5 2.5 L-10 0 L-2.5 -2.5 Z"/></g>
<g transform="translate(22 122)"><path d="M0 -10 L2.5 -2.5 L10 0 L2.5 2.5 L0 10 L-2.5 2.5 L-10 0 L-2.5 -2.5 Z"/></g>
<g transform="translate(78 124) scale(.75)"><circle cx="-8" cy="-9" r="4"/><path d="M-12 -8 Q-30 -5 -35 9 M-6 -5 C2 -12 18 -7 20 4 C20 13 6 15 -2 11 C-8 7 -7 0 -6 -5 Z M20 4 L30 9 M2 13 V24 M9 13 V24"/></g>
<g transform="translate(150 118) rotate(-8)"><rect x="-16" y="-11" width="32" height="22" rx="3"/><path d="M-16 -8 L0 3 L16 -8"/></g>
<g transform="translate(212 120)"><circle r="5"/><circle r="9.5"/><path d="M0 -14 V-10 M0 10 V14 M-14 0 H-10 M10 0 H14 M-10 -10 L-7 -7 M7 7 L10 10 M10 -10 L7 -7 M-7 7 L-10 10"/></g>
<g transform="translate(40 200) rotate(-6)"><path d="M-4 10 V-10 L8 -13 V7"/><circle cx="-8" cy="10" r="4"/><circle cx="4" cy="7" r="4"/></g>
<g transform="translate(105 202) rotate(6)"><circle r="12"/><path d="M-5 -3 v2 M5 -3 v2 M-6 4 Q0 10 6 4"/></g>
<g transform="translate(140 166)"><path d="M0 -9 L2.2 -2.2 L9 0 L2.2 2.2 L0 9 L-2.2 2.2 L-9 0 L-2.2 -2.2 Z"/></g>
<g transform="translate(172 204) rotate(-4)"><rect x="-15" y="-9" width="30" height="20" rx="3"/><circle cy="1" r="6"/><path d="M-6 -9 L-4 -13 H4 L6 -9"/></g>
<g transform="translate(214 186) rotate(5)"><rect x="-17" y="-12" width="34" height="24" rx="4"/><path d="M-10 -3 L-4 2 L-10 7 M0 7 H9"/></g>`;

// A staggered grid: every second row sits half a step to the side, so the tile repeats without a seam.
const DOTS = Array.from({ length: 6 }, (_row, row) =>
  Array.from(
    { length: 6 },
    (_col, col) => `<circle cx="${20 + col * 40 + (row % 2) * 20}" cy="${20 + row * 40}" r="3"/>`,
  ).join(''),
).join('');

// Two wavelengths per tile and rows 40 apart: the curve starts and ends at the same height, so it joins.
const WAVES = Array.from(
  { length: 6 },
  (_row, row) => `<path d="M0 ${20 + row * 40} q30 -14 60 0 t60 0 t60 0 t60 0"/>`,
).join('');

/** The tile as SVG source with `color` (any CSS colour) as its one colour, at `opacity`. */
export function patternTileSvg(
  pattern: 'doodles' | 'dots' | 'waves',
  color: string,
  opacity: number,
): string {
  const size = DOODLE_TILE;
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${size * 2}" height="${size * 2}" viewBox="0 0 ${size} ${size}">`;
  if (pattern === 'dots') return `${head}<g fill="${color}" fill-opacity="${opacity}">${DOTS}</g></svg>`;
  const body = pattern === 'waves' ? WAVES : MOTIFS;
  return `${head}<g fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`;
}
