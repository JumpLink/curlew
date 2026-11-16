/**
 * Telegram's `photoStrippedSize`: a JPEG with its fixed header and footer cut off, at most a few hundred
 * bytes. Expanding it is a published recipe (core.telegram.org/api/files#stripped-thumbnails): the
 * header below is the one every official client uses, with the image's height and width patched in.
 * Checked against mtcute's `strippedPhotoToJpg` in the tests.
 */

const HEADER_HEX = [
  'ffd8ffe000104a46494600010100000100010000ffdb004300281c1e231e19282321232d2b28303c64413c37373c7b58',
  '5d4964918099968f808c8aa0b4e6c3a0aadaad8a8cc8ffcbdaeef5ffffff9bc1fffffffaffe6fdfff8ffdb0043012b2d',
  '2d3c353c76414176f8a58ca5f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8',
  'f8f8f8f8f8f8f8f8f8f8f8f8f8f8ffc00011080000000003012200021101031101ffc4001f0000010501010101010100',
  '000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d010203000411051221',
  '31410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a',
  '434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a9293949596979899',
  '9aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1',
  'f2f3f4f5f6f7f8f9faffc4001f0100030101010101010101010000000000000102030405060708090a0bffc400b51100',
  '020102040403040705040400010277000102031104052131061241510761711322328108144291a1b1c109233352f015',
  '6272d10a162434e125f11718191a262728292a35363738393a434445464748494a535455565758595a63646566676869',
  '6a737475767778797a82838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4',
  'c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9faffda000c03010002110311003f00',
].join('');

function header(): Uint8Array {
  const out = new Uint8Array(HEADER_HEX.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(HEADER_HEX.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The JPEG a stripped thumbnail stands for, or null when the bytes are not a stripped JPEG. */
export function strippedToJpeg(stripped: Uint8Array): Uint8Array | null {
  if (stripped.length < 3 || stripped[0] !== 1) return null;
  const head = header();
  const body = stripped.subarray(3);
  const result = new Uint8Array(head.length + body.length + 2);
  result.set(head, 0);
  result.set(body, head.length);
  result[head.length + body.length] = 0xff;
  result[head.length + body.length + 1] = 0xd9;
  result[164] = stripped[1] ?? 0;
  result[166] = stripped[2] ?? 0;
  return result;
}
