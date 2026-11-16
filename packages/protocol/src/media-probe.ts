/**
 * Pure media probe: pixel size, duration and the voice-note flag from the first bytes of a file.
 * No `gi://` imports, so every backend can call it under Node and GJS. It never throws — garbage,
 * truncation or an unknown format yields nulls, because a missing dimension must not fail a send.
 */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export interface MediaProbe {
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** True for Ogg Opus with one channel: the shape of a voice note. */
  voice: boolean;
}

type Kind = 'png' | 'jpeg' | 'gif' | 'webp' | 'mp4' | 'matroska' | 'ogg';

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 64 * 1024;
const MAX_MOOV_BYTES = 64 * 1024 * 1024;

const empty = (): MediaProbe => ({ width: null, height: null, durationMs: null, voice: false });

const at = (b: Uint8Array, p: number): number => b[p] ?? 0;
const u16be = (b: Uint8Array, p: number): number => (at(b, p) << 8) | at(b, p + 1);
const u16le = (b: Uint8Array, p: number): number => at(b, p) | (at(b, p + 1) << 8);
const u24le = (b: Uint8Array, p: number): number => at(b, p) | (at(b, p + 1) << 8) | (at(b, p + 2) << 16);
const u32be = (b: Uint8Array, p: number): number =>
  at(b, p) * 0x1000000 + ((at(b, p + 1) << 16) | (at(b, p + 2) << 8) | at(b, p + 3));
const u32le = (b: Uint8Array, p: number): number =>
  at(b, p + 3) * 0x1000000 + ((at(b, p + 2) << 16) | (at(b, p + 1) << 8) | at(b, p));
const u64be = (b: Uint8Array, p: number): number => u32be(b, p) * 0x100000000 + u32be(b, p + 4);
const i32be = (b: Uint8Array, p: number): number => u32be(b, p) | 0;

function ascii(b: Uint8Array, p: number, s: string): boolean {
  if (p < 0 || p + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) if (b[p + i] !== s.charCodeAt(i)) return false;
  return true;
}

function sniff(b: Uint8Array): Kind | null {
  if (b[0] === 0x89 && ascii(b, 1, 'PNG')) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  if (ascii(b, 0, 'GIF8')) return 'gif';
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'webp';
  if (ascii(b, 4, 'ftyp')) return 'mp4';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'matroska';
  if (ascii(b, 0, 'OggS')) return 'ogg';
  return null;
}

function kindFromMime(mime: string): Kind | null {
  const m = mime.toLowerCase().split(';')[0]?.trim() ?? '';
  if (m === 'image/png') return 'png';
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpeg';
  if (m === 'image/gif') return 'gif';
  if (m === 'image/webp') return 'webp';
  if (m === 'video/mp4' || m === 'video/quicktime' || m === 'audio/mp4' || m === 'audio/x-m4a') return 'mp4';
  if (m === 'video/webm' || m === 'video/x-matroska' || m === 'audio/webm') return 'matroska';
  if (m === 'audio/ogg' || m === 'audio/opus' || m === 'application/ogg') return 'ogg';
  return null;
}

function size(width: number, height: number): Partial<MediaProbe> {
  return width > 0 && height > 0 ? { width, height } : {};
}

function probePng(b: Uint8Array): Partial<MediaProbe> {
  return ascii(b, 12, 'IHDR') ? size(u32be(b, 16), u32be(b, 20)) : {};
}

function probeGif(b: Uint8Array): Partial<MediaProbe> {
  return size(u16le(b, 6), u16le(b, 8));
}

