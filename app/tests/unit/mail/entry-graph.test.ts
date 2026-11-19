import { describe, expect, it } from '@gjsify/unit';

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The repo root, found from the working directory. Not derived from `import.meta.url`: this suite
 * is BUNDLED into `app/dist/`, so that URL names the bundle, not this file.
 */
function imapSrc(): string {
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, 'packages', 'imap', 'src');
    if (existsSync(join(candidate, 'index.gjs.ts'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`packages/imap/src not found above ${process.cwd()}`);
    dir = parent;
  }
}

/** Every module specifier reachable from `entry` through relative imports, plus the bare ones. */
function reach(src: string, entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const todo = [entry];
  while (todo.length > 0) {
    const file = todo.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    const text = readFileSync(join(src, file), 'utf8');
    // Type-only imports are erased and carry no module along.
    for (const m of text.matchAll(/^(?:import|export)\s+(?!type\s)[^;]*?from\s+'([^']+)'/gm)) {
      const spec = m[1];
      if (spec.startsWith('./')) todo.push(spec.slice(2));
      else bare.add(spec);
    }
  }
  return { files, bare };
}

export default async () => {
  await describe('@curlew/imap entries (ADR 0018)', async () => {
    const src = imapSrc();

    for (const entry of ['index.gjs.ts', 'index.node.ts']) {
      await it(`${entry} does not reach the SMTP stack`, async () => {
        const { files, bare } = reach(src, entry);
        expect(files.has('send.ts')).toBe(false);
        expect(bare.has('@curlew/smtp')).toBe(false);
        expect(bare.has('nodemailer')).toBe(false);
      });
    }

    await it('the send entry is where the SMTP stack comes in', async () => {
      const { files, bare } = reach(src, 'send-entry.gjs.ts');
      expect(files.has('send.ts')).toBe(true);
      expect(bare.has('@curlew/smtp')).toBe(true);
    });

    await it('only the transport file touches Gio', async () => {
      const { files } = reach(src, 'index.gjs.ts');
      const withGi = [...files].filter((f) => /from\s+'gi:\/\//.test(readFileSync(join(src, f), 'utf8')));
      expect(withGi).toStrictEqual(['transport.gjs.ts']);
    });
  });
};
