import type { AccountPrompter, BackendContext } from '@curlew/protocol';
import { WhatsAppBackend } from '@curlew/whatsapp';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeFactory, type FakeSocket } from './fake-socket.ts';

/**
 * The account the WhatsApp suites run as, and the link that puts it on disk. Shared by the
 * receive suite and the send suite, which both need a session file a backend will open.
 *
 * Every id, number and name is synthetic; nothing here reads the real WhatsApp session.
 */

export const ME = { id: '4915100000009:3@s.whatsapp.net', lid: '100000000000009:3@lid', name: 'Test Person' };
export const ACCOUNT = 'whatsapp-100000000000009';
/** The account's own chat — where a note to self goes, as `chatId` files it. */
export const OWN_LID = '100000000000009@lid';

export function tempDir(prefix = 'curlew-whatsapp-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function context(dir: string, settings: BackendContext['settings'] = {}): BackendContext {
  return { settings, env: {}, secretsDir: join(dir, 'secrets', 'whatsapp') };
}

export function prompter(answers: string[]): AccountPrompter & { asked: string[]; notes: string[] } {
  const queue = [...answers];
  const asked: string[] = [];
  const notes: string[] = [];
  return {
    asked,
    notes,
    async ask(label) {
      asked.push(label);
      const next = queue.shift();
      if (next === undefined) throw new Error('no answer left');
      return next;
    },
    notify: (message) => notes.push(message),
  };
}

/** Script a link: the first socket shows a QR code, the phone pairs, WhatsApp asks for a restart; the second opens. */
export function linkScript(socket: FakeSocket, index: number): void {
  if (index === 0) {
    socket.emit('connection.update', { qr: '2@synthetic-qr-payload,AAAA,BBBB,CCCC' });
    socket.options.auth.state.creds.me = { ...ME };
    socket.options.auth.saveCreds();
    socket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: {
        error: Object.assign(new Error('restart required'), { output: { statusCode: 515 } }),
      },
    });
  } else {
    socket.emit('connection.update', { connection: 'open' });
  }
}

export async function link(dir: string, answers = ['']) {
  const factory = fakeFactory(linkScript);
  const ask = prompter(answers);
  const account = await new WhatsAppBackend(context(dir), { createSocket: factory.create }).addAccount(ask);
  return { account, ask, factory };
}
