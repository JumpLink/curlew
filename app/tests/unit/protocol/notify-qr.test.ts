import { describe, expect, it } from '@gjsify/unit';
import { notifyQr, type AccountPrompter } from '@curlew/protocol';

export default async () => {
  await describe('notifyQr', async () => {
    await it('hands the payload to a prompter that can show an image', async () => {
      const seen: string[] = [];
      const prompter: AccountPrompter = {
        ask: async () => '',
        notify: (message) => void seen.push(`notify:${message}`),
        showQr: (data, instructions) => void seen.push(`qr:${data}|${instructions}`),
      };
      notifyQr(prompter, 'payload', 'Scan it', () => 'TEXT');
      expect(seen).toStrictEqual(['qr:payload|Scan it']);
    });

    await it('passes the link option on to a prompter that shows an image', async () => {
      const seen: unknown[] = [];
      const prompter: AccountPrompter = {
        ask: async () => '',
        notify: () => {},
        showQr: (_data, _instructions, options) => void seen.push(options),
      };
      notifyQr(prompter, 'sgnl://x', 'Open it', () => 'TEXT', { link: true });
      expect(seen).toStrictEqual([{ link: true }]);
    });

    await it('falls back to the text rendering through notify', async () => {
      const seen: string[] = [];
      const prompter: AccountPrompter = { ask: async () => '', notify: (message) => void seen.push(message) };
      notifyQr(prompter, 'payload', 'Scan it', (data) => `TEXT(${data})`);
      expect(seen).toStrictEqual(['TEXT(payload)\nScan it']);
    });
  });
};
