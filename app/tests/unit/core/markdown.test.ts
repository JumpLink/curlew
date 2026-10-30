import { describe, expect, it } from '@gjsify/unit';

import { MAX_CHUNK_CHARS, renderForXmpp, renderPlainText, stripQuotes } from '../../../src/core/markdown.ts';
import { TELEGRAM_MAX_MESSAGE_CHARS as BACKEND_LIMIT } from '@curlew/telegram';
import { MATRIX_MAX_MESSAGE_BYTES as MATRIX_BACKEND_LIMIT } from '@curlew/matrix';
import { SIGNAL_MAX_MESSAGE_BYTES as SIGNAL_BACKEND_LIMIT } from '@curlew/signal';
import {
  MATRIX_MAX_MESSAGE_BYTES,
  messagingCapabilities,
  SIGNAL_MAX_MESSAGE_BYTES,
  TELEGRAM_MAX_MESSAGE_CHARS,
} from '../../../src/core/actions/messaging.ts';
import { WAIT_TIMEOUT_S } from '../../../src/core/actions/wait-reply.ts';

const texts = (md: string) => renderForXmpp(md).map((s) => (s.kind === 'text' ? s.text : `[image ${s.url}]`));

export default async () => {
  await describe('markdown → XEP-0393', async () => {
    await it('turns headings and bold into *bold*', async () => {
      expect(texts('# Title\n\n**bold** text').join('|')).toBe('*Title*\n\n*bold* text');
    });

    await it('turns italic into _italic_ and strike into ~strike~', async () => {
      expect(texts('*it* and ~~gone~~').join('|')).toBe('_it_ and ~gone~');
    });

    await it('keeps code spans and fences untouched', async () => {
      expect(texts('`**x**`').join('|')).toBe('`**x**`');
      expect(texts('```\n**x**\n- y\n```').join('|')).toBe('```\n**x**\n- y\n```');
    });

    await it('uses bullets, keeps quotes, drops rules', async () => {
      expect(texts('- one\n* two\n\n> quoted\n\n---').join('|')).toBe('• one\n• two\n\n> quoted');
    });

    await it('writes a link as "label: url"', async () => {
      expect(texts('[docs](https://example.org/a_(b))').join('|')).toBe('docs: https://example.org/a_(b)');
    });

    await it('splits at an image line, in order', async () => {
      expect(texts('before\n![a](https://example.org/a.png)\nafter').join('|')).toBe(
        'before|[image https://example.org/a.png]|after',
      );
    });

    await it('keeps images beyond the cap as links', async () => {
      const md = '![a](https://example.org/1.png)\n![b](https://example.org/2.png)';
      const out = renderForXmpp(md, 1);
      expect(out.filter((s) => s.kind === 'image').length).toBe(1);
      const last = out[1];
      expect(last.kind === 'text' ? last.text : '').toBe('b: https://example.org/2.png');
    });
  });

  await describe('splitting long texts', async () => {
    await it('does not split a short text', async () => {
      expect(renderForXmpp('short').length).toBe(1);
    });

    await it('splits at blank lines and keeps every part within the limit', async () => {
      const paragraph = 'word '.repeat(300).trim();
      const md = Array.from({ length: 12 }, () => paragraph).join('\n\n');
      const parts = renderForXmpp(md);
      expect(parts.length > 1).toBe(true);
      for (const part of parts) {
        expect(part.kind).toBe('text');
        if (part.kind === 'text') expect(part.text.length <= MAX_CHUNK_CHARS).toBe(true);
      }
    });

    await it('cuts an unbroken run at the limit', async () => {
      const parts = renderForXmpp('x'.repeat(MAX_CHUNK_CHARS * 2 + 5));
      expect(parts.length).toBe(3);
    });

    await it('honours a smaller limit', async () => {
      expect(renderForXmpp('aaa bbb ccc', 8, 5).length).toBe(3);
    });
  });

  await describe('markdown as plain text', async () => {
    await it('removes the markers and keeps links complete', async () => {
      const out = renderPlainText('# Title\n\n**b** *i* `c` [l](https://example.org)\n- item');
      expect(out.join('|')).toBe('Title\n\nb i c l: https://example.org\n• item');
    });

    await it('splits long texts', async () => {
      expect(renderPlainText('x'.repeat(25), 10).length).toBe(3);
    });
  });

  await describe('stripQuotes', async () => {
    await it('returns text without a quote unchanged', async () => {
      expect(stripQuotes('hello\nworld')).toBe('hello\nworld');
    });

    await it('drops a leading quote block and the blank line after it', async () => {
      expect(stripQuotes('> old question\n> more\n\nmy answer')).toBe('my answer');
    });

    await it('drops quoted lines in the middle too', async () => {
      expect(stripQuotes('a\n> q\nb')).toBe('a\nb');
    });

    await it('keeps a message that is only a quote', async () => {
      expect(stripQuotes('> only')).toBe('> only');
    });
  });

  await describe('messaging_capabilities', async () => {
    await it('reports the XMPP limits without any address', async () => {
      const caps = messagingCapabilities('/nonexistent/curlew-config.json').protocols;
      expect(caps.length).toBe(4);
      const xmpp = caps[0];
      expect(xmpp.protocol).toBe('xmpp');
      expect(xmpp.maxMessageChars).toBe(8000);
      expect(xmpp.formats.join()).toBe('plain,markdown');
      expect(xmpp.images.supported).toBe(true);
      expect(xmpp.splitsLongText).toBe(true);
      expect(xmpp.waitTimeoutS.max).toBe(WAIT_TIMEOUT_S.max);
      expect(xmpp.waitTimeoutS.max).toBe(120);
      expect(xmpp.accounts.length).toBe(0);
    });

    await it('reports Telegram as plain text, 4096 characters, no splitting, no image', async () => {
      const telegram = messagingCapabilities('/nonexistent/curlew-config.json').protocols[1];
      expect(telegram.protocol).toBe('telegram');
      expect(telegram.maxMessageChars).toBe(TELEGRAM_MAX_MESSAGE_CHARS);
      expect(TELEGRAM_MAX_MESSAGE_CHARS).toBe(BACKEND_LIMIT);
      expect(BACKEND_LIMIT).toBe(4096);
      expect(telegram.formats.join()).toBe('plain');
      expect(telegram.splitsLongText).toBe(false);
      expect(telegram.images.supported).toBe(false);
      expect(telegram.accounts.length).toBe(0);
    });

    await it('reports Matrix as plain text, 32000 bytes, no splitting, no image', async () => {
      const matrix = messagingCapabilities('/nonexistent/curlew-config.json').protocols[2];
      expect(matrix.protocol).toBe('matrix');
      expect(matrix.maxMessageBytes).toBe(MATRIX_MAX_MESSAGE_BYTES);
      expect(MATRIX_MAX_MESSAGE_BYTES).toBe(MATRIX_BACKEND_LIMIT);
      expect(MATRIX_BACKEND_LIMIT).toBe(32000);
      // A character is at least one byte, so the byte limit is a safe character ceiling.
      expect(matrix.maxMessageChars).toBe(MATRIX_MAX_MESSAGE_BYTES);
      expect(matrix.formats.join()).toBe('plain');
      expect(matrix.splitsLongText).toBe(false);
      expect(matrix.images.supported).toBe(false);
      expect(matrix.accounts.length).toBe(0);
    });

    await it('reports Signal as plain text, 2048 bytes, no splitting, no image', async () => {
      const signal = messagingCapabilities('/nonexistent/curlew-config.json').protocols[3];
      expect(signal.protocol).toBe('signal');
      expect(signal.maxMessageBytes).toBe(SIGNAL_MAX_MESSAGE_BYTES);
      expect(SIGNAL_MAX_MESSAGE_BYTES).toBe(SIGNAL_BACKEND_LIMIT);
      expect(SIGNAL_BACKEND_LIMIT).toBe(2048);
      expect(signal.maxMessageChars).toBe(SIGNAL_MAX_MESSAGE_BYTES);
      expect(signal.formats.join()).toBe('plain');
      expect(signal.splitsLongText).toBe(false);
      expect(signal.images.supported).toBe(false);
      expect(signal.accounts.length).toBe(0);
    });
  });
};
