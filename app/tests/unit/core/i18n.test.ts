import { describe, expect, it } from '@gjsify/unit';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  _,
  _n,
  activeCatalogue,
  fmt,
  localeCandidates,
  parseMoCatalogue,
  setCatalogue,
  TEXT_DOMAIN,
} from '@curlew/protocol';
import { parseCredentials, TELEGRAM_MANIFEST } from '@curlew/telegram';

import { initI18n } from '../../../src/core/lib/i18n.ts';

// The catalogues are built from po/de.po by dev/i18n.sh, which needs msgfmt — so this suite
// synthesizes its own .mo bytes instead of reading app/dist/locale. That keeps it honest about
// the thing under test (does a German environment produce German?) without making the result
// depend on whether gettext happens to be installed on the runner.
//
// EVERY case must end with setCatalogue(undefined): the catalogue is process-global, and a
// German one leaking out of here turns the English assertions in telegram.test.ts into failures
// that look like a bug in Telegram.

/** A real msgid/msgstr pair from po/de.po, so the test fails if the German is retranslated. */
const HASH_ERROR = 'the Telegram api_hash must be 32 hexadecimal characters (value not shown) — {where}';
const HASH_ERROR_DE =
  'der Telegram-api_hash muss aus 32 hexadezimalen Zeichen bestehen (Wert wird nicht angezeigt) — {where}';

const GERMAN_HEADER = 'Language: de\nPlural-Forms: nplurals=2; plural=(n != 1);\n';

/**
 * Assemble a `.mo` file, per the GNU gettext manual's "The Format of GNU MO Files".
 *
 * Header, then two parallel tables of (length, offset) pairs — originals and translations — then
 * the strings themselves, each NUL-terminated with the NUL outside the recorded length. Entries
 * are sorted by msgid because a real msgfmt does; the parser scans linearly, so this only keeps
 * the fixture representative.
 */
function buildMo(entries: Record<string, string>, header = GERMAN_HEADER): Uint8Array {
  const encoder = new TextEncoder();
  const pairs: [string, string][] = [['', header], ...Object.entries(entries)];
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const count = pairs.length;
  const originalsTable = 28;
  const translationsTable = originalsTable + count * 8;

  const blobs = pairs.flatMap(([original, translation]) => [
    encoder.encode(original),
    encoder.encode(translation),
  ]);
  const placed = blobs.map((blob) => ({ blob, length: blob.byteLength, offset: 0 }));
  let cursor = translationsTable + count * 8;
  for (const entry of placed) {
    entry.offset = cursor;
    cursor += entry.length + 1; // the terminating NUL
  }

  const out = new Uint8Array(cursor);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x950412de, true); // magic, little-endian
  view.setUint32(4, 0, true); // format revision
  view.setUint32(8, count, true);
  view.setUint32(12, originalsTable, true);
  view.setUint32(16, translationsTable, true);
  view.setUint32(20, 0, true); // hash table size: none
  view.setUint32(24, 0, true);

  for (let i = 0; i < count; i++) {
    const original = placed[2 * i]!;
    const translation = placed[2 * i + 1]!;
    view.setUint32(originalsTable + i * 8, original.length, true);
    view.setUint32(originalsTable + i * 8 + 4, original.offset, true);
    view.setUint32(translationsTable + i * 8, translation.length, true);
    view.setUint32(translationsTable + i * 8 + 4, translation.offset, true);
  }
  for (const entry of placed) out.set(entry.blob, entry.offset);
  return out;
}

