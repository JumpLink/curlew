import { describe, expect, it } from '@gjsify/unit';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { contentTypeForName, inspectSendFiles } from '@curlew/store';

const limits = { perFile: 100, count: 2 };

function failure(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

export default async () => {
  await describe('inspecting files to send', async () => {
    await it('names the type from the extension', async () => {
      expect(contentTypeForName('A.PNG')).toBe('image/png');
      expect(contentTypeForName('notes.pdf')).toBe('application/pdf');
      expect(contentTypeForName('blob.bin')).toBe('application/octet-stream');
    });

    await it('passes a regular file and a link to one, and reports size and name', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-sendfiles-'));
      try {
        const file = join(dir, 'a.txt');
        writeFileSync(file, 'hello');
        symlinkSync(file, join(dir, 'link.txt'));
        const [plain, linked] = inspectSendFiles([{ path: file }, { path: join(dir, 'link.txt') }], limits);
        expect(plain!.filename).toBe('a.txt');
        expect(plain!.size).toBe(5);
        expect(plain!.contentType).toBe('text/plain');
        expect(linked!.filename).toBe('link.txt');
        expect(linked!.realPath.endsWith('a.txt')).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('refuses what is not an absolute regular file within the limits', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-sendfiles-'));
      try {
        const big = join(dir, 'big.bin');
        writeFileSync(big, new Uint8Array(101));
        mkdirSync(join(dir, 'folder'));
        expect(failure(() => inspectSendFiles([{ path: 'a.txt' }], limits))).toMatch(/absolute/);
        expect(failure(() => inspectSendFiles([{ path: join(dir, 'gone') }], limits))).toMatch(
          /cannot be read/,
        );
        expect(failure(() => inspectSendFiles([{ path: join(dir, 'folder') }], limits))).toMatch(
          /regular file/,
        );
        expect(failure(() => inspectSendFiles([{ path: big }], limits))).toMatch(/more than/);
        const one = { path: big };
        expect(failure(() => inspectSendFiles([one, one, one], limits))).toMatch(/at most 2/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
