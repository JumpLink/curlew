import { describe, expect, it } from '@gjsify/unit';

import { escapeMarkup, hasRichText, richMarkup } from '../../../src/window/rich-text-model.ts';

export default async () => {
  await describe('richMarkup', async () => {
    await it('escapes plain text and leaves it otherwise alone', async () => {
      expect(richMarkup('a < b & "c"')).toBe('a &lt; b &amp; &quot;c&quot;');
      expect(richMarkup('see you at ten')).toBe('see you at ten');
      expect(richMarkup('')).toBe('');
    });

    await it('styles bold, italic, strike and code', async () => {
      expect(richMarkup('a **bold** b')).toBe('a <b>bold</b> b');
      expect(richMarkup('a *it* and _it_')).toBe('a <i>it</i> and <i>it</i>');
      expect(richMarkup('~~gone~~')).toBe('<s>gone</s>');
      expect(richMarkup('run `a < b` now')).toBe('run <tt>a &lt; b</tt> now');
    });

    await it('nests styles and keeps code literal', async () => {
      expect(richMarkup('**bold _and italic_**')).toBe('<b>bold <i>and italic</i></b>');
      expect(richMarkup('`**not bold**`')).toBe('<tt>**not bold**</tt>');
    });

    await it('leaves delimiters without a partner as typed', async () => {
      expect(richMarkup('2 * 3 * 4')).toBe('2 * 3 * 4');
      expect(richMarkup('a **b')).toBe('a **b');
      expect(richMarkup('snake_case_name')).toBe('snake_case_name');
      expect(richMarkup('**a\nb**')).toBe('**a\nb**');
      expect(richMarkup('* item')).toBe('* item');
      expect(richMarkup('`open')).toBe('`open');
    });

    await it('links http and https addresses and shows the address itself', async () => {
      expect(richMarkup('go to https://example.org/a?b=1&c=2 now')).toBe(
        'go to <a href="https://example.org/a?b=1&amp;c=2">https://example.org/a?b=1&amp;c=2</a> now',
      );
      expect(richMarkup('http://example.org')).toBe('<a href="http://example.org">http://example.org</a>');
    });

    await it('leaves sentence punctuation and a closing bracket out of the link', async () => {
      expect(richMarkup('(see https://example.org/x).')).toBe(
        '(see <a href="https://example.org/x">https://example.org/x</a>).',
      );
      expect(richMarkup('https://example.org/a_(b)')).toBe(
        '<a href="https://example.org/a_(b)">https://example.org/a_(b)</a>',
      );
      expect(richMarkup('really https://example.org?')).toBe(
        'really <a href="https://example.org">https://example.org</a>?',
      );
    });

    await it('does not style inside a link and ignores other schemes', async () => {
      expect(richMarkup('https://example.org/a_b_c')).toBe(
        '<a href="https://example.org/a_b_c">https://example.org/a_b_c</a>',
      );
      expect(richMarkup('javascript:alert(1) ftp://example.org https://')).toBe(
        'javascript:alert(1) ftp://example.org https://',
      );
    });

    await it('never lets a link end inside markup it did not open', async () => {
      expect(richMarkup('**https://example.org**')).toBe(
        '<b><a href="https://example.org">https://example.org</a></b>',
      );
    });
  });

  await describe('hasRichText', async () => {
    await it('is true only when the text has links or styles', async () => {
      expect(hasRichText('plain & simple')).toBe(false);
      expect(hasRichText('a **b**')).toBe(true);
      expect(hasRichText('https://example.org')).toBe(true);
    });
  });

  await describe('escapeMarkup', async () => {
    await it('escapes the four characters Pango reads as syntax', async () => {
      expect(escapeMarkup('<&>"')).toBe('&lt;&amp;&gt;&quot;');
    });
  });
};
