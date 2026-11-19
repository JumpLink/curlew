import { describe, expect, it } from '@gjsify/unit';

import { ByteReader, READ_CHUNK } from '@curlew/protocol';

/** A stream that hands out the given chunks one read at a time, then EOF. */
function chunked(...chunks: string[]) {
  const queue = chunks.map((c) => Uint8Array.from(c, (ch) => ch.charCodeAt(0)));
  const asked: number[] = [];
  return {
    asked,
    read: async (max: number) => {
      asked.push(max);
      return queue.shift() ?? new Uint8Array(0);
    },
  };
}

const text = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join('');

export default async () => {
  await describe('ByteReader over a ByteStream', async () => {
    await it('joins a line that arrives in several short reads and strips CRLF', async () => {
      const stream = chunked('* OK re', 'ady\r', '\nnext\n');
      const reader = new ByteReader(stream);
      expect(await reader.readLine()).toBe('* OK ready');
      expect(await reader.readLine()).toBe('next');
      expect(await reader.readLine()).toBe(null);
      expect(stream.asked.every((n) => n === READ_CHUNK)).toBe(true);
    });

    await it('returns an unterminated tail once, then null', async () => {
      const reader = new ByteReader(chunked('tail'));
      expect(await reader.readLine()).toBe('tail');
      expect(await reader.readLine()).toBe(null);
    });

    await it('reads exactly n bytes across reads and keeps the rest for the next line', async () => {
      const reader = new ByteReader(chunked('{5}\r\nab', 'cde rest\r\n'));
      expect(await reader.readLine()).toBe('{5}');
      expect(text(await reader.readBytes(5))).toBe('abcde');
      expect(await reader.readLine()).toBe(' rest');
    });

    await it('returns fewer bytes only at the end of the stream', async () => {
      const reader = new ByteReader(chunked('abc'));
      expect(text(await reader.readBytes(10))).toBe('abc');
    });

    await it('pipes a literal in chunks and reports a short transfer', async () => {
      const reader = new ByteReader(chunked('ab', 'cd', 'ef'));
      const seen: string[] = [];
      expect(await reader.pipeBytes(5, (chunk) => void seen.push(text(chunk)))).toBe(5);
      expect(seen.join('')).toBe('abcde');
      expect(await reader.pipeBytes(4, () => {})).toBe(1);
    });

    await it('skips bytes without losing what follows them', async () => {
      const reader = new ByteReader(chunked('xxxxx)\r\na1 OK\r\n'));
      expect(await reader.skipBytes(5)).toBe(5);
      expect(await reader.readLine()).toBe(')');
      expect(await reader.readLine()).toBe('a1 OK');
    });
  });
};