/** Write a catalogue where {@link initI18n} looks for it, and return the directory to point at. */
function localeDirWith(language: string, mo: Uint8Array): string {
  const root = mkdtempSync(join(tmpdir(), 'curlew-i18n-'));
  const dir = join(root, language, 'LC_MESSAGES');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${TEXT_DOMAIN}.mo`), mo);
  return root;
}

export default async () => {
  await describe('i18n catalogue loading', async () => {
    await it('serves German on a German locale', async () => {
      const dir = localeDirWith('de', buildMo({ [HASH_ERROR]: HASH_ERROR_DE }));
      try {
        const loaded = initI18n({ GJSIFY_LOCALE_DIR: dir, LANG: 'de_DE.UTF-8' });
        expect(loaded).toBe(join(dir, 'de', 'LC_MESSAGES', `${TEXT_DOMAIN}.mo`));
        expect(_(HASH_ERROR)).toBe(HASH_ERROR_DE);
      } finally {
        setCatalogue(undefined);
      }
    });

    await it('falls back to English for a language we do not ship', async () => {
      const dir = localeDirWith('de', buildMo({ [HASH_ERROR]: HASH_ERROR_DE }));
      try {
        // Esperanto: no catalogue anywhere, including /usr/share/locale on any runner.
        expect(initI18n({ GJSIFY_LOCALE_DIR: dir, LANGUAGE: 'eo', LANG: 'eo.UTF-8' })).toBe(undefined);
        expect(activeCatalogue()).toBe(undefined);
        expect(_(HASH_ERROR)).toBe(HASH_ERROR);
      } finally {
        setCatalogue(undefined);
      }
    });

    await it('obeys LC_ALL=C even when LANGUAGE asks for German', async () => {
      // This is what pins the test suite itself to English (see app/package.json's test script).
      const dir = localeDirWith('de', buildMo({ [HASH_ERROR]: HASH_ERROR_DE }));
      try {
        expect(initI18n({ GJSIFY_LOCALE_DIR: dir, LC_ALL: 'C', LANGUAGE: 'de', LANG: 'de_DE.UTF-8' })).toBe(
          undefined,
        );
        expect(_(HASH_ERROR)).toBe(HASH_ERROR);
      } finally {
        setCatalogue(undefined);
      }
    });

    await it('serves a de_AT session from the de catalogue', async () => {
      // Shipping one catalogue per region would be absurd, so the expansion has to work.
      const dir = localeDirWith('de', buildMo({ [HASH_ERROR]: HASH_ERROR_DE }));
      try {
        expect(initI18n({ GJSIFY_LOCALE_DIR: dir, LANG: 'de_AT.UTF-8' })).toBe(
          join(dir, 'de', 'LC_MESSAGES', `${TEXT_DOMAIN}.mo`),
        );
      } finally {
        setCatalogue(undefined);
      }
    });

    await it('survives an empty or missing locale dir', async () => {
      // A broken install has to degrade to English, not take the CLI down before it starts.
      // Esperanto again, because this process DOES have a real de catalogue next to its bundle.
      const empty = mkdtempSync(join(tmpdir(), 'curlew-i18n-'));
      try {
        expect(initI18n({ GJSIFY_LOCALE_DIR: empty, LANG: 'eo.UTF-8' })).toBe(undefined);
        expect(initI18n({ GJSIFY_LOCALE_DIR: join(empty, 'nope'), LANG: 'eo.UTF-8' })).toBe(undefined);
      } finally {
        setCatalogue(undefined);
      }
    });
  });

  await describe('locale candidates', async () => {
    await it('reads the POSIX chain, most specific first', async () => {
      expect(localeCandidates({ LANG: 'de_DE.UTF-8' })).toEqualArray(['de_DE', 'de']);
      expect(localeCandidates({ LANGUAGE: 'de:fr', LANG: 'en_US.UTF-8' })).toEqualArray([
        'de',
        'fr',
        'en_US',
        'en',
      ]);
      expect(localeCandidates({ LC_ALL: 'fr_FR.UTF-8', LANG: 'de_DE.UTF-8' })).toEqualArray(['fr_FR', 'fr']);
      expect(localeCandidates({ LC_MESSAGES: 'de_DE', LANG: 'en_US' })).toEqualArray(['de_DE', 'de']);
    });

    await it('keeps a modifier, and drops the codeset', async () => {
      expect(localeCandidates({ LANG: 'sr_RS.UTF-8@latin' })).toEqualArray([
        'sr_RS@latin',
        'sr_RS',
        'sr@latin',
        'sr',
      ]);
    });

    await it('yields nothing for a neutral or unset locale', async () => {
      expect(localeCandidates({})).toEqualArray([]);
      expect(localeCandidates({ LANG: 'C' })).toEqualArray([]);
      expect(localeCandidates({ LC_ALL: 'POSIX', LANGUAGE: 'de' })).toEqualArray([]);
    });
  });

  await describe('gettext runtime', async () => {
    await it('refuses anything that is not a .mo', async () => {
      expect(() => parseMoCatalogue(new Uint8Array(4))).toThrow(/shorter than its header/);
      expect(() => parseMoCatalogue(new Uint8Array(64))).toThrow(/bad magic number/);
      // A .po handed over by mistake must say so rather than translate nothing.
      expect(() =>
        parseMoCatalogue(new TextEncoder().encode(`msgid ""\nmsgstr ""\n${' '.repeat(40)}`)),
      ).toThrow(/bad magic number/);
    });

    await it('takes the plural rule from the catalogue, not from the call site', async () => {
      // Polish: three forms, and 2 is not the same form as 1 or 5.
      const polish = parseMoCatalogue(
        buildMo(
          { 'one file\u0000{count} files': 'plik\u0000{count} pliki\u0000{count} plików' },
          'Language: pl\nPlural-Forms: nplurals=3; plural=(n==1 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);\n',
        ),
      );
      setCatalogue(polish);
      try {
        expect(polish.nplurals).toBe(3);
        expect(_n('one file', '{count} files', 1)).toBe('plik');
        expect(_n('one file', '{count} files', 3)).toBe('{count} pliki');
        expect(_n('one file', '{count} files', 7)).toBe('{count} plików');
      } finally {
        setCatalogue(undefined);
      }
      // And without a catalogue, English's own rule.
      expect(_n('one file', '{count} files', 1)).toBe('one file');
      expect(_n('one file', '{count} files', 2)).toBe('{count} files');
    });

    await it('fills named placeholders and leaves unknown ones visible', async () => {
      expect(fmt('{a} and {b}', { a: 'x', b: 2 })).toBe('x and 2');
      // A typo in a translation has to be legible as a typo, not printed as "undefined".
      expect(fmt('{acount}', { account: 'a' })).toBe('{acount}');
    });
  });

  await describe('wired call sites', async () => {
    await it('translates a Telegram error raised after the catalogue is installed', async () => {
      // The point of the lazy where()/getter refactor: these strings are built per call, so a
      // catalogue installed at startup reaches them. A module-level _() would be English here.
      setCatalogue(parseMoCatalogue(buildMo({ [HASH_ERROR]: HASH_ERROR_DE })));
      try {
        let message = '';
        try {
          parseCredentials(1, 'not-a-hash-secret-value');
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        expect(message).toMatch(/32 hexadezimalen/);
        expect(message.includes('not-a-hash-secret-value')).toBe(false);
      } finally {
        setCatalogue(undefined);
      }
      expect(TELEGRAM_MANIFEST.terms?.summary.includes('api_id')).toBe(true);
    });

    await it('translates the manifest terms through their getter', async () => {
      const summary = TELEGRAM_MANIFEST.terms!.summary;
      setCatalogue(parseMoCatalogue(buildMo({ [summary]: 'Zusammenfassung auf Deutsch' })));
      try {
        expect(TELEGRAM_MANIFEST.terms!.summary).toBe('Zusammenfassung auf Deutsch');
      } finally {
        setCatalogue(undefined);
      }
      expect(TELEGRAM_MANIFEST.terms!.summary).toBe(summary);
    });
  });
};
