/**
 * The themed tiles of the design packs (ADR 0013, amendment of 2026-11-12): our own loose line
 * drawings, one colour, no traced or embedded artwork. Every pack fills the same thirteen slots of
 * the tile, so they all repeat the way the doodles do: no slot touches the tile's edge.
 */

/** Where a motif sits in the 240 px tile (x, y, rotation); slots 3, 4 and 10 take small fillers. */
export const SLOTS: readonly (readonly [number, number, number])[] = [
  [40, 40, -10],
  [120, 38, 8],
  [200, 44, 14],
  [80, 14, 0],
  [22, 122, 0],
  [78, 124, 0],
  [150, 118, -8],
  [212, 120, 0],
  [40, 200, -6],
  [105, 202, 6],
  [140, 166, 0],
  [172, 204, -4],
  [214, 186, 5],
];

const SPARKLE = 'M0 -10 L2.5 -2.5 L10 0 L2.5 2.5 L0 10 L-2.5 2.5 L-10 0 L-2.5 -2.5 Z';
const HEART = 'M0 12 C-18 -2 -10 -16 0 -6 C10 -16 18 -2 0 12 Z';
const STAR = 'M0 -14 L4 -4 L14 -4 L6 3 L9 13 L0 7 L-9 13 L-6 3 L-14 -4 L-4 -4 Z';
const PINE = 'M0 -16 L9 -4 H4 L12 8 H-12 L-4 -4 H-9 Z M0 8 V16';
const CRESCENT = 'M5 -15 A15 15 0 1 0 15 5 A12 12 0 0 1 5 -15 Z';
const WAVE = 'M-16 0 q4 -6 8 0 t8 0 t8 0 t8 0';

// A penguin in the spirit of Linux's: round, a little fat, a bit smug. Drawn by us, not traced.
const PENGUIN =
  '<ellipse cy="2" rx="12" ry="15"/><path d="M-6 3 C-6 -5 6 -5 6 3 C6 11 -6 11 -6 3 Z M-3 -7 L0 -4 L3 -7 Z M-12 0 Q-18 6 -14 12 M12 0 Q18 6 14 12 M-5 17 H-11 M5 17 H11"/><circle cx="-4" cy="-9" r="1.2"/><circle cx="4" cy="-9" r="1.2"/>';

// A crab in the spirit of Rust's Ferris: two claws, eyes on stalks, a shrug of a smile.
const CRAB =
  '<ellipse cy="3" rx="13" ry="8"/><circle cx="-5" cy="-8" r="2"/><circle cx="5" cy="-8" r="2"/><path d="M-5 -6 V-3 M5 -6 V-3 M-13 1 C-20 1 -20 -10 -13 -10 L-11 -6 M13 1 C20 1 20 -10 13 -10 L11 -6 M-9 10 L-13 15 M-3 11 L-5 16 M3 11 L5 16 M9 10 L13 15 M-3 4 Q0 7 3 4"/>';

const g = (path: string): string => `<path d="${path}"/>`;

