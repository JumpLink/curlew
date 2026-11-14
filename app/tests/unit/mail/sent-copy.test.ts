import { describe, expect, it } from '@gjsify/unit';

import { MailSender, fileSentCopy, providerFilesSentMail } from '@curlew/imap';
import type { SentFolderSession } from '@curlew/imap';
import type { FolderInfo, SendPermit, SmtpTarget } from '@curlew/protocol';

import { startDummyServer } from '../smtp/dummy-server.ts';

// Synthetic only: example.org addresses, a loopback SMTP dummy, a fake IMAP session.
const FROM = 'sender@example.org';
const OWNER = 'owner@example.org';
const PERMIT: SendPermit = { account: 'acc', addresses: [OWNER] };

function folder(path: string, role: FolderInfo['role']): FolderInfo {
  return {
    path,
    name: path,
    delimiter: '/',
    attributes: [],
    selectable: true,
    role,
    roleSource: 'special-use',
  };
}

function fakeSession(folders: FolderInfo[], existing: string[] = []) {
  const appended: Array<{ path: string; raw: Uint8Array }> = [];
  const session: SentFolderSession = {
    listFolders: async () => folders,
    hasMessageId: async (_path, id) => existing.includes(id),
    append: async (path, raw) => {
      appended.push({ path, raw });
    },
  };
  return { session, appended };
}

const RAW = new TextEncoder().encode('Message-ID: <a@example.org>\r\n\r\nhi\r\n');

export default async () => {
  await describe('keeping the sent copy of a mail', async () => {
    await it('appends to the Sent mailbox once', async () => {
      const { session, appended } = fakeSession([folder('INBOX', 'inbox'), folder('Sent', 'sent')]);
      const outcome = await fileSentCopy(session, RAW, '<a@example.org>', 'imap.example.org');
      expect(outcome).toBe('filed');
      expect(appended.length).toBe(1);
      expect(appended[0].path).toBe('Sent');
    });

    await it('does not append where the provider files submissions itself', async () => {
      const { session, appended } = fakeSession([folder('Sent', 'sent')]);
      expect(providerFilesSentMail('IMAP.gmail.com')).toBe(true);
      expect(await fileSentCopy(session, RAW, '<a@example.org>', 'imap.gmail.com')).toBe('provider-files-it');
      expect(appended.length).toBe(0);
    });

    await it('does not append when the Message-ID is already in Sent', async () => {
      const { session, appended } = fakeSession([folder('Sent', 'sent')], ['<a@example.org>']);
      expect(await fileSentCopy(session, RAW, '<a@example.org>', 'imap.example.org')).toBe('already-there');
      expect(appended.length).toBe(0);
    });

    await it('throws when the account has no Sent mailbox', async () => {
      const { session } = fakeSession([folder('INBOX', 'inbox')]);
      let failed = false;
      try {
        await fileSentCopy(session, RAW, '<a@example.org>', 'imap.example.org');
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    });
  });

  await describe('MailSender and the sent copy', async () => {
    const target = (port: number): SmtpTarget => ({
      accountId: 'acc',
      from: FROM,
      host: '127.0.0.1',
      port,
      user: FROM,
      security: 'none',
      getPassword: () => 'pw',
    });

    await it('files the exact message that went out', async () => {
      const server = await startDummyServer();
      try {
        let filed = '';
        let filedId = '';
        const sender = new MailSender(target(server.port), PERMIT, async (raw, id) => {
          filed = new TextDecoder().decode(raw);
          filedId = id;
          return 'filed';
        });
        const sent = await sender.send({ to: OWNER, text: 'Hallo\n', subject: 'Betreff' });
        expect(filedId).toBe(sent.id);
        expect(filed.includes(`Message-ID: ${sent.id}`)).toBe(true);
        expect(filed.includes('Subject: Betreff')).toBe(true);
        expect(sent.warning).toBe(undefined);
        expect(server.dialogue.messages.length).toBe(1);
      } finally {
        await server.close();
      }
    });

    await it('a failing APPEND is a warning, not a failed send', async () => {
      const server = await startDummyServer();
      try {
        const sender = new MailSender(target(server.port), PERMIT, async () => {
          throw new Error('mailbox full');
        });
        const sent = await sender.send({ to: OWNER, text: 'Hallo\n' });
        expect(server.dialogue.messages.length).toBe(1);
        expect(sent.warning?.includes('mailbox full')).toBe(true);
      } finally {
        await server.close();
      }
    });
  });
};
