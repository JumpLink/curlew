/**
 * The synthetic index behind demo mode: a few accounts, a few dozen conversations with reactions,
 * edits, replies, voice notes and pictures, and the config that switches the protocols on. Every
 * name and address is made up (`example.org`, `example.invalid`), every picture is drawn and every
 * voice is a speech synthesiser; nothing here reads or resembles a real index.
 *
 * `generateDemo(dir)` writes `<dir>/index.db`, `<dir>/config.json` and `<dir>/previews/`. The window
 * bundle calls it for `CURLEW_DEMO=1`; `app/scripts/demo-index.ts` is a thin wrapper for Node.
 */

import { migrate, openIndexDb } from '@curlew/store';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEMO_ACCOUNTS } from './accounts.ts';
import { demoClip, scenePng, speak, writeBytes, type Scene, type Speech } from './media.ts';

/** Bump when the generated content changes: an older stamp makes `prepareDemo` regenerate. */
export const DEMO_VERSION = 1;

export interface DemoSummary {
  conversations: number;
  messages: number;
  attachments: number;
  reactions: number;
}

type Row = [
  id: string,
  backend: string,
  account: string,
  kind: string,
  title: string,
  minutesAgo: number,
  unread: number,
];

const CONVERSATIONS: Row[] = [
  ['c1', 'signal', 'signal-demo1', 'direct', 'Alex Weber', 4, 2],
  ['c2', 'matrix', 'matrix-demo1', 'group', 'GNOME Design', 18, 14],
  ['c3', 'mail', 'mail-demo1', 'direct', 'Sam Fischer', 52, 1],
  ['c4', 'whatsapp', 'whatsapp-demo1', 'group', 'Climbing Tuesday', 95, 0],
  ['c5', 'xmpp', 'xmpp-demo1', 'direct', 'Jo Klein', 180, 0],
  ['c6', 'signal', 'signal-demo1', 'group', 'Family', 60 * 20, 0],
  ['c7', 'mail', 'mail-demo1', 'direct', 'Kim Becker', 60 * 30, 0],
  ['c8', 'matrix', 'matrix-demo1', 'direct', 'Dana Wolf', 60 * 50, 0],
  ['c9', 'whatsapp', 'whatsapp-demo1', 'direct', 'Lee Hoffmann', 60 * 80, 0],
  ['c10', 'xmpp', 'xmpp-demo1', 'group', 'Book club', 60 * 120, 0],
  ['c11', 'mail', 'mail-demo1', 'direct', 'Monitoring Alerts', 60 * 200, 0],
  ['c13', 'matrix', 'matrix-demo1', 'group', 'Release planning', 25, 0],
  ['c14', 'matrix', 'matrix-demo1', 'group', 'Security team', 35, 0],
  ['c16', 'telegram', 'telegram-demo1', 'direct', 'Alex Weber', 3, 0],
  ['c15', 'whatsapp', 'whatsapp-demo1', 'direct', 'Robin', 7, 0],
  ['c12', 'signal', 'signal-0b8e1c2a-1111-4222-8333-444455556666', 'direct', '', 5, 0],
  ['c17', 'signal', 'signal-demo1', 'direct', 'Lena ❤️', 20, 1],
  ['c18', 'matrix', 'matrix-demo1', 'group', '#libadwaita:gnome.org', 40, 3],
  ['c19', 'matrix', 'matrix-demo1', 'group', '#typescript:matrix.org', 70, 0],
  ['c20', 'matrix', 'matrix-demo1', 'group', 'gjsify', 55, 1],
  ['c21', 'signal', 'signal-demo1', 'direct', 'Max 🎮', 30, 0],
  ['c22', 'signal', 'signal-demo1', 'group', 'WG Hinterhof', 45, 5],
  ['c24', 'xmpp', 'xmpp-demo1', 'direct', 'Sam Fischer', 60 * 8, 0],
  ['c25', 'telegram', 'telegram-demo1', 'direct', 'Ida Roth', 60 * 9, 0],
  ['c23', 'telegram', 'telegram-demo1', 'group', 'Hafenmeister', 60 * 6, 2],
];

const ALEX_SIGNAL = '1f0c6a52-2222-4333-8444-555566667777';

