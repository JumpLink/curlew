/**
 * Pictures, voice notes and a clip for the demo index, made on the spot so the demo needs no file
 * and no network. Pictures are drawn pixel by pixel; speech comes from `espeak-ng` and the clip
 * from `ffmpeg`, both optional: without them the demo simply has fewer attachments.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

type Rgb = [number, number, number];

export type Scene = 'harbour' | 'sunset' | 'snes' | 'mountain' | 'cat' | 'icon' | 'garden';

const mix = (a: Rgb, b: Rgb, t: number): Rgb => {
  const k = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
};

/** Coarser colour steps deflate far better and look like a compressed phone photo anyway. */
const quantize = (c: Rgb): Rgb => [
  Math.min(255, Math.round(c[0] / 5) * 5),
  Math.min(255, Math.round(c[1] / 5) * 5),
  Math.min(255, Math.round(c[2] / 5) * 5),
];

/** One of the demo pictures, as PNG bytes. */
export function scenePng(scene: Scene, width: number, height: number): Buffer {
  switch (scene) {
    case 'harbour':
      return harbourScene(width, height);
    case 'sunset':
      return sunsetScene(width, height);
    case 'snes':
      return snesScene(width, height);
    case 'mountain':
      return mountainScene(width, height);
    case 'cat':
      return catScene(width, height);
    case 'icon':
      return iconScene(width, height);
    case 'garden':
      return demoPng(width, height);
  }
}

/** A harbour at dusk: sky, sun, sea and a lighthouse. */
function harbourScene(width: number, height: number): Buffer {
  const horizon = Math.round(height * 0.62);
  const towerX = Math.round(width * 0.68);
  const top = horizon - Math.round(height * 0.36);
  const unit = Math.max(2, Math.round(height / 13));
  return demoPng(width, height, (x, y) => {
    const half = Math.round(height * 0.03) + Math.round(((y - top) / (horizon - top)) * height * 0.015);
    if (y < horizon && y > top && Math.abs(x - towerX) <= half)
      return Math.floor((y - top) / unit) % 2 === 0 ? [236, 236, 240] : [196, 64, 56];
    if (y <= top && y > top - unit / 2 && Math.abs(x - towerX) <= half + 3) return [60, 60, 70];
    if (y < horizon) {
      if (Math.hypot(x - width * 0.3, y - horizon * 0.8) < height * 0.08) return [255, 224, 150];
      return mix([88, 112, 178], [250, 176, 120], y / horizon);
    }
    const lean = (y - horizon) / (height * 0.5);
    const ripple = Math.sin(x / 9 + y / 3) * 6 * Math.max(lean, 0.1);
    const base = mix([234, 150, 118], [26, 52, 98], lean * 1.6);
    return [base[0] + ripple, base[1] + ripple, base[2] + ripple].map((v) =>
      Math.max(0, Math.min(255, Math.round(v))),
    ) as Rgb;
  });
}

/** A beach at sunset: violet sky, a sun on the water, its glitter and a strip of sand. */
function sunsetScene(width: number, height: number): Buffer {
  const horizon = Math.round(height * 0.55);
  const sand = Math.round(height * 0.84);
  return demoPng(width, height, (x, y) => {
    if (y >= sand) {
      const wet = (y - sand) / (height - sand);
      return mix([196, 150, 120], [226, 190, 150], wet + Math.sin(x / 17) * 0.04);
    }
    const sunX = width * 0.55;
    if (y < horizon) {
      const d = Math.hypot(x - sunX, (y - horizon * 0.92) * 1.1);
      if (d < height * 0.1) return [255, 236, 180];
      const glow = Math.max(0, 1 - d / (height * 0.5));
      return mix(mix([60, 44, 110], [244, 128, 96], y / horizon), [255, 190, 120], glow * 0.7);
    }
    const t = (y - horizon) / (sand - horizon);
    const base = mix([232, 140, 112], [40, 40, 96], t * 1.3);
    const glitter = Math.abs(x - sunX) < 8 + t * 60 && Math.sin(y * 1.7 + x / 5) > 0.55 - t * 0.2;
    return glitter ? [255, 214, 160] : mix(base, [255, 255, 255], 0.04 * Math.sin(x / 7 + y));
  });
}