/** The motifs of each themed pack, one per slot. */
export const PACK_MOTIFS = {
  forest: [
    g(PINE),
    '<path d="M-14 2 A14 12 0 0 1 14 2 Z M-5 2 V12 H5 V2 M-6 -4 h.1 M4 -6 h.1 M0 -2 h.1"/>',
    g('M0 14 C-14 6 -14 -8 0 -14 C14 -8 14 6 0 14 Z M0 14 V-8 M0 4 L-6 -1 M0 -2 L6 -7'),
    g('M0 9 C-8 4 -8 -5 0 -9 C8 -5 8 4 0 9 Z'),
    g('M-6 -2 H6 C6 8 -6 8 -6 -2 Z M-7 -2 C-7 -9 7 -9 7 -2 M0 -9 V-12'),
    g('M0 16 V-16 M0 10 L-8 4 M0 4 L8 -2 M0 -2 L-8 -8 M0 -8 L7 -13'),
    '<path d="M-10 -8 L-10 -14 L-4 -10 H4 L10 -14 L10 -8 V6 C10 14 -10 14 -10 6 Z M0 1 L-1.5 4 H1.5 Z"/><circle cx="-4" cy="-3" r="3"/><circle cx="4" cy="-3" r="3"/>',
    g('M-14 8 H12 C16 8 16 4 12 4 M-2 8 C-14 8 -14 -10 -2 -10 C10 -10 10 8 -2 8 M-2 -2 a3 3 0 1 1 3 3'),
    '<circle cy="-5" r="10"/><path d="M0 5 V16 M-5 16 H5"/>',
    '<circle cx="-5" cy="-3" r="5"/><circle cx="5" cy="-3" r="5"/><circle cy="5" r="5"/><path d="M0 8 Q2 13 7 15"/>',
    g('M-8 6 C-8 -6 4 -8 8 -8 C8 4 -4 6 -8 6 Z M-8 6 L4 -4'),
    g('M-10 0 A10 9 0 0 1 10 0 Z M-4 0 V9 H4 V0'),
    g('M0 -14 L8 -2 H3 L10 8 H-10 L-3 -2 H-8 Z M0 8 V14'),
  ],
  dusk: [
    g(CRESCENT),
    g('M-16 8 A7 7 0 0 1 -12 -5 A10 10 0 0 1 8 -7 A8 8 0 0 1 14 8 Z'),
    g(STAR),
    g(SPARKLE),
    g(SPARKLE),
    PENGUIN,
    '<circle r="8"/><ellipse rx="17" ry="4" transform="rotate(-20)"/>',
    g('M-14 6 A6 6 0 0 1 -10 -4 A8 8 0 0 1 6 -5 A7 7 0 0 1 12 6 Z'),
    `<g transform="scale(.8)">${g(STAR)}</g>`,
    g(
      'M-16 10 L8 -6 M-14 4 L0 -5 M-10 14 L4 5 M10 -10 L11.5 -5 L16 -4 L11.5 -2.5 L10 2 L8.5 -2.5 L4 -4 L8.5 -5 Z',
    ),
    '<circle r="2"/><circle cx="7" cy="-5" r="1"/><circle cx="-6" cy="5" r="1"/>',
    `<g transform="scale(.8)">${g(CRESCENT)}</g>`,
    g('M0 -13 L3 -3 L13 0 L3 3 L0 13 L-3 3 L-13 0 L-3 -3 Z'),
  ],
  sunrise: [
    '<circle r="6"/><path d="M0 -11 V-15 M0 11 V15 M-11 0 H-15 M11 0 H15 M-8 -8 L-11 -11 M8 8 L11 11 M8 -8 L11 -11 M-8 8 L-11 11"/>',
    g(
      'M0 16 Q3 2 -1 -8 M-1 -8 Q-9 -12 -16 -4 M-1 -8 Q8 -14 16 -6 M-1 -8 Q-6 -16 -14 -16 M-1 -8 Q4 -17 12 -17',
    ),
    g('M-16 -6 q4 -6 8 0 t8 0 t8 0 t8 0 M-16 4 q4 -6 8 0 t8 0 t8 0 t8 0'),
    g('M0 8 C-8 2 -6 -8 2 -8 C8 -6 6 2 0 0'),
    g('M0 -8 L2 -2.5 L8 -2.5 L3.2 1 L5 7 L0 3.5 L-5 7 L-3.2 1 L-8 -2.5 L-2 -2.5 Z'),
    g(
      'M-20 6 H20 M-12 6 A12 12 0 0 1 12 6 M0 -9 V-13 M-11 -3 L-14 -6 M11 -3 L14 -6 M-18 12 q4 -4 8 0 t8 0 t8 0 t8 0',
    ),
    CRAB,
    // A seashell where the owner's wish was a GNOME-style foot: the foot is a trademark, see the ADR.
    g('M-12 8 C-14 -6 -4 -14 0 -14 C4 -14 14 -6 12 8 Z M0 -14 V8 M-6 -11 L-6 8 M6 -11 L6 8'),
    g('M-14 2 Q-7 -8 0 2 Q7 -8 14 2'),
    g('M-16 0 A16 14 0 0 1 16 0 Z M0 0 V15'),
    g('M0 -8 L2 -2.5 L8 -2.5 L3.2 1 L5 7 L0 3.5 L-5 7 L-3.2 1 L-8 -2.5 L-2 -2.5 Z'),
    g('M0 -14 V8 M0 -14 L12 4 H0 M-3 -8 L-10 4 H-3 M-14 10 H14 L10 15 H-10 Z'),
    g(WAVE),
  ],
  rose: [
    g(HEART),
    g('M0 -12 C10 -6 10 6 0 12 C-10 6 -10 -6 0 -12 Z'),
    '<circle r="3"/><circle cx="0" cy="-8" r="4.5"/><circle cx="7.6" cy="-2.5" r="4.5"/><circle cx="4.7" cy="6.5" r="4.5"/><circle cx="-4.7" cy="6.5" r="4.5"/><circle cx="-7.6" cy="-2.5" r="4.5"/>',
    g('M0 7 C-12 -2 -6 -10 0 -4 C6 -10 12 -2 0 7 Z'),
    g('M0 -8 C7 -4 7 4 0 8 C-7 4 -7 -4 0 -8 Z'),
    '<circle r="12"/><path d="M0 -4 a4 4 0 1 1 4 4 a8 8 0 1 1 -8 -8"/>',
    g('M-9 -12 L-9 0 C-9 8 9 8 9 0 L9 -12 L3 -6 L0 -12 L-3 -6 Z M0 8 V16 M0 14 Q8 12 10 6'),
    g(HEART),
    '<circle r="2.5"/><circle cx="0" cy="-7" r="4"/><circle cx="6" cy="-3.5" r="4"/><circle cx="6" cy="3.5" r="4"/><circle cx="0" cy="7" r="4"/><circle cx="-6" cy="3.5" r="4"/><circle cx="-6" cy="-3.5" r="4"/>',
    '<rect x="-16" y="-11" width="32" height="22" rx="3"/><path d="M-16 -8 L0 3 L16 -8"/>',
    g('M0 5 C-7 0 -4 -6 0 -2 C4 -6 7 0 0 5 Z'),
    g(
      'M0 -6 V8 M0 -2 C-6 -12 -16 -10 -12 -2 C-10 4 -4 4 0 -2 M0 -2 C6 -12 16 -10 12 -2 C10 4 4 4 0 -2 M0 -6 L-3 -11 M0 -6 L3 -11',
    ),
    '<g transform="translate(0 -4)"><path d="M-14 -10 h28 a4 4 0 0 1 4 4 v14 a4 4 0 0 1 -4 4 h-12 l-8 8 v-8 h-8 a4 4 0 0 1 -4 -4 v-14 a4 4 0 0 1 4 -4 z"/><path d="M0 8 C-7 3 -4 -3 0 1 C4 -3 7 3 0 8 Z" transform="translate(0 -5) scale(.8)"/></g>',
  ],
  graphite: [
    '<circle r="12"/><circle r="6"/>',
    g('M0 -13 L13 10 H-13 Z'),
    g('M0 -14 L14 0 L0 14 L-14 0 Z'),
    g('M-6 0 H6 M0 -6 V6'),
    '<circle r="4"/>',
    g('M12 0 L6 10.4 L-6 10.4 L-12 0 L-6 -10.4 L6 -10.4 Z M0 0 h.1'),
    g('M-14 6 A14 14 0 0 1 14 6 M-9 6 A9 9 0 0 1 9 6 M-4 6 A4 4 0 0 1 4 6'),
    '<rect x="-11" y="-11" width="22" height="22" rx="6"/>',
    g('M-14 -6 H14 M-14 0 H14 M-14 6 H14'),
    g('M-13 0 A13 13 0 0 1 13 0 Z'),
    g('M0 -7 L7 6 H-7 Z'),
    '<rect x="-12" y="-12" width="24" height="24" rx="2"/><rect x="-6" y="-6" width="12" height="12" rx="1"/>',
    '<circle cx="-5" r="9"/><circle cx="5" r="9"/>',
  ],
} as const;

export type ThemedPattern = keyof typeof PACK_MOTIFS;

/** The thirteen motifs of `pattern` placed on their slots. */
export function themedMotifs(pattern: ThemedPattern): string {
  return PACK_MOTIFS[pattern]
    .map((motif, i) => {
      const [x, y, rotation] = SLOTS[i]!;
      return `<g transform="translate(${x} ${y})${rotation === 0 ? '' : ` rotate(${rotation})`}">${motif}</g>`;
    })
    .join('');
}
