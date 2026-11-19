import { describe, expect, it } from '@gjsify/unit';

import { ImapClient } from '@curlew/imap';
import { BufferSink, type MailTarget } from '@curlew/protocol';

import { ScriptedStream } from './scripted-stream.ts';

// Synthetic only: an example.org account and a scripted server, no socket.
const TARGET: MailTarget = {
  accountId: 'acc',
  host: 'imap.example.org',
  port: 993,
  user: 'owner@example.org',
  implicitTls: true,
  getPassword: () => 'synthetic',
};

const GREETING = '* OK [CAPABILITY IMAP4rev1 SPECIAL-USE] ready\r\n';

/** A client connected to a scripted server; `answer` sees each write of the client. */
async function connected(answer: (written: string) => string | undefined, greeting = GREETING) {
  const stream = new ScriptedStream(greeting, answer);
  const opened: MailTarget[] = [];
  const client = new ImapClient(async (target) => {
    opened.push(target);
    return stream;
  });
  await client.connect(TARGET);
  return { client, stream, opened };
}

const tagOf = (written: string) => written.split(' ')[0];

export default async () => {
  await describe('ImapClient over a ByteStream', async () => {
    await it('opens the stream through the injected opener and reads the greeting', async () => {
      const { client, opened } = await connected(() => undefined);
      expect(opened.length).toBe(1);
      expect(opened[0].host).toBe('imap.example.org');
      expect(client.has('special-use')).toBe(true);
    });

    await it('refuses a server that does not greet with OK', async () => {
      await expect(connected(() => undefined, '* BYE busy\r\n')).rejects.toThrow(/unexpected IMAP greeting/);
    });

    await it('opens a mailbox read-only and reads its cursor', async () => {
      const { client, stream } = await connected((w) =>
        w.includes('EXAMINE')
          ? `* 3 EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT 42] ok\r\n${tagOf(w)} OK done\r\n`
          : undefined,
      );
      const status = await client.examine('INBOX');
      expect(status.exists).toBe(3);
      expect(status.uidValidity).toBe(7);
      expect(status.uidNext).toBe(42);
      expect(stream.written[0]).toBe('a1 EXAMINE "INBOX"\r\n');
    });

    await it('waits for the continuation before it sends an APPEND literal', async () => {
      let tag = '';
      const { client, stream } = await connected((w) => {
        if (w.includes('APPEND')) {
          tag = tagOf(w);
          return '+ go ahead\r\n';
        }
        return w === '\r\n' ? `${tag} OK appended\r\n` : undefined;
      });
      await client.append('Sent', new TextEncoder().encode('hello'));
      expect(stream.written).toStrictEqual(['a1 APPEND "Sent" (\\Seen) {5}\r\n', 'hello', '\r\n']);
    });

    await it('streams a part into a sink and drains an oversized one', async () => {
      const part = (w: string) =>
        w.includes('BODY.PEEK[1]')
          ? `* 1 FETCH (BODY[1] {6}\r\nabcdef)\r\n${tagOf(w)} OK done\r\n`
          : undefined;
      const { client } = await connected(part);

      const sink = new BufferSink();
      const taken = await client.fetchSectionTo('9', '1', sink, 100);
      expect(taken.bytes).toBe(6);
      expect(sink.closed).toBe(true);

      const refusedSink = new BufferSink();
      const refused = await client.fetchSectionTo('9', '1', refusedSink, 3);
      expect(refused.refused).toBe(true);
      expect(refusedSink.aborted !== null).toBe(true);
      // The connection is still in step: the next command reads its own answer.
      const again = await client.fetchSectionTo('9', '1', new BufferSink(), 100);
      expect(again.bytes).toBe(6);
    });

    await it('reports a connection that ends mid-command', async () => {
      const { client, stream } = await connected((w) => (w.includes('LOGIN') ? '* halfway\r\n' : undefined));
      const login = client.login('owner@example.org', 'synthetic');
      await stream.close();
      await expect(login).rejects.toThrow(/closed unexpectedly/);
    });

    await it('closes the stream on logout, also when the server no longer answers', async () => {
      const { client, stream } = await connected((w) => (w.includes('LOGOUT') ? undefined : undefined));
      const logout = client.logout();
      await stream.close();
      await logout;
      expect(stream.closed >= 2).toBe(true);
    });
  });
};
