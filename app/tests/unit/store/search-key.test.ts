import { describe, expect, it } from '@gjsify/unit';

import { findSearchMatches, normaliseSearchText, searchKey, searchPattern } from '@curlew/store';

await describe('search key', async () => {
  await it('drops punctuation and separators and folds case and diacritics', async () => {
    expect(normaliseSearchText('GTK-JS')).toBe('gtkjs');
    expect(normaliseSearchText('gtk.js')).toBe('gtkjs');
    expect(normaliseSearchText(' gtk / js_')).toBe('gtkjs');
    expect(normaliseSearchText('Äpfel Ünd Öl')).toBe('apfelundol');
    expect(normaliseSearchText('Grüße')).toBe('grusse');
    expect(normaliseSearchText('ＧＴＫ')).toBe('gtk');
    expect(normaliseSearchText('50% 5_%')).toBe('505');
    expect(normaliseSearchText('...')).toBe('');
  });

  await it('keeps letters of other scripts and digits', async () => {
    expect(normaliseSearchText('Привет, МИР 42')).toBe('приветмир42');
    expect(normaliseSearchText('東京-タワー')).toBe('東京タワー');
  });

  await it('keeps subject and body apart', async () => {
    expect(searchKey('Ab', 'cd')).toBe('ab\ncd');
    expect(searchKey(null, null)).toBe('\n');
    expect(searchPattern('a b')).toBe('%ab%');
    expect(searchPattern('--')).toBeNull();
  });

  await it('locates a match in the original text, separators included', async () => {
    const text = 'We port GTK-JS and gtk.js.';
    expect(findSearchMatches(text, 'gtkjs')).toStrictEqual([{ start: 8, end: 14 }]);
    expect(findSearchMatches(text, 'gtkjs', true)).toStrictEqual([
      { start: 8, end: 14 },
      { start: 19, end: 25 },
    ]);
    expect(findSearchMatches('Grüße', 'grusse')).toStrictEqual([{ start: 0, end: 5 }]);
    expect(findSearchMatches('abc', '')).toStrictEqual([]);
  });
});