/** id, name, then the addresses the person has, by kind. */
const PEOPLE: Array<[id: string, name: string, addresses: Array<[kind: string, value: string]>]> = [
  ['p-sam', 'Sam Fischer', [['email', 'sam@example.org']]],
  ['p-robin-wa', 'Robin', [['whatsapp', '4915100000000@s.whatsapp.net']]],
  ['p-sam-xmpp', 'Sam Fischer', [['jid', 'sam@chat.example.org']]],
  ['p-ida', 'Ida Roth', [['telegram', '515151']]],
  ['p-jo', 'Jo Klein', [['jid', 'jo@chat.example.org']]],
  [
    'p-alex',
    'Alex Weber',
    [
      ['signal', ALEX_SIGNAL],
      ['telegram', '424242'],
    ],
  ],
  ['p-mia', 'Mia Schulz', [['matrix', '@mia:example.org']]],
  ['p-noah', 'Noah Braun', [['matrix', '@noah:example.org']]],
  ['p-alerts', 'Monitoring Alerts', [['email', 'alerts@example.org']]],
  ['p-lena', 'Lena ❤️', [['signal', '2a9b7c10-3333-4444-8555-666677778888']]],
  ['p-max', 'Max 🎮', [['signal', '3b8a6d21-4444-4555-8666-777788889999']]],
  ['p-mama', 'Mama', [['signal', '4c7b5e32-5555-4666-8777-88889999aaaa']]],
  ['p-tom', 'Tom', [['signal', '5d6a4f43-6666-4777-8888-9999aaaabbbb']]],
  ['p-nele', 'Nele', [['signal', '6e593054-7777-4888-8999-aaaabbbbcccc']]],
  ['p-ben', 'Ben', [['signal', '7f482165-8888-4999-8aaa-bbbbccccdddd']]],
  ['p-yuki', 'Yuki', [['signal', '80391276-9999-4aaa-8bbb-ccccddddeeee']]],
  ['p-hannah', 'Hannah', [['matrix', '@hannah:example.org']]],
  ['p-carlos', 'Carlos', [['matrix', '@carlos:example.org']]],
  ['p-priya', 'Priya', [['matrix', '@priya:example.org']]],
  ['p-dana', 'Dana Wolf', [['matrix', '@dana:example.org']]],
  ['p-kim', 'Kim Becker', [['email', 'kim@example.org']]],
  ['p-lee', 'Lee Hoffmann', [['whatsapp', '4915100000001@s.whatsapp.net']]],
  ['p-jonas', 'Jonas', [['whatsapp', '4915100000002@s.whatsapp.net']]],
  ['p-ruth', 'Ruth', [['jid', 'ruth@chat.example.org']]],
  ['p-harbour', 'Hafenmeister', [['telegram', '777001']]],
];

const KIND_OF_BACKEND: Record<string, string> = {
  mail: 'email',
  xmpp: 'jid',
  signal: 'signal',
  matrix: 'matrix',
  telegram: 'telegram',
  whatsapp: 'whatsapp',
};

type Att =
  | { kind: 'image'; name: string; scene: Scene; w: number; h: number }
  | { kind: 'video'; name: string; pattern?: 'testsrc' | 'smptebars' }
  | { kind: 'voice'; speech: Speech; name?: string }
  | { kind: 'file'; name: string; mime: string; size: number };

interface Opts {
  subject?: string;
  reply?: number;
  thread?: number;
  /** Minutes ago the message was last edited. */
  edited?: number;
  /** Own messages: read by the other side (true) or only delivered (false). */
  read?: boolean;
  react?: Array<[who: string, emoji: string]>;
  att?: Att[];
  group?: string;
  emailChat?: boolean;
}

interface Msg extends Opts {
  n: number;
  conv: string;
  who: string;
  ago: number;
  text: string;
}

const h = (hours: number): number => hours * 60;
const d = (days: number): number => days * 1440;

const speech = (text: string, voice: string, pitch = 50, speed = 160): Speech => ({
  text,
  voice,
  pitch,
  speed,
});

