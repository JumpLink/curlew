import { describe, expect, it } from '@gjsify/unit';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// The hard gate behind `msgfmt --statistics`: a catalogue that compiles can still ship a fuzzy
// guess, an empty translation, or a German sentence that lost a `{placeholder}` — and the last
// one prints a literal `{name}` or crashes a `fmt()` call only for German users.

const PO = 'po/de.po';

interface PoEntry {
  msgid: string;
  plural?: string;
  forms: string[];
  fuzzy: boolean;
}

/**
 * The repo root, found by walking up from the working directory.
 *
 * Not derived from `import.meta.url`: this suite is BUNDLED into `app/dist/test.gjs.mjs`, so that
 * URL names the bundle rather than this file.
 */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, PO))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`${PO} not found above ${process.cwd()} — run this suite inside the checkout`);
}

function unquote(quoted: string): string {
  return JSON.parse(quoted) as string;
}

/** Parse the entries of a `.po` file; the header (empty msgid) is dropped. */
function parsePo(text: string): PoEntry[] {
  const entries: PoEntry[] = [];
  let current: PoEntry | undefined;
  let target: 'msgid' | 'plural' | number = 'msgid';
  let fuzzy = false;
  const append = (value: string): void => {
    if (!current) return;
    if (target === 'msgid') current.msgid += value;
    else if (target === 'plural') current.plural = (current.plural ?? '') + value;
    else current.forms[target] = (current.forms[target] ?? '') + value;
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('#,')) {
      fuzzy = /\bfuzzy\b/.test(line);
      continue;
    }
    if (line.startsWith('#')) continue;
    let m = /^msgid_plural (".*")$/.exec(line);
    if (m) {
      target = 'plural';
      current!.plural = '';
      append(unquote(m[1]));
      continue;
    }
    m = /^msgid (".*")$/.exec(line);
    if (m) {
      current = { msgid: '', forms: [], fuzzy };
      fuzzy = false;
      entries.push(current);
      target = 'msgid';
      append(unquote(m[1]));
      continue;
    }
    m = /^msgstr(?:\[(\d+)\])? (".*")$/.exec(line);
    if (m) {
      target = m[1] === undefined ? 0 : Number(m[1]);
      append(unquote(m[2]));
      continue;
    }
    m = /^(".*")$/.exec(line);
    if (m) append(unquote(m[1]));
  }
  return entries.filter((entry) => entry.msgid !== '');
}

/** Sorted `{name}` and printf-style tokens of a string. */
function placeholders(text: string): string[] {
  return (text.match(/\{[A-Za-z_][A-Za-z0-9_]*\}|%(?:\d+\$)?[sdif]/g) ?? []).sort();
}

export default async () => {
  await describe('po/de.po', async () => {
    const entries = parsePo(readFileSync(join(repoRoot(), PO), 'utf8'));

    await it('has entries', async () => {
      expect(entries.length > 100).toBe(true);
    });

    await it('has no fuzzy entry', async () => {
      expect(entries.filter((entry) => entry.fuzzy).map((entry) => entry.msgid)).toStrictEqual([]);
    });

    await it('has no empty translation', async () => {
      const empty = entries.filter(
        (entry) => entry.forms.length === 0 || entry.forms.some((form) => !form?.trim()),
      );
      expect(empty.map((entry) => entry.msgid)).toStrictEqual([]);
    });

    await it('keeps every placeholder of the msgid', async () => {
      const broken: string[] = [];
      for (const entry of entries) {
        // A plural's singular form may drop the count, so each form matches the singular OR the plural.
        const allowed = [placeholders(entry.msgid).join(' ')];
        if (entry.plural !== undefined) allowed.push(placeholders(entry.plural).join(' '));
        for (const form of entry.forms) {
          if (!allowed.includes(placeholders(form ?? '').join(' '))) {
            broken.push(entry.msgid);
            break;
          }
        }
      }
      expect(broken).toStrictEqual([]);
    });
  });
};
