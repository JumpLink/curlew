import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '@gjsify/unit';

import { probeMedia, probeMediaFile } from '@curlew/protocol';

// All fixtures are built here from a few header bytes — nothing is committed.
const enc = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >> 8) & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const bytes = (...parts: number[][]) => new Uint8Array(parts.flat());

const png = (w: number, h: number) =>
  bytes([0x89, ...enc('PNG'), 13, 10, 26, 10], be32(13), enc('IHDR'), be32(w), be32(h), [8, 6, 0, 0, 0]);

const gif = (w: number, h: number) => bytes(enc('GIF89a'), le16(w), le16(h), [0, 0, 0]);

function jpeg(w: number, h: number, orientation?: number) {
  const exif =
    orientation === undefined
      ? []
      : [
          0xff,
          0xe1,
          ...be16(2 + 6 + 8 + 2 + 12 + 4),
          ...enc('Exif'),
          0,
          0,
          ...enc('MM'),
          ...be16(42),
          ...be32(8),
          ...be16(1),
          ...be16(0x0112),
          ...be16(3),
          ...be32(1),
          ...be16(orientation),
          0,
          0,
          ...be32(0),
        ];
  return bytes(
    [0xff, 0xd8],
    exif,
    [0xff, 0xc0],
    be16(11),
    [8],
    be16(h),
    be16(w),
    [1, 1, 0x11, 0],
    [0xff, 0xd9],
  );
}

const webpVp8x = (w: number, h: number) =>
  bytes(
    enc('RIFF'),
    le32(30),
    enc('WEBP'),
    enc('VP8X'),
    le32(10),
    [0, 0, 0, 0],
    le32(w - 1).slice(0, 3),
    le32(h - 1).slice(0, 3),
  );

function webpVp8l(w: number, h: number) {
  const bits = (w - 1) | ((h - 1) << 14);
  return bytes(enc('RIFF'), le32(30), enc('WEBP'), enc('VP8L'), le32(5), [0x2f], le32(bits).slice(0, 4));
}

const webpVp8 = (w: number, h: number) =>
  bytes(
    enc('RIFF'),
    le32(30),
    enc('WEBP'),
    enc('VP8 '),
    le32(10),
    [0, 0, 0, 0x9d, 0x01, 0x2a],
    le16(w),
    le16(h),
  );

const box = (type: string, ...payload: number[][]) => {
  const body = payload.flat();
  return [...be32(8 + body.length), ...enc(type), ...body];
};

function mp4(opts: {
  width: number;
  height: number;
  scale: number;
  duration: number;
  rotate?: boolean;
  big?: boolean;
}) {
  const mvhd = box(
    'mvhd',
    [0, 0, 0, 0],
    be32(0),
    be32(0),
    be32(opts.scale),
    be32(opts.duration),
    Array.from({ length: 80 }, () => 0),
  );
  const matrix = opts.rotate
    ? [...be32(0), ...be32(0x10000), ...be32(0), ...be32(0xffff0000), ...be32(0), ...be32(0)]
    : [...be32(0x10000), ...be32(0), ...be32(0), ...be32(0), ...be32(0x10000), ...be32(0)];
  const tkhd = box(
    'tkhd',
    [0, 0, 0, 3],
    be32(0),
    be32(0),
    be32(1),
    be32(0),
    be32(opts.duration),
    Array.from({ length: 8 }, () => 0),
    be16(0),
    be16(0),
    be16(0),
    be16(0),
    matrix,
    Array.from({ length: 12 }, () => 0),
    be32(opts.width * 0x10000),
    be32(opts.height * 0x10000),
  );
  const moov = box('moov', mvhd, box('trak', tkhd));
  const mdatBody = Array.from({ length: 5000 }, () => 7);
  // 64-bit box size for mdat exercises the largesize path, and puts moov at the END of the file.
  const mdat = opts.big
    ? [...be32(1), ...enc('mdat'), ...be32(0), ...be32(16 + mdatBody.length), ...mdatBody]
    : box('mdat', mdatBody);
  return bytes(box('ftyp', enc('isom'), be32(0), enc('isom')), mdat, moov);
}