function story(): Msg[] {
  const rows: Msg[] = [];
  let seq = 0;
  const add = (conv: string, who: string, ago: number, text: string, o: Opts = {}): number => {
    const n = ++seq;
    rows.push({ n, conv, who, ago, text, ...o });
    return n;
  };

  // c1 — Alex on Signal.
  add('c1', 'p-alex', h(5), 'Are you coming to the harbour on Sunday?');
  add('c1', 'me', h(5) - 2, 'Yes, I would love to.', { read: true });
  add(
    'c1',
    'p-alex',
    h(4),
    'Great! I will send you the **route**: https://example.org/harbour-walk (about ~~one~~ two hours, `easy`).',
  );
  const bring = add('c1', 'me', h(3), 'I will bring coffee ☕ and something sweet', {
    read: true,
    react: [['p-alex', '❤️']],
  });
  add('c1', 'p-alex', 12, 'Haha perfect. Bring the camera too 📷', { reply: bring });
  add('c1', 'p-alex', 4, 'And the weather will be 🌞', { react: [['', '👍']] });

  // c16 — Alex on Telegram: the picture, clip, voice note and album cases.
  add('c16', 'p-alex', 6, 'Here is the route, it is a nice walk.');
  const thanks = add('c16', 'me', 5, 'Perfect, thank you!', { read: true });
  add('c16', 'p-alex', 4.2, '', {
    att: [{ kind: 'image', name: 'harbour.png', scene: 'harbour', w: 480, h: 320 }],
    react: [
      ['', '😍'],
      ['p-sam', '😍'],
    ],
  });
  add('c16', 'p-alex', 3, 'See you at ten at the lighthouse.', { reply: thanks });
  add('c16', 'p-alex', 2, '', { att: [{ kind: 'video', name: 'harbour.mp4' }] });
  add('c16', 'p-alex', 1.5, '', {
    att: [
      {
        kind: 'voice',
        speech: speech('Hey, quick one: I will be a few minutes late, start without me!', 'en-gb+m2', 45),
      },
    ],
    react: [
      ['p-alex', '👍'],
      ['', '👍'],
      ['p-sam', '❤️'],
    ],
  });
  const album: Array<[number, number, Scene]> = [
    [480, 320, 'harbour'],
    [320, 480, 'mountain'],
    [480, 320, 'sunset'],
    [480, 360, 'cat'],
  ];
  album.forEach(([w, ht, scene], i) =>
    add('c16', 'p-alex', 1 - i / 60, '', {
      group: 'demo-album',
      att: [{ kind: 'image', name: `walk-${i + 1}.png`, scene, w, h: ht }],
    }),
  );

  // c25 — short on purpose: a picture and a voice note, each with reactions under the bubble.
  add('c25', 'p-ida', h(9) + 6, 'Look what the harbour looked like this morning.');
  add('c25', 'p-ida', h(9) + 5, '', {
    att: [{ kind: 'image', name: 'harbour-morning.png', scene: 'harbour', w: 480, h: 320 }],
    react: [
      ['', '😍'],
      ['p-sam', '😍'],
    ],
  });
  add('c25', 'p-ida', h(9) + 3, '', {
    att: [
      {
        kind: 'voice',
        speech: speech('See you at ten at the lighthouse, I bring the coffee!', 'en-gb+f3', 55),
      },
    ],
    react: [
      ['', '👍'],
      ['p-sam', '❤️'],
    ],
  });

  // c17 — the partner, on Signal.
  add('c17', 'p-lena', d(1) + h(10), 'Good morning, my favourite person ☀️');
  add('c17', 'me', d(1) + h(10) - 3, 'Morning you 😘 did you sleep well?', { read: true });
  add('c17', 'p-lena', d(1) + h(6), '', {
    att: [
      {
        kind: 'voice',
        speech: speech('I miss you already. Come home soon, okay?', 'en+f3', 60, 150),
      },
    ],
  });
  add('c17', 'p-lena', h(3), 'Beach tonight 🌅 would be so nice with you here', {
    att: [{ kind: 'image', name: 'beach-sunset.png', scene: 'sunset', w: 480, h: 320 }],
  });
  add('c17', 'me', h(3) - 1, '😍😍😍', { read: true, react: [['p-lena', '❤️']] });
  add('c17', 'p-lena', h(2), '❤️❤️❤️❤️❤️🥰🥰😘');
  add('c17', 'me', 50, 'I love you. See you soon!', { read: true });
  add('c17', 'me', 30, 'Shall I bring pizza?', { read: false });
  add('c17', 'p-lena', 20, 'Yes please, the one with artichokes 🍕');

  // c18 — a public tech room: code, links, reactions, a quoted thread.
  const q = add(
    'c18',
    'p-hannah',
    h(5),
    'Is there a way to read the accent colour from `AdwStyleManager` in 1.6?',
  );
  add(
    'c18',
    'p-carlos',
    h(5) - 4,
    'Yep: `Adw.StyleManager.get_default().get_accent_color()`, it returns an `Adw.AccentColor`.',
    {
      reply: q,
      react: [
        ['p-hannah', '👍'],
        ['p-priya', '👍'],
      ],
    },
  );
  const snippet = add(
    'c18',
    'p-carlos',
    h(5) - 6,
    'Small example:\n\n```js\nconst style = Adw.StyleManager.get_default();\nstyle.connect("notify::accent-color", () => {\n  print(style.accent_color_rgba.to_string());\n});\n```',
    { react: [['p-hannah', '🎉']] },
  );
  add(
    'c18',
    'p-priya',
    h(3),
    'Docs live at https://gnome.pages.gitlab.gnome.org/libadwaita/doc/main/ if anyone needs them',
    {
      react: [
        ['p-hannah', '🙏'],
        ['p-carlos', '🙏'],
        ['', '🙏'],
      ],
    },
  );
  add('c18', 'p-hannah', 80, 'Works, thanks both! Sorry for the noise 😅', { reply: snippet, thread: q });
  add('c18', 'p-priya', 50, 'No noise at all, that is what the room is for.', { thread: q });
  add('c18', 'p-hannah', 40, 'Anyone tried `AdwToolbarView` with a bottom bar on mobile yet?');

  // c19 — a TypeScript room.
  const sat = add(
    'c19',
    'p-noah',
    h(8),
    'why does `satisfies` not narrow here?\n\n```ts\nconst cfg = { mode: "dark" } satisfies { mode: string };\n```',
  );
  add(
    'c19',
    'p-mia',
    h(8) - 5,
    'It checks, it does not narrow. Use `as const` if you want the literal: `{ mode: "dark" } as const`.',
    {
      reply: sat,
      react: [['p-noah', '💡']],
    },
  );
  add('c19', 'p-noah', h(8) - 9, 'ahhh of course. thank you!', { edited: h(8) - 10 });
  add(
    'c19',
    'p-mia',
    120,
    'TIL: `using` declarations work in 5.2 now 🎉 https://example.org/ts-using-notes',
    {
      react: [
        ['', '🎉'],
        ['p-noah', '🎉'],
      ],
    },
  );
  add('c19', 'me', 70, 'Nice, the cleanup in `finally` was getting old.', { read: true });

  // c20 — a GJS / gjsify room.
  const ui = add('c20', 'p-mia', h(26), 'How do I load a `.ui` file with `Gtk.Template` under gjsify?');
  add(
    'c20',
    'p-noah',
    h(25),
    'Same as plain GJS: `@GObject.registerClass({ Template: "resource:///…" }, class …)`.\nThe bundler copies the resource for you.',
    {
      reply: ui,
    },
  );
  add('c20', 'me', h(2), 'Works, and the hot reload on save is a joy 🚀', {
    read: true,
    react: [['p-mia', '🚀']],
    edited: h(2) - 4,
  });
  add('c20', 'p-noah', 55, 'btw `node:sqlite` now runs on libgda, so no native addon needed');

  // c21 — Max and the SNES.
  add('c21', 'p-max', d(2) + h(3), 'Digga, hab gestern endlich Super Metroid auf 100% 🤯');
  const show = add('c21', 'me', d(2) + h(3) - 2, 'WAS?! Zeig!!', { read: true });
  add('c21', 'p-max', d(2) + h(2), 'Beweisfoto', {
    reply: show,
    att: [{ kind: 'image', name: 'screenshot.png', scene: 'snes', w: 480, h: 320 }],
    react: [['', '🔥']],
  });
  add('c21', 'me', d(2) + h(2) - 5, 'Ok respect. Is Chrono Trigger next?', { read: true });
  const voice = add('c21', 'p-max', d(1) + h(9), '', {
    att: [
      {
        kind: 'voice',
        speech: speech(
          'Hey, Chrono Trigger has the best story ever, but Zelda, A Link to the Past, saved my childhood!',
          'en+m3',
          35,
          170,
        ),
      },
    ],
  });
  add('c21', 'me', d(1) + h(8), 'All I am saying: the Master Sword and the Dark World soundtrack 🎵', {
    read: true,
    reply: voice,
    react: [['p-max', '🔥']],
  });
  add('c21', 'p-max', d(1) + h(2), '↪ Forwarded from Jo: New Super Metroid speedrun time: 0:47:12 😱');
  add('c21', 'p-max', h(5), '', { att: [{ kind: 'video', name: 'boss-fight.mp4', pattern: 'smptebars' }] });
  add('c21', 'p-max', h(4), 'Retro night on Saturday? I will bring the SNES Mini 🎮', { edited: h(4) - 3 });
  add('c21', 'me', h(3), '', {
    read: true,
    att: [
      {
        kind: 'voice',
        speech: speech(
          'Saturday works for me! I will bring the snacks and the good controllers.',
          'en-us',
          55,
        ),
      },
    ],
  });
  add('c21', 'p-max', 90, '📍 Arcade Pixel, Harbour Street 12 (geo:54.3233,10.1228)');
  add('c21', 'p-max', 45, 'sram-backup.srm', {
    att: [{ kind: 'file', name: 'sram-backup.srm', mime: 'application/octet-stream', size: 8192 }],
  });
  add('c21', 'me', 30, 'Perfect, see you Saturday 🕹️', { read: false });

  // c22 — the flatmates: poll-like threads, a cat.
  const poll = add(
    'c22',
    'p-nele',
    d(1) + h(2),
    'Poll: who is in for the cleaning on Saturday? 🧹  👍 = yes, 👎 = no',
    {
      react: [
        ['p-ben', '👍'],
        ['p-yuki', '👍'],
        ['', '👍'],
        ['p-nele', '👍'],
      ],
    },
  );
  add('c22', 'p-ben', d(1) + h(1), 'I can only come after 2 pm', { reply: poll });
  add('c22', 'p-yuki', h(20), 'Bin duty this week: Ben. Next: me 🗑️');
  const paper = add('c22', 'p-nele', h(6), 'Who is buying toilet paper?');
  add('c22', 'me', h(6) - 1, 'ME 🧻', { read: true, reply: paper, react: [['p-nele', '🙏']] });
  add('c22', 'p-nele', 90, 'Poll 2: pizza or kebab night?', {
    react: [
      ['p-ben', '🍕'],
      ['p-yuki', '🍕'],
      ['', '🍕'],
      ['p-nele', '🥙'],
    ],
  });
  add('c22', 'p-yuki', 60, 'Who let the cat in 😂', {
    att: [{ kind: 'image', name: 'cat.png', scene: 'cat', w: 480, h: 360 }],
    react: [['p-ben', '😂']],
  });
  add('c22', 'p-ben', 45, 'That was me. She asked.');

  // c23 — a Telegram channel-like thread.
  add(
    'c23',
    'p-harbour',
    d(3),
    'The ferry pier stays closed until Friday. Replacement service from the west mole.',
  );
  add(
    'c23',
    'p-harbour',
    d(2),
    '↪ Forwarded from Weather Service: wind force 8 from the north-west, easing from the evening. https://example.org/weather',
  );
  add('c23', 'p-harbour', d(1), '', {
    att: [{ kind: 'image', name: 'mole.png', scene: 'mountain', w: 480, h: 320 }],
  });
  add(
    'c23',
    'p-harbour',
    h(6),
    [
      'Dear harbour community,',
      'the summer season is coming to an end, and we would like to thank everyone who helped: setting up the festival, painting the bollards and collecting the driftwood after the storm.',
      'Three dates are coming up in autumn: hauling out the boats on the first weekend, the work day at the west mole and the annual meeting in the clubhouse. The invitation follows separately.',
      'Please remember to close the power and water stations after use. The keys for the showers are still with the harbour master.',
      'If you still have photos from the festival, send them to the channel. We will turn them into a small gallery for the clubhouse.',
      'Thanks, and see you soon by the water!',
    ].join('\n\n'),
    {
      react: [
        ['', '❤️'],
        ['p-alex', '👏'],
      ],
    },
  );
  add('c23', 'p-harbour', 80, 'Erinnerung: Jahresversammlung am Freitag, 19 Uhr.');

  // c6 — the family: a long letter, a voice note, a picture.
  add('c6', 'p-tom', h(30), 'Fotos vom Sonntag 🏔️', {
    att: [{ kind: 'image', name: 'sonntag.png', scene: 'mountain', w: 480, h: 320 }],
    react: [
      ['p-mama', '❤️'],
      ['', '😍'],
    ],
  });
  add(
    'c6',
    'p-mama',
    h(26),
    [
      'Dear all,',
      "a quick note on the plan for the weekend: we meet at Grandma's around one on Saturday. I will make potato soup, and Dad is bringing the cake he praised so much last week.",
      'Tom, please remember the chairs from the cellar, eleven people are coming this time. And Robin, if you still have the photos from the harbour, bring them on your phone, Grandma really wants to see them.',
      'If one of you can bring milk and bread on the way, that would be great. I wrote it on the list, but I will surely forget it again.',
      'See you Saturday, I am looking forward to it!',
    ].join('\n\n'),
  );
  add('c6', 'me', h(25), 'Will do 👍', { read: true, react: [['p-mama', '❤️']] });
  add('c6', 'p-mama', h(21), '', {
    att: [
      {
        kind: 'voice',
        speech: speech('Hello everyone, do not forget the milk, okay? See you Saturday!', 'en+f1', 55, 150),
      },
    ],
  });

  // c4 — climbing, on WhatsApp.
  add('c4', 'p-lee', h(30), 'Bouldering gym again on Tuesday? 🧗');
  add('c4', 'p-jonas', h(29), 'I am in, but from 7 pm', { react: [['p-lee', '👍']] });
  const route = add('c4', 'p-lee', h(4), 'The new blue route on the overhang is mean 😤', {
    att: [{ kind: 'image', name: 'wall.png', scene: 'mountain', w: 480, h: 320 }],
  });
  add('c4', 'me', 95, 'I will try it on Tuesday, promise', { read: true, reply: route });

  // c9 — Lee.
  add('c9', 'p-lee', d(4), 'Do you still have my rope?');
  add('c9', 'me', d(3) + h(20), 'Yep, I will bring it on Tuesday', { read: true });
  add('c9', 'p-lee', h(80) / 60 + 80, 'Thank you 🙏', { react: [['', '👍']] });

  // c5 — Jo on XMPP, now with code, a reaction and an edit.
  add('c5', 'p-jo', 200, 'Did the new release build on your machine?');
  const green = add('c5', 'me', 190, 'It did, the tests are green on both runtimes.', {
    read: true,
    react: [['p-jo', '🎉']],
  });
  add('c5', 'p-jo', 180, 'Nice, then I will tag it tonight.', { reply: green, edited: 175 });

  // c10 — a book club.
  add('c10', 'p-ruth', h(130), 'Next book: “The Wall”? Or something lighter?');
  add('c10', 'p-jo', h(125), 'Something lighter, please 😅', { react: [['p-ruth', '😂']] });
  add('c10', 'me', 120, 'I vote for a crime novel. Just in time for autumn.', { read: true });

  // c15 — a note to oneself on WhatsApp.
  add('c15', 'me', 9, 'Remember: passport renewal appointment');
  add('c15', 'me', 7, 'https://example.org/forms/passport');

  // c13, c14 — work rooms.
  add('c13', 'p-mia', 60, 'Draft of the release notes is in the pad.');
  add('c13', 'p-noah', 40, 'Can we ship it with the next release?', { react: [['p-mia', '👍']] });
  add('c13', 'p-mia', 25, 'Yes, freeze is on Thursday.');
  add('c14', 'p-mia', 55, 'Key rotation checklist is ready.');
  add('c14', 'p-mia', 35, 'Rotating the keys on Friday.', { react: [['', '🔑']] });

  // c8 — Dana.
  add('c8', 'p-dana', h(52), 'Do you have a minute for a call?');
  add('c8', 'me', h(50), 'Tomorrow morning, does that work?', { read: true });

  // c12 — a note in the Signal self chat.
  add('c12', 'me', 6, 'Buy oat milk and stamps');

  // c2 — the design room: the icon draft, a question.
  add('c2', 'p-mia', 120, 'Here is the new icon draft.');
  add('c2', 'p-mia', 119, 'I made the corners a bit rounder.', {
    att: [{ kind: 'image', name: 'icon-draft.png', scene: 'icon', w: 480, h: 320 }],
  });
  add('c2', 'me', 100, 'Looks great, thanks!', { read: true, react: [['p-mia', '🙌']] });
  add('c2', 'p-noah', 30, 'Can we ship it with the next release?');
  add('c2', 'p-mia', 18, 'Noah, what do you think?');

  // c24 — the same Sam on XMPP; the config merges it with the email chat c3.
  add('c24', 'p-sam-xmpp', h(8), 'The ladder is in the shed, key is under the pot.');
  add('c24', 'me', h(8) - 3, 'Thanks, picking it up on the way.', { read: true });

  // c3 — an email chat (Delta Chat style) with a picture and a PDF in one mail.
  const chat = { subject: 'Chat: Garden day', emailChat: true };
  add('c3', 'p-sam', h(26), 'Are we still on for the garden day on Saturday?', chat);
  add('c3', 'me', h(25), 'Yes! I will bring the seedlings and some coffee.', chat);
  add('c3', 'p-sam', 70, 'Great. Could you also bring the long ladder?', chat);
  add('c3', 'me', 60, 'Sure, it fits in the car.', chat);
  add('c3', 'p-sam', 52, 'Perfect, see you at ten.', chat);
  add('c3', 'p-sam', 40, 'Here is the plan for the beds, and the invoice for the seedlings.', {
    ...chat,
    att: [
      { kind: 'image', name: 'garden-beds.png', scene: 'garden', w: 480, h: 320 },
      { kind: 'file', name: 'seedlings-invoice.pdf', mime: 'application/pdf', size: 48_200 },
    ],
  });

  // c7 — an ordinary mail thread.
  add(
    'c7',
    'p-kim',
    h(80),
    'Hi Robin, attached is the invoice for the logo package. Get in touch if you have questions.',
    {
      subject: 'Invoice logo package',
    },
  );
  add('c7', 'me', h(60), 'Thank you, I will transfer it by Friday.', { subject: 'Re: Invoice logo package' });
  add(
    'c7',
    'p-kim',
    h(30),
    'Great, thanks! One more thing: we are planning a small workshop on open-source design in autumn.\n\nWould you like to talk for 20 minutes about your experience with icon drafts?\n\nVery relaxed, with coffee and cake.',
    { subject: 'Re: Invoice logo package' },
  );

  // c11 — a long mail conversation for the paging and the faded long body.
  const paragraph = (k: number) =>
    `Paragraph ${k}: the nightly check of service ${k % 7} on host-${k}.example.org finished with warnings. ` +
    'The queue depth stayed above the soft limit for several minutes and the retry counter rose twice. ' +
    'No action is required unless the same warning appears again within the next hour.';
  for (let i = 0; i < 130; i++) {
    const long = i % 9 === 0 || i % 13 === 0;
    const text = long
      ? Array.from({ length: i % 13 === 0 ? 14 : 6 }, (_, k) => paragraph(i + k)).join('\n\n')
      : `Check ${i} on host-${i % 12}.example.org: all services healthy.`;
    add('c11', 'p-alerts', 60 * 200 + (129 - i) * 55, text, {
      subject: i % 20 < 10 ? 'Nightly report' : 'Disk usage warning',
    });
  }
  return rows;
}