function probeWebp(b: Uint8Array): Partial<MediaProbe> {
  if (ascii(b, 12, 'VP8X')) return size(1 + u24le(b, 24), 1 + u24le(b, 27));
  if (ascii(b, 12, 'VP8L')) {
    if (at(b, 20) !== 0x2f) return {};
    const b0 = at(b, 21);
    const b1 = at(b, 22);
    const b2 = at(b, 23);
    const b3 = at(b, 24);
    return size(1 + (b0 | ((b1 & 0x3f) << 8)), 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)));
  }
  if (ascii(b, 12, 'VP8 ')) {
    if (at(b, 23) !== 0x9d || at(b, 24) !== 0x01 || at(b, 25) !== 0x2a) return {};
    return size(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  return {};
}

function exifOrientation(b: Uint8Array, t: number): number {
  const le = ascii(b, t, 'II');
  if (!le && !ascii(b, t, 'MM')) return 1;
  const r16 = (p: number) => (le ? u16le(b, p) : u16be(b, p));
  const r32 = (p: number) => (le ? u32le(b, p) : u32be(b, p));
  const ifd = t + r32(t + 4);
  const count = r16(ifd);
  for (let i = 0; i < count && i < 256; i++) {
    const e = ifd + 2 + i * 12;
    if (r16(e) === 0x0112) return r16(e + 8);
  }
  return 1;
}

function probeJpeg(b: Uint8Array): Partial<MediaProbe> {
  let pos = 2;
  let orientation = 1;
  while (pos + 4 <= b.length) {
    if (at(b, pos) !== 0xff) {
      pos++;
      continue;
    }
    const marker = at(b, pos + 1);
    if (marker === 0xff) {
      pos++;
      continue;
    }
    if (marker === 0 || marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const len = u16be(b, pos + 2);
    if (len < 2) break;
    if (marker === 0xe1 && ascii(b, pos + 4, 'Exif\0\0')) orientation = exifOrientation(b, pos + 10);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const h = u16be(b, pos + 5);
      const w = u16be(b, pos + 7);
      return orientation >= 5 && orientation <= 8 ? size(h, w) : size(w, h);
    }
    pos += 2 + len;
  }
  return {};
}

interface Box {
  type: string;
  start: number;
  end: number;
  /** Declared size, possibly past the end of a truncated buffer. */
  total: number;
}

function boxAt(b: Uint8Array, pos: number, end: number): Box | null {
  if (pos + 8 > end) return null;
  let total = u32be(b, pos);
  let header = 8;
  if (total === 1) {
    if (pos + 16 > end) return null;
    total = u64be(b, pos + 8);
    header = 16;
  } else if (total === 0) {
    total = end - pos;
  }
  if (total < header) return null;
  const type = String.fromCharCode(at(b, pos + 4), at(b, pos + 5), at(b, pos + 6), at(b, pos + 7));
  return { type, start: pos + header, end: Math.min(pos + total, end), total };
}

function* boxes(b: Uint8Array, start: number, end: number): Generator<Box> {
  let pos = start;
  while (pos < end) {
    const box = boxAt(b, pos, end);
    if (!box) return;
    yield box;
    pos += box.total;
  }
}

function probeTkhd(b: Uint8Array, box: Box): Partial<MediaProbe> {
  const version = at(b, box.start);
  const extra = version === 1 ? 12 : 0;
  const w = u32be(b, box.start + 76 + extra) / 0x10000;
  const h = u32be(b, box.start + 80 + extra) / 0x10000;
  const a = i32be(b, box.start + 40 + extra);
  const rotated = a === 0 && i32be(b, box.start + 44 + extra) !== 0;
  return rotated ? size(Math.round(h), Math.round(w)) : size(Math.round(w), Math.round(h));
}

/** `b[start,end)` is the payload of a `moov` box. */
function probeMoov(b: Uint8Array, start: number, end: number): Partial<MediaProbe> {
  const out: Partial<MediaProbe> = {};
  for (const box of boxes(b, start, end)) {
    if (box.type === 'mvhd') {
      const v1 = at(b, box.start) === 1;
      const scale = u32be(b, box.start + (v1 ? 20 : 12));
      const duration = v1 ? u64be(b, box.start + 24) : u32be(b, box.start + 16);
      if (scale > 0) out.durationMs = Math.round((duration / scale) * 1000);
    } else if (box.type === 'trak' && out.width === undefined) {
      for (const child of boxes(b, box.start, box.end)) {
        if (child.type !== 'tkhd') continue;
        Object.assign(out, probeTkhd(b, child));
      }
    }
  }
  return out;
}

function probeMp4(b: Uint8Array): Partial<MediaProbe> {
  for (const box of boxes(b, 0, b.length)) {
    if (box.type === 'moov') return probeMoov(b, box.start, box.end);
  }
  return {};
}

const MKV_MASTER = new Set([0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0xe0]);

interface MkvState {
  scale: number;
  duration: number | null;
  width: number | null;
  height: number | null;
}

function vint(b: Uint8Array, pos: number, keepMarker: boolean): { value: number; len: number; unknown: boolean } | null {
  const first = at(b, pos);
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || pos + len > b.length) return null;
  let value = keepMarker ? first : first & (0xff >> len);
  let allOnes = (first & (0xff >> len)) === (0xff >> len);
  for (let i = 1; i < len; i++) {
    const byte = at(b, pos + i);
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { value, len, unknown: allOnes };
}

function mkvUint(b: Uint8Array, start: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len && i < 8; i++) v = v * 256 + at(b, start + i);
  return v;
}

function mkvWalk(b: Uint8Array, start: number, end: number, st: MkvState, depth: number): void {
  if (depth > 6) return;
  let pos = start;
  while (pos < end) {
    const id = vint(b, pos, true);
    if (!id) return;
    const sz = vint(b, pos + id.len, false);
    if (!sz) return;
    const dataStart = pos + id.len + sz.len;
    const dataEnd = sz.unknown ? end : Math.min(end, dataStart + sz.value);
    if (MKV_MASTER.has(id.value)) {
      mkvWalk(b, dataStart, dataEnd, st, depth + 1);
    } else {
      const len = dataEnd - dataStart;
      if (id.value === 0x2ad7b1) st.scale = mkvUint(b, dataStart, len) || st.scale;
      else if (id.value === 0xb0 && st.width === null) st.width = mkvUint(b, dataStart, len);
      else if (id.value === 0xba && st.height === null) st.height = mkvUint(b, dataStart, len);
      else if (id.value === 0x4489 && (len === 4 || len === 8)) {
        const dv = new DataView(b.buffer, b.byteOffset + dataStart, len);
        st.duration = len === 4 ? dv.getFloat32(0) : dv.getFloat64(0);
      }
    }
    if (dataEnd <= pos) return;
    pos = dataEnd;
  }
}