function oggPage(granule: number, payload: number[], flags = 0) {
  return [
    ...enc('OggS'),
    0,
    flags,
    ...le32(granule),
    ...le32(0),
    ...le32(1),
    ...le32(0),
    ...le32(0),
    1,
    payload.length,
    ...payload,
  ];
}

function oggOpus(channels: number, granule: number, preSkip = 312) {
  const head = [...enc('OpusHead'), 1, channels, ...le16(preSkip), ...le32(48000), ...le16(0), 0];
  return bytes(oggPage(0, head, 2), oggPage(granule, [1, 2, 3], 4));
}

function oggVorbis(rate: number, granule: number) {
  const head = [
    1,
    ...enc('vorbis'),
    ...le32(0),
    2,
    ...le32(rate),
    ...le32(0),
    ...le32(0),
    ...le32(0),
    0xb8,
    1,
  ];
  return bytes(oggPage(0, head, 2), oggPage(granule, [1, 2, 3], 4));
}

const ebml = (id: number[], payload: number[]) => [...id, 0x80 | payload.length, ...payload];

function webm(w: number, h: number, durationMs: number) {
  const f64 = new Uint8Array(8);
  new DataView(f64.buffer).setFloat64(0, durationMs);
  const info = ebml(
    [0x15, 0x49, 0xa9, 0x66],
    [...ebml([0x2a, 0xd7, 0xb1], be32(1000000).slice(1)), ...ebml([0x44, 0x89], Array.from(f64))],
  );
  const video = ebml([0xe0], [...ebml([0xb0], be16(w)), ...ebml([0xba], be16(h))]);
  const tracks = ebml([0x16, 0x54, 0xae, 0x6b], ebml([0xae], video));
  const segment = [
    0x18,
    0x53,
    0x80,
    0x67,
    0x01,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    ...info,
    ...tracks,
  ];
  return bytes(ebml([0x1a, 0x45, 0xdf, 0xa3], ebml([0x42, 0x82], enc('webm'))), segment);
}

const nulls = { width: null, height: null, durationMs: null, voice: false };