/** A side-scrolling game screen in chunky pixels: clouds, hills, a block row, a hero. */
function snesScene(width: number, height: number): Buffer {
  const scale = Math.max(2, Math.round(width / 64));
  const cols = Math.ceil(width / scale);
  const rows = Math.ceil(height / scale);
  const ground = rows - 7;
  const hero = [
    '..rrrr..',
    '.rrrrrrr',
    '.ssssdd.',
    'sdsssddd',
    '.ssssss.',
    '..bbbb..',
    '.bbbbbb.',
    '.bb..bb.',
    'dd....dd',
  ];
  const colours: Record<string, Rgb> = {
    r: [216, 40, 40],
    s: [244, 192, 140],
    d: [96, 56, 32],
    b: [40, 80, 216],
  };
  return demoPng(width, height, (px, py) => {
    const x = Math.floor(px / scale);
    const y = Math.floor(py / scale);
    const hx = Math.floor(cols * 0.28);
    const hy = ground - hero.length;
    if (x >= hx && x < hx + 8 && y >= hy && y < hy + hero.length) {
      const c = hero[y - hy]![x - hx]!;
      if (c !== '.') return colours[c]!;
    }
    if (y === Math.floor(rows * 0.3) && x >= cols * 0.55 && x < cols * 0.55 + 5)
      return (x + y) % 2 === 0 ? [232, 168, 40] : [160, 100, 20];
    if (y >= ground) return (x + Math.floor(y / 2)) % 4 === 0 ? [120, 60, 30] : [184, 100, 48];
    if (y === ground - 1) return [64, 176, 64];
    const hill = ground - 3 - Math.round(Math.sin(x / 7) * 3 + 3);
    if (y > hill) return y % 3 === 0 ? [52, 150, 60] : [72, 184, 80];
    const cloud =
      (Math.abs(x - cols * 0.7) < 5 && Math.abs(y - rows * 0.16) < 2) ||
      (Math.abs(x - cols * 0.2) < 4 && Math.abs(y - rows * 0.22) < 1);
    return cloud ? [250, 250, 255] : mix([92, 148, 252], [172, 212, 255], y / ground);
  });
}

/** Three ridges of blue mountains with snow on the tallest peaks. */
function mountainScene(width: number, height: number): Buffer {
  const ridge = (x: number, seed: number, base: number, amp: number): number =>
    base -
    amp * (0.55 + 0.3 * Math.sin(x / (width / 5) + seed) + 0.15 * Math.sin(x / (width / 17) + seed * 3));
  return demoPng(width, height, (x, y) => {
    const far = ridge(x, 1.2, height * 0.55, height * 0.4);
    const mid = ridge(x, 4.1, height * 0.72, height * 0.38);
    const near = ridge(x, 7.7, height * 0.9, height * 0.3);
    if (y > near) return mix([34, 64, 52], [20, 40, 36], (y - near) / (height - near));
    if (y > mid) return mix([84, 112, 150], [52, 76, 118], (y - mid) / (near - mid));
    if (y > far)
      return y - far < height * 0.07
        ? [244, 246, 250]
        : mix([140, 164, 200], [98, 126, 170], (y - far) / (mid - far));
    return mix([120, 170, 236], [226, 238, 250], y / far);
  });
}

