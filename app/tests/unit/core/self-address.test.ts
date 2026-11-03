import { describe, expect, it } from '@gjsify/unit';

import { isOwnMailAddress } from '@curlew/imap';
import { isOwnUserId } from '@curlew/matrix';
import { isOwnAci } from '@curlew/signal';
import { isOwnChatId } from '@curlew/telegram';
import { isOwnJid } from '@curlew/whatsapp';
import { isOwnBareJid } from '@curlew/xmpp';

/** Each backend's own-address knowledge (ADR 0008), pure: no session, no config, synthetic ids. */

const ACI = '5b5a4c62-2f39-4e59-9d0e-1f4d7c3a0b11';
const OTHER_ACI = '6c6b5d73-3f4a-4f6a-8e1f-2a5e8d4b1c22';

export default async () => {
  await describe('own address, per backend', async () => {
    await it('Signal: the own ACI is self, another or a PNI id is not', async () => {
      const account = `signal-${ACI}`;
      expect(isOwnAci(account, ACI)).toBe(true);
      expect(isOwnAci(account, ACI.toUpperCase())).toBe(true);
      expect(isOwnAci(account, OTHER_ACI)).toBe(false);
      expect(isOwnAci(account, `PNI:${ACI}`)).toBe(false);
      expect(isOwnAci(account, '+4915112345678')).toBe(false);
      expect(isOwnAci('not-an-account', ACI)).toBe(false);
    });

    await it('WhatsApp: own JID and own LID, with or without device; lookalikes are not', async () => {
      const me = { id: '4915112345678:7@s.whatsapp.net', lid: '100000000000009:7@lid' };
      expect(isOwnJid(me, '4915112345678@s.whatsapp.net')).toBe(true);
      expect(isOwnJid(me, '4915112345678:3@s.whatsapp.net')).toBe(true);
      expect(isOwnJid(me, '100000000000009@lid')).toBe(true);
      expect(isOwnJid(me, '100000000000009:2@lid')).toBe(true);
      expect(isOwnJid(me, '4915112345679@s.whatsapp.net')).toBe(false);
      expect(isOwnJid(me, '100000000000008@lid')).toBe(false);
      // The same digits in the other kind of id are somebody else.
      expect(isOwnJid(me, '4915112345678@lid')).toBe(false);
      expect(isOwnJid(me, '100000000000009@s.whatsapp.net')).toBe(false);
      expect(isOwnJid(me, '4915112345678@g.us')).toBe(false);
      expect(isOwnJid(null, '4915112345678@s.whatsapp.net')).toBe(false);
      expect(isOwnJid({}, '4915112345678@s.whatsapp.net')).toBe(false);
    });

    await it('XMPP: the bare JID with any resource and case; another domain is not', async () => {
      expect(isOwnBareJid('bot@example.org', 'bot@example.org')).toBe(true);
      expect(isOwnBareJid('bot@example.org', 'Bot@Example.org/phone')).toBe(true);
      expect(isOwnBareJid('bot@example.org', 'bot@example.com')).toBe(false);
      expect(isOwnBareJid('bot@example.org', 'bot2@example.org')).toBe(false);
      expect(isOwnBareJid('example.org', 'example.org')).toBe(false);
    });

    await it('Mail: the own address, case-insensitive and whole; a sub-address is not', async () => {
      expect(isOwnMailAddress('me@example.org', 'ME@Example.org')).toBe(true);
      expect(isOwnMailAddress('me@example.org', 'me@example.com')).toBe(false);
      expect(isOwnMailAddress('me@example.org', 'me+tag@example.org')).toBe(false);
      expect(isOwnMailAddress('me@example.org', 'Me <me@example.org>')).toBe(false);
      expect(isOwnMailAddress('', '')).toBe(false);
    });

    await it('Matrix: the own user id is self, a room never is', async () => {
      expect(isOwnUserId('@me:example.org', '@me:example.org')).toBe(true);
      expect(isOwnUserId('@me:example.org', '@ME:example.org')).toBe(true);
      expect(isOwnUserId('@me:example.org', '@me:example.com')).toBe(false);
      expect(isOwnUserId('@me:example.org', '!room:example.org')).toBe(false);
      expect(isOwnUserId('Some Name', 'Some Name')).toBe(false);
    });

    await it('Telegram: the own user id is Saved Messages, a group or another id is not', async () => {
      expect(isOwnChatId('telegram-42', '42')).toBe(true);
      expect(isOwnChatId('telegram-42', '43')).toBe(false);
      expect(isOwnChatId('telegram-42', '-42')).toBe(false);
      expect(isOwnChatId('telegram-42', '420')).toBe(false);
      expect(isOwnChatId('other-42', '42')).toBe(false);
    });
  });
};