export default async () => {
  await describe('probeMedia — images', async () => {
    await it('reads PNG, GIF and the three WebP flavours', async () => {
      expect(probeMedia(png(640, 480), 'image/png')).toStrictEqual({ ...nulls, width: 640, height: 480 });
      expect(probeMedia(gif(33, 22), 'image/gif')).toStrictEqual({ ...nulls, width: 33, height: 22 });
      expect(probeMedia(webpVp8x(1000, 700), 'image/webp')).toStrictEqual({
        ...nulls,
        width: 1000,
        height: 700,
      });
      expect(probeMedia(webpVp8l(321, 123), 'image/webp')).toStrictEqual({
        ...nulls,
        width: 321,
        height: 123,
      });
      expect(probeMedia(webpVp8(200, 100), 'image/webp')).toStrictEqual({
        ...nulls,
        width: 200,
        height: 100,
      });
    });

    await it('reads JPEG size and swaps for EXIF orientation 5-8', async () => {
      expect(probeMedia(jpeg(400, 300), 'image/jpeg')).toStrictEqual({ ...nulls, width: 400, height: 300 });
      expect(probeMedia(jpeg(400, 300, 1), 'image/jpeg')).toStrictEqual({
        ...nulls,
        width: 400,
        height: 300,
      });
      expect(probeMedia(jpeg(400, 300, 6), 'image/jpeg')).toStrictEqual({
        ...nulls,
        width: 300,
        height: 400,
      });
      expect(probeMedia(jpeg(400, 300, 8), 'image/jpeg')).toStrictEqual({
        ...nulls,
        width: 300,
        height: 400,
      });
    });

    await it('sniffs the bytes, not the claimed mime type', async () => {
      expect(probeMedia(png(5, 6), 'application/octet-stream').width).toBe(5);
    });
  });

  await describe('probeMedia — video and audio', async () => {
    await it('reads mp4 duration and size with moov after mdat', async () => {
      const r = probeMedia(mp4({ width: 1280, height: 720, scale: 1000, duration: 5500 }), 'video/mp4');
      expect(r).toStrictEqual({ ...nulls, width: 1280, height: 720, durationMs: 5500 });
    });

    await it('handles 64-bit box sizes and a rotated track', async () => {
      const r = probeMedia(
        mp4({ width: 1920, height: 1080, scale: 600, duration: 1200, rotate: true, big: true }),
        'video/quicktime',
      );
      expect(r).toStrictEqual({ ...nulls, width: 1080, height: 1920, durationMs: 2000 });
    });

    await it('reads Ogg Opus duration minus pre-skip and flags mono as voice', async () => {
      const r = probeMedia(oggOpus(1, 48000 * 3 + 312), 'audio/ogg');
      expect(r).toStrictEqual({ ...nulls, durationMs: 3000, voice: true });
      expect(probeMedia(oggOpus(2, 48000 + 312), 'audio/ogg')).toStrictEqual({
        ...nulls,
        durationMs: 1000,
        voice: false,
      });
    });

    await it('reads Ogg Vorbis duration with its own sample rate, never voice', async () => {
      expect(probeMedia(oggVorbis(44100, 44100 * 2), 'audio/ogg')).toStrictEqual({
        ...nulls,
        durationMs: 2000,
      });
    });

    await it('reads WebM duration and pixel size', async () => {
      expect(probeMedia(webm(640, 360, 4200), 'video/webm')).toStrictEqual({
        ...nulls,
        width: 640,
        height: 360,
        durationMs: 4200,
      });
    });
  });

  await describe('probeMedia — garbage', async () => {
    await it('returns nulls and never throws', async () => {
      expect(probeMedia(new Uint8Array(0), 'image/png')).toStrictEqual(nulls);
      expect(probeMedia(new Uint8Array(0), '')).toStrictEqual(nulls);
      expect(probeMedia(bytes(enc('hello world, not media')), 'video/mp4')).toStrictEqual(nulls);
      const full = mp4({ width: 10, height: 10, scale: 1, duration: 1 });
      for (const mime of ['video/mp4', 'image/jpeg', 'audio/ogg', 'video/webm', 'image/webp']) {
        for (let cut = 0; cut < 40; cut++) probeMedia(full.subarray(0, cut), mime);
        probeMedia(new Uint8Array(300).fill(0xff), mime);
      }
      expect(probeMedia(png(5, 5).subarray(0, 14), 'image/png')).toStrictEqual(nulls);
    });

    await it('ignores zero-sized images', async () => {
      expect(probeMedia(png(0, 0), 'image/png')).toStrictEqual(nulls);
    });
  });

  await describe('probeMediaFile', async () => {
    await it('matches probeMedia and seeks to a trailing moov', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-probe-'));
      try {
        const cases: Array<[string, Uint8Array, string]> = [
          ['a.png', png(64, 32), 'image/png'],
          ['b.mp4', mp4({ width: 320, height: 240, scale: 1000, duration: 9000 }), 'video/mp4'],
          ['c.mp4', mp4({ width: 320, height: 240, scale: 1000, duration: 9000, big: true }), 'video/mp4'],
          ['d.ogg', oggOpus(1, 48000 + 312), 'audio/ogg'],
        ];
        for (const [name, data, mime] of cases) {
          const path = join(dir, name);
          writeFileSync(path, data);
          expect(probeMediaFile(path, mime)).toStrictEqual(probeMedia(data, mime));
        }
        expect(probeMediaFile(join(dir, 'b.mp4'), 'video/mp4').durationMs).toBe(9000);
        expect(probeMediaFile(join(dir, 'missing'), 'video/mp4')).toStrictEqual(nulls);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