/** An orange cat on a floor in front of a window. */
function catScene(width: number, height: number): Buffer {
  const ellipse = (u: number, v: number, cx: number, cy: number, rx: number, ry: number): boolean =>
    ((u - cx) / rx) ** 2 + ((v - cy) / ry) ** 2 < 1;
  const triangle = (u: number, v: number, a: number[], b: number[], c: number[]): boolean => {
    const side = (p: number[], q: number[]) => (u - q[0]!) * (p[1]! - q[1]!) - (p[0]! - q[0]!) * (v - q[1]!);
    const d1 = side(a, b);
    const d2 = side(b, c);
    const d3 = side(c, a);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  return demoPng(width, height, (x, y) => {
    const u = x / width;
    const v = y / height;
    let c: Rgb = v > 0.74 ? mix([160, 116, 84], [120, 84, 60], (v - 0.74) * 3) : [228, 212, 184];
    if (u > 0.64 && u < 0.92 && v > 0.1 && v < 0.55)
      c =
        Math.abs(u - 0.78) < 0.008 || Math.abs(v - 0.325) < 0.01
          ? [244, 242, 236]
          : mix([170, 214, 244], [226, 240, 250], v);
    const fur: Rgb = [224, 138, 58];
    if (ellipse(u, v, 0.7, 0.84, 0.12, 0.045)) c = fur;
    if (ellipse(u, v, 0.4, 0.72, 0.27, 0.2)) c = Math.sin(u * 60) > 0.6 ? [180, 100, 36] : fur;
    if (ellipse(u, v, 0.3, 0.46, 0.16, 0.21)) c = [234, 150, 70];
    if (
      triangle(u, v, [0.17, 0.36], [0.19, 0.17], [0.27, 0.28]) ||
      triangle(u, v, [0.43, 0.36], [0.41, 0.17], [0.33, 0.28])
    )
      c = [214, 128, 52];
    if (ellipse(u, v, 0.25, 0.43, 0.03, 0.045) || ellipse(u, v, 0.36, 0.43, 0.03, 0.045)) c = [140, 196, 96];
    if (ellipse(u, v, 0.25, 0.43, 0.008, 0.04) || ellipse(u, v, 0.36, 0.43, 0.008, 0.04)) c = [24, 24, 24];
    if (ellipse(u, v, 0.305, 0.5, 0.015, 0.012)) c = [226, 120, 130];
    return c;
  });
}

/** A rounded square with a swoosh: the "new icon draft" of the design room. */
function iconScene(width: number, height: number): Buffer {
  const size = Math.min(width, height);
  const ox = (width - size) / 2;
  return demoPng(width, height, (x, y) => {
    const u = (x - ox) / size - 0.5;
    const v = y / size - 0.5;
    const inside = Math.abs(u) ** 5 + Math.abs(v) ** 5 < 0.5 ** 5 * 0.95;
    if (!inside) return [236, 238, 242];
    const bird = Math.abs(v + 0.05 - 0.25 * Math.sin(u * 5 + 0.6)) < 0.07 && Math.abs(u) < 0.3;
    return bird ? [255, 255, 255] : mix([26, 150, 142], [20, 96, 120], v + 0.5);
  });
}

/** A small RGB PNG, written here so the demo needs no file or network. */
export function demoPng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => Rgb = (x, y) => [
    Math.round((x / width) * 200) + 30,
    Math.round((y / height) * 160) + 70,
    90 + (((x >> 5) + (y >> 5)) % 2) * 60,
  ],
): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = quantize(pixel(x, y));
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

export interface Speech {
  text: string;
  /** An espeak-ng voice: `de`, `en-gb`, `en-us+f3` … */
  voice: string;
  pitch: number;
  /** Words per minute. */
  speed: number;
}

export interface Voice {
  bytes: Buffer;
  durationMs: number;
}

function work(dir: string): string {
  const path = join(dir, '.work');
  mkdirSync(path, { recursive: true });
  return path;
}

/** Spoken text as Ogg Opus, or null when `espeak-ng` or ffmpeg's Opus encoder is missing. */
export function speak(dir: string, speech: Speech): Voice | null {
  const scratch = work(dir);
  const wav = join(scratch, 'speech.wav');
  const ogg = join(scratch, 'speech.ogg');
  try {
    const tts = spawnSync(
      'espeak-ng',
      ['-v', speech.voice, '-p', String(speech.pitch), '-s', String(speech.speed), '-w', wav, speech.text],
      { stdio: 'ignore' },
    );
    if (tts.status !== 0) return null;
    const encode = spawnSync(
      'ffmpeg',
      ['-loglevel', 'error', '-y', '-i', wav, '-c:a', 'libopus', '-b:a', '24k', ogg],
      { stdio: 'ignore' },
    );
    if (encode.status !== 0) return null;
    // espeak-ng writes 16-bit mono at 22050 Hz behind a 44-byte header.
    const durationMs = Math.max(500, Math.round(((readFileSync(wav).length - 44) / 2 / 22050) * 1000));
    return { bytes: readFileSync(ogg), durationMs };
  } catch {
    return null;
  } finally {
    rmSync(wav, { force: true });
    rmSync(ogg, { force: true });
  }
}

/** Three seconds of ffmpeg's test pattern as MP4, or null when ffmpeg is not installed. */
export function demoClip(dir: string, pattern: 'testsrc' | 'smptebars' = 'testsrc'): Buffer | null {
  const out = join(work(dir), `clip-${pattern}.mp4`);
  try {
    const run = spawnSync(
      'ffmpeg',
      [
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `${pattern}=duration=3:size=320x240:rate=15`,
        '-pix_fmt',
        'yuv420p',
        out,
      ],
      { stdio: 'ignore' },
    );
    return run.status === 0 ? readFileSync(out) : null;
  } catch {
    return null;
  } finally {
    rmSync(out, { force: true });
  }
}

export function writeBytes(path: string, bytes: Buffer): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, bytes);
}
