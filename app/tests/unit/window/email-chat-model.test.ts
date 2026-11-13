import { describe, expect, it } from '@gjsify/unit';

import { defaultConfig, parseConfig } from '../../../src/core/config.ts';
import {
  deltaChatPageText,
  emailChatExplanation,
  hiddenMailNote,
  shouldShowEmailChatHint,
  withHintSeen,
} from '../../../src/window/email-chat-model.ts';

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

    it('names the switch that brings ordinary mail back', () => {
      expect(hiddenMailNote().includes('Show all emails')).toBe(true);
    });

    it('puts the explanation and the hidden-mail note on the welcome Delta Chat page', () => {
      const text = deltaChatPageText();
      expect(text.startsWith(emailChatExplanation())).toBe(true);
      expect(text.endsWith(hiddenMailNote())).toBe(true);
      expect(text.includes('\n\n')).toBe(true);
    });

    it('records an account once', () => {
      expect(withHintSeen(undefined, 'mail-a')).toStrictEqual(['mail-a']);
      expect(withHintSeen(['mail-a'], 'mail-a')).toStrictEqual(['mail-a']);
    });

    it('lists only email chats unless the person asks for all mail', () => {
      expect(parseConfig('{}').ui.showAllEmails).toBe(false);
      expect(defaultConfig().ui.showAllEmails).toBe(false);
      expect(parseConfig('{"ui":{"showAllEmails":true}}').ui.showAllEmails).toBe(true);
    });

    it('reads and rejects the config field', () => {
      expect(parseConfig('{"ui":{"emailChatHintSeen":["mail-a"]}}').ui.emailChatHintSeen).toStrictEqual([
        'mail-a',
      ]);
      expect(() => parseConfig('{"ui":{"emailChatHintSeen":"x"}}')).toThrow();
    });
  });
};