function previewKey(account: string, parts: Array<string | number>): string {
  return createHash('sha256')
    .update([account, ...parts].join('\u0000'))
    .digest('hex');
}

/** Write the whole demo into `dir`, replacing an earlier one. Never touches anything else there. */
export function generateDemo(dir: string, now: number = Date.now()): DemoSummary {
  mkdirSync(dir, { recursive: true });
  for (const name of ['index.db', 'index.db-wal', 'index.db-shm', 'config.json', 'demo.json'])
    rmSync(join(dir, name), { force: true });
  rmSync(join(dir, 'previews'), { recursive: true, force: true });
  rmSync(join(dir, '.work'), { recursive: true, force: true });

  const stamp = new Date(now).toISOString();
  const terms = stamp;
  const config = {
    backends: {
      mail: { enabled: true },
      xmpp: { enabled: true },
      signal: { enabled: true, termsAcceptedAt: terms },
      matrix: { enabled: true, termsAcceptedAt: terms },
      telegram: { enabled: true, termsAcceptedAt: terms },
      whatsapp: { enabled: true, termsAcceptedAt: terms },
    },
    ui: { welcomeDone: true, ai: true, showAllEmails: true, notifications: 'preview' },
    mailAccounts: { 'mail-demo1': { deltaChat: true } },
    // Sam on email (Delta Chat) and on XMPP is one contact.
    mergedPeople: [['p-sam', 'p-sam-xmpp']],
    // A few agent-access rules, so the dialog shows a contact rule and a whole-account rule.
    agentAccess: {
      askWithoutRule: true,
      rules: [
        { account: 'xmpp-demo1', contact: 'jo@chat.example.org', read: 'allow', write: 'ask' },
        { account: 'mail-demo1', read: 'allow', write: 'deny' },
        { account: 'signal-demo1', write: 'ask' },
      ],
    },
  };
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);

  const summary: DemoSummary = {
    conversations: CONVERSATIONS.length,
    messages: 0,
    attachments: 0,
    reactions: 0,
  };
  const images = new Map<string, Buffer>();
  const clips = new Map<string, Buffer | null>();
  const db = openIndexDb(join(dir, 'index.db'));
  try {
    migrate(db);
    const account = db.prepare('INSERT OR REPLACE INTO accounts (id, identity, provider) VALUES (?, ?, ?)');
    for (const a of DEMO_ACCOUNTS) account.run(a.id, a.identity, a.provider);
    db.prepare(`UPDATE accounts SET address = ? WHERE id = 'whatsapp-demo1'`).run(
      '4915100000000@s.whatsapp.net',
    );

    const conversation = db.prepare(
      `INSERT OR REPLACE INTO conversations (id, backend, account_id, kind, title, classification,
         classification_reason, first_message_at, last_message_at, message_count, unread_count)
       VALUES (?, ?, ?, ?, ?, 'conversational', 'default', ?, ?, 0, ?)`,
    );
    for (const [id, backend, acc, kind, title, minutesAgo, unread] of CONVERSATIONS) {
      const at = new Date(now - minutesAgo * 60_000).toISOString();
      conversation.run(id, backend, acc, kind, title, at, at, unread);
    }

    const cursor = db.prepare(
      `INSERT OR REPLACE INTO chat_cursors (conversation_id, backend, account_id, chat_id, kind,
         room_public, room_encrypted, room_members) VALUES (?, 'matrix', 'matrix-demo1', ?, ?, ?, ?, ?)`,
    );
    cursor.run('c2', '!design:example.org', 'group', 1, 0, 14);
    cursor.run('c13', '!planning:example.org', 'group', 0, 0, 6);
    cursor.run('c14', '!security:example.org', 'group', 0, 1, 4);
    cursor.run('c8', '!dana:example.org', 'direct', 0, 0, 2);
    cursor.run('c18', '!libadwaita:example.org', 'group', 1, 0, 2310);
    cursor.run('c19', '!typescript:example.org', 'group', 1, 0, 8420);
    cursor.run('c20', '!gjsify:example.org', 'group', 1, 0, 184);

    const participant = db.prepare('INSERT OR REPLACE INTO participants (id, display_name) VALUES (?, ?)');
    const address = db.prepare(
      'INSERT OR REPLACE INTO participant_addresses (participant_id, kind, value) VALUES (?, ?, ?)',
    );
    const member = db.prepare(
      'INSERT OR REPLACE INTO conversation_participants (conversation_id, participant_id) VALUES (?, ?)',
    );
    for (const [id, name, addresses] of PEOPLE) {
      participant.run(id, name);
      for (const [kind, value] of addresses) address.run(id, kind, value);
    }

    const message = db.prepare(
      `INSERT OR REPLACE INTO conversation_messages (id, conversation_id, backend, account_id, presentation,
         sender_participant_id, sender_name, sender_kind, sender_address, from_self, sent_at, subject, seen,
         classification, classification_reason, remote_id, body, email_chat, folder_path, uid, remote_seq,
         edited_at, reply_to_remote_id, thread_remote_id, peer_read, group_id, has_attachments)
       VALUES (?, ?, ?, ?, 'bubble', ?, ?, ?, ?, ?, ?, ?, 1, 'conversational', 'default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // A mail body lives once, in the FTS table, and a chat body on its row with a sequence —
    // the same split a real sync writes, so the view reads both the way it does in use.
    const mailRow = db.prepare(
      `INSERT OR REPLACE INTO messages (id, account_id, folder_path, uid, subject, date, seen, indexed_at)
       VALUES (?, ?, 'INBOX', ?, ?, ?, 1, ?)`,
    );
    const mailBody = db.prepare(
      'INSERT OR REPLACE INTO messages_fts (rowid, subject, body) VALUES (?, ?, ?)',
    );
    const mailAttach = db.prepare(
      'INSERT OR REPLACE INTO attachments (message_id, section, filename, mime_type, size) VALUES (?, ?, ?, ?, ?)',
    );
    const chatAttach = db.prepare(
      `INSERT OR REPLACE INTO message_attachments (message_id, idx, filename, mime_type, size, kind, width, height, duration_ms, handle)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'demo-handle')`,
    );
    const reaction = db.prepare(
      'INSERT OR REPLACE INTO message_reactions (message_id, reactor, emoji) VALUES (?, ?, ?)',
    );

    const rows = story();
    const byConversation = new Map(CONVERSATIONS.map((c) => [c[0], c]));
    const members = new Set<string>();
    for (const row of rows) {
      const conv = byConversation.get(row.conv)!;
      const [, backend, acc] = conv;
      const mail = backend === 'mail';
      const fromSelf = row.who === 'me';

      // Pictures, voices and clips first: a message that would be empty without them is dropped when
      // ffmpeg or espeak-ng is missing.
      const resolved: Array<{
        name: string;
        mime: string;
        kind: string;
        bytes: Buffer | null;
        w: number | null;
        h: number | null;
        ms: number | null;
        size: number;
      }> = [];
      for (const att of row.att ?? []) {
        if (att.kind === 'image') {
          const k = `${att.scene}:${att.w}x${att.h}`;
          let bytes = images.get(k);
          if (!bytes) images.set(k, (bytes = scenePng(att.scene, att.w, att.h)));
          resolved.push({
            name: att.name,
            mime: 'image/png',
            kind: 'image',
            bytes,
            w: att.w,
            h: att.h,
            ms: null,
            size: bytes.length,
          });
        } else if (att.kind === 'video') {
          const pattern = att.pattern ?? 'testsrc';
          if (!clips.has(pattern)) clips.set(pattern, demoClip(dir, pattern));
          const bytes = clips.get(pattern);
          if (bytes)
            resolved.push({
              name: att.name,
              mime: 'video/mp4',
              kind: 'video',
              bytes,
              w: 320,
              h: 240,
              ms: 3000,
              size: bytes.length,
            });
        } else if (att.kind === 'voice') {
          const voice = speak(dir, att.speech);
          if (voice)
            resolved.push({
              name: att.name ?? 'voice-note.ogg',
              mime: 'audio/ogg',
              kind: 'voice',
              bytes: voice.bytes,
              w: null,
              h: null,
              ms: voice.durationMs,
              size: voice.bytes.length,
            });
        } else {
          resolved.push({
            name: att.name,
            mime: att.mime,
            kind: 'file',
            bytes: null,
            w: null,
            h: null,
            ms: null,
            size: att.size,
          });
        }
      }
      if (!row.text && resolved.length === 0) continue;

      const person = fromSelf ? undefined : PEOPLE.find(([id]) => id === row.who);
      if (!fromSelf && !person) throw new Error(`demo: unknown person ${row.who}`);
      const wanted = KIND_OF_BACKEND[backend];
      const addr = person ? (person[2].find(([kind]) => kind === wanted) ?? person[2][0]) : undefined;
      if (person && !members.has(`${row.conv}/${row.who}`)) {
        members.add(`${row.conv}/${row.who}`);
        member.run(row.conv, row.who);
      }

      const at = new Date(now - row.ago * 60_000).toISOString();
      const n = row.n;
      const subject = row.subject ?? null;
      if (mail) {
        mailRow.run(n, acc, n, subject, at, at);
        mailBody.run(n, subject, row.text);
      }
      message.run(
        `m${n}`,
        row.conv,
        backend,
        acc,
        person ? person[0] : null,
        person ? person[1] : null,
        addr ? addr[0] : null,
        addr ? addr[1] : null,
        fromSelf ? 1 : 0,
        at,
        subject,
        `r${n}`,
        mail ? null : row.text,
        mail && (row.emailChat ?? false) ? 1 : 0,
        mail ? 'INBOX' : null,
        mail ? n : null,
        mail ? null : n,
        row.edited === undefined ? null : new Date(now - row.edited * 60_000).toISOString(),
        row.reply === undefined ? null : `r${row.reply}`,
        row.thread === undefined ? null : `r${row.thread}`,
        fromSelf && row.read !== undefined ? (row.read ? 1 : 0) : null,
        row.group ?? null,
        resolved.length > 0 ? 1 : 0,
      );
      summary.messages++;

      resolved.forEach((att, idx) => {
        summary.attachments++;
        if (mail) {
          const section = String(idx + 2);
          mailAttach.run(n, section, att.name, att.mime, att.size);
          if (att.bytes)
            writeBytes(join(dir, 'previews', previewKey(acc, ['INBOX', n, section]), att.name), att.bytes);
        } else {
          chatAttach.run(`m${n}`, idx, att.name, att.mime, att.size, att.kind, att.w, att.h, att.ms);
          if (att.bytes)
            writeBytes(join(dir, 'previews', previewKey(acc, ['', '', `r${n}`, idx]), att.name), att.bytes);
        }
      });
      for (const [who, emoji] of row.react ?? []) {
        reaction.run(`m${n}`, who, emoji);
        summary.reactions++;
      }
    }

    // The list reads these from the conversation row; they follow the messages written above.
    db.exec(
      `UPDATE conversations SET
         first_message_at = (SELECT MIN(sent_at) FROM conversation_messages WHERE conversation_id = conversations.id),
         last_message_at = (SELECT MAX(sent_at) FROM conversation_messages WHERE conversation_id = conversations.id),
         message_count = (SELECT COUNT(*) FROM conversation_messages WHERE conversation_id = conversations.id)
       WHERE EXISTS (SELECT 1 FROM conversation_messages WHERE conversation_id = conversations.id)`,
    );
  } finally {
    db.close();
  }
  rmSync(join(dir, '.work'), { recursive: true, force: true });
  writeFileSync(join(dir, 'demo.json'), `${JSON.stringify({ version: DEMO_VERSION, generatedAt: stamp })}\n`);
  return summary;
}
