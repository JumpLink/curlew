import { describe, expect, it } from '@gjsify/unit';

import { parseConfig } from '../../../src/core/config.ts';
import { shouldShowEmailChatHint, withHintSeen } from '../../../src/window/email-chat-model.ts';

export default async () => {
  describe('the email chat hint', () => {
    const chat = { backend: 'mail', emailChat: true, accountId: 'mail-a' };

    it('shows in an email chat of a mail account until dismissed for that account', () => {
      expect(shouldShowEmailChatHint(chat, undefined)).toBe(true);
      expect(shouldShowEmailChatHint(chat, ['mail-a'])).toBe(false);
      expect(shouldShowEmailChatHint(chat, ['mail-b'])).toBe(true);
    });

    it('never shows in an ordinary mail thread or another protocol', () => {
      expect(shouldShowEmailChatHint({ ...chat, emailChat: false }, undefined)).toBe(false);
      expect(shouldShowEmailChatHint({ ...chat, backend: 'xmpp' }, undefined)).toBe(false);
    });

    it('records an account once', () => {
      expect(withHintSeen(undefined, 'mail-a')).toStrictEqual(['mail-a']);
      expect(withHintSeen(['mail-a'], 'mail-a')).toStrictEqual(['mail-a']);
    });

    it('reads and rejects the config field', () => {
      expect(parseConfig('{"ui":{"emailChatHintSeen":["mail-a"]}}').ui.emailChatHintSeen).toStrictEqual([
        'mail-a',
      ]);
      expect(() => parseConfig('{"ui":{"emailChatHintSeen":"x"}}')).toThrow();
    });
  });
};
