/** A small pure blurHash decoder (https://blurha.sh): the hash to RGBA pixels, so it runs on Node and in tests. */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

function decode83(text: string): number {
  let value = 0;
  for (const ch of text) {
    const digit = ALPHABET.indexOf(ch);
    if (digit < 0) return Number.NaN;
    value = value * 83 + digit;
  }
  return value;
}

function srgbToLinear(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  const v = Math.max(0, Math.min(1, value));
  return Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255);
}

function signPow(value: number, exp: number): number {
  return Math.sign(value) * Math.abs(value) ** exp;
}

/** True when `hash` has a well-formed length for its own component counts. */
export function isValidBlurHash(hash: string): boolean {
  if (hash.length < 6) return false;
  const flag = decode83(hash[0] as string);
  if (!Number.isFinite(flag)) return false;
  const parts = (Math.floor(flag / 9) + 1) * ((flag % 9) + 1);
  return hash.length === 4 + 2 * parts && !Number.isNaN(decode83(hash));
}

/** RGBA bytes (width × height × 4, opaque), or null when the hash is malformed. */
export function decodeBlurHash(hash: string, width: number, height: number): Uint8Array | null {
  if (!isValidBlurHash(hash) || !(width > 0) || !(height > 0)) return null;
  const flag = decode83(hash[0] as string);
  const numY = Math.floor(flag / 9) + 1;
  const numX = (flag % 9) + 1;
  const maxVal = (decode83(hash[1] as string) + 1) / 166;
  const colors: [number, number, number][] = [];
  const dc = decode83(hash.slice(2, 6));
  colors.push([srgbToLinear(dc >> 16), srgbToLinear((dc >> 8) & 255), srgbToLinear(dc & 255)]);
  for (let i = 1; i < numX * numY; i++) {
    const v = decode83(hash.slice(4 + i * 2, 6 + i * 2));
    colors.push([
      signPow((Math.floor(v / 361) - 9) / 9, 2) * maxVal,
      signPow(((Math.floor(v / 19) % 19) - 9) / 9, 2) * maxVal,
      signPow(((v % 19) - 9) / 9, 2) * maxVal,
    ]);
  }
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < numY; j++) {
        for (let i = 0; i < numX; i++) {
          const basis = Math.cos((Math.PI * x * i) / width) * Math.cos((Math.PI * y * j) / height);
          const c = colors[j * numX + i] as [number, number, number];
          r += c[0] * basis;
          g += c[1] * basis;
          b += c[2] * basis;
        }
      }
      const at = (y * width + x) * 4;
      out[at] = linearToSrgb(r);
      out[at + 1] = linearToSrgb(g);
      out[at + 2] = linearToSrgb(b);
      out[at + 3] = 255;
    }
  }
  return out;
}
