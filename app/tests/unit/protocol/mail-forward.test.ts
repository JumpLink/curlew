import { describe, expect, it } from '@gjsify/unit';

import { FORWARD_HEADER, forwardedBody, parseForwarded } from '@curlew/protocol';

export default async () => {
  await describe('mail forward', async () => {
    await it('writes the header character by character', async () => {
      expect(FORWARD_HEADER).toBe('-'.repeat(10) + ' Forwarded message ' + '-'.repeat(10));
      expect(forwardedBody('anna@example.org', 'Hello')).toBe(
        '---------- Forwarded message ----------\nFrom: anna@example.org\n\nHello',
      );
    });

    await it('reads back what it wrote', async () => {
      expect(parseForwarded(forwardedBody('anna@example.org', 'Hi\nthere'))).toStrictEqual({
        from: 'anna@example.org',
        text: 'Hi\nthere',
      });
      expect(parseForwarded(`${FORWARD_HEADER}\r\nFrom: a@example.org\r\n\r\nHi`)?.text).toBe('Hi');
    });

    await it('keeps a forward without a second line', async () => {
      expect(parseForwarded(`${FORWARD_HEADER}\n\nHi`)).toStrictEqual({ from: null, text: 'Hi' });
    });

    await it('does not take a text that only looks similar', async () => {
      expect(parseForwarded('--------- Forwarded message ---------\nFrom: a@example.org\n\nHi')).toBe(null);
      expect(parseForwarded(`See below\n${FORWARD_HEADER}\nFrom: a@example.org`)).toBe(null);
      expect(parseForwarded(` ${FORWARD_HEADER}`)).toBe(null);
      expect(parseForwarded('')).toBe(null);
      expect(parseForwarded(null)).toBe(null);
    });
  });
};
