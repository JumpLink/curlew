import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';

/** What a dummy server was asked, in order. AUTH lines are kept whole. */
export interface Dialogue {
  commands: string[];
  /** The raw DATA payload of each accepted message. */
  messages: string[];
}

export interface DummyOptions {
  /** Answer AUTH with 535 and put this text, a secret the client sent, into the reply. */
  rejectAuthEchoing?: string;
  /** RCPT TO for these addresses gets a 550. */
  rejectRecipients?: string[];
}

export interface DummyServer {
  port: number;
  dialogue: Dialogue;
  close(): Promise<void>;
}

/**
 * A small plaintext SMTP server on 127.0.0.1, for what an SMTP client does without TLS: EHLO,
 * AUTH PLAIN / XOAUTH2, MAIL FROM, RCPT TO, DATA. It advertises no STARTTLS and records the
 * dialogue, so a test can say what the client DID, not only what it returned.
 */
export async function startDummyServer(options: DummyOptions = {}): Promise<DummyServer> {
  const dialogue: Dialogue = { commands: [], messages: [] };
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});

    let buffer = '';
    let data: string[] | null = null;
    const reply = (line: string) => socket.write(`${line}\r\n`);

    const command = (line: string) => {
      dialogue.commands.push(line);
      const verb = line.split(' ')[0].toUpperCase();
      if (verb === 'EHLO' || verb === 'HELO') {
        socket.write('250-dummy\r\n250-AUTH PLAIN LOGIN XOAUTH2\r\n250 8BITMIME\r\n');
      } else if (verb === 'AUTH') {
        if (options.rejectAuthEchoing !== undefined)
          reply(`535 5.7.8 rejected: ${options.rejectAuthEchoing}`);
        else reply('235 2.7.0 ok');
      } else if (verb === 'RCPT') {
        const to = /<([^>]*)>/.exec(line)?.[1] ?? '';
        reply(options.rejectRecipients?.includes(to) ? '550 5.1.1 no such user' : '250 ok');
      } else if (verb === 'DATA') {
        data = [];
        reply('354 go ahead');
      } else if (verb === 'QUIT') {
        reply('221 bye');
        socket.end();
      } else {
        reply('250 ok');
      }
    };

    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      for (;;) {
        if (data) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          dialogue.messages.push(buffer.slice(0, end + 2));
          buffer = buffer.slice(end + 5);
          data = null;
          reply('250 2.0.0 queued');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        command(line);
      }
    });

    reply('220 dummy ESMTP');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    port: (server.address() as AddressInfo).port,
    dialogue,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