function probeMatroska(b: Uint8Array): Partial<MediaProbe> {
  const st: MkvState = { scale: 1000000, duration: null, width: null, height: null };
  mkvWalk(b, 0, b.length, st, 0);
  const out: Partial<MediaProbe> = {};
  if (st.duration !== null && Number.isFinite(st.duration) && st.duration >= 0) {
    out.durationMs = Math.round((st.duration * st.scale) / 1e6);
  }
  if (st.width && st.height) Object.assign(out, size(st.width, st.height));
  return out;
}

interface OggHead {
  opus: boolean;
  channels: number;
  preSkip: number;
  rate: number;
}

function oggHead(b: Uint8Array): OggHead | null {
  if (!ascii(b, 0, 'OggS')) return null;
  const data = 27 + at(b, 26);
  if (ascii(b, data, 'OpusHead')) {
    return { opus: true, channels: at(b, data + 9), preSkip: u16le(b, data + 10), rate: 48000 };
  }
  if (at(b, data) === 1 && ascii(b, data + 1, 'vorbis')) {
    return { opus: false, channels: at(b, data + 11), preSkip: 0, rate: u32le(b, data + 12) };
  }
  return null;
}

function oggLastGranule(b: Uint8Array): number | null {
  for (let p = b.length - 27; p >= 0; p--) {
    if (b[p] !== 0x4f || !ascii(b, p, 'OggS') || at(b, p + 4) !== 0) continue;
    const lo = u32le(b, p + 6);
    const hi = u32le(b, p + 10);
    if (lo === 0xffffffff && hi === 0xffffffff) continue;
    return hi * 0x100000000 + lo;
  }
  return null;
}

function probeOgg(head: Uint8Array, tail: Uint8Array): Partial<MediaProbe> {
  const info = oggHead(head);
  if (!info) return {};
  const out: Partial<MediaProbe> = { voice: info.opus && info.channels === 1 };
  const granule = oggLastGranule(tail);
  if (granule !== null && info.rate > 0) {
    out.durationMs = Math.round((Math.max(0, granule - info.preSkip) / info.rate) * 1000);
  }
  return out;
}

function probeKind(kind: Kind, b: Uint8Array): Partial<MediaProbe> {
  switch (kind) {
    case 'png':
      return probePng(b);
    case 'jpeg':
      return probeJpeg(b);
    case 'gif':
      return probeGif(b);
    case 'webp':
      return probeWebp(b);
    case 'mp4':
      return probeMp4(b);
    case 'matroska':
      return probeMatroska(b);
    case 'ogg':
      return probeOgg(b, b);
  }
}

function finish(partial: Partial<MediaProbe>): MediaProbe {
  return { ...empty(), ...partial };
}

/** Probe a whole (or leading part of a) file held in memory. Never throws. */
export function probeMedia(bytes: Uint8Array, mimeType: string): MediaProbe {
  try {
    const kind = sniff(bytes) ?? kindFromMime(mimeType);
    return kind ? finish(probeKind(kind, bytes)) : empty();
  } catch {
    return empty();
  }
}

function readAt(fd: number, pos: number, len: number): Uint8Array {
  const buf = new Uint8Array(len);
  const n = readSync(fd, buf, 0, len, pos);
  return n === len ? buf : buf.subarray(0, n);
}

function probeMp4File(fd: number, fileSize: number): Partial<MediaProbe> {
  let pos = 0;
  while (pos + 8 <= fileSize) {
    const head = readAt(fd, pos, Math.min(16, fileSize - pos));
    const box = boxAt(head, 0, head.length);
    if (!box) return {};
    const header = box.start;
    // size 0 means "to the end of the file", which boxAt cannot know from a 16-byte window.
    const total = u32be(head, 0) === 0 ? fileSize - pos : box.total;
    if (box.type === 'moov') {
      const payload = Math.min(total - header, MAX_MOOV_BYTES, fileSize - pos - header);
      const moov = readAt(fd, pos + header, payload);
      return probeMoov(moov, 0, moov.length);
    }
    if (total < header) return {};
    pos += total;
  }
  return {};
}

/** Probe a file on disk, reading only the head (and the box chain / tail where needed). Never throws. */
export function probeMediaFile(path: string, mimeType: string): MediaProbe {
  let fd: number | null = null;
  try {
    const handle = openSync(path, 'r');
    fd = handle;
    const fileSize = fstatSync(handle).size;
    const head = readAt(handle, 0, Math.min(HEAD_BYTES, fileSize));
    const kind = sniff(head) ?? kindFromMime(mimeType);
    if (!kind) return empty();
    if (kind === 'mp4') return finish(probeMp4File(handle, fileSize));
    if (kind === 'ogg') {
      const tailLen = Math.min(TAIL_BYTES, fileSize);
      const tail = tailLen >= fileSize ? head : readAt(handle, fileSize - tailLen, tailLen);
      return finish(probeOgg(head, tail));
    }
    return finish(probeKind(kind, head));
  } catch {
    return empty();
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // nothing to do
      }
    }
  }
}
