import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AccessPort } from '../../../src/core/access.ts';
import { conversationsShow } from '../../../src/core/actions/conversations.ts';
import { openIndex } from '../../../src/core/actions/index-sync.ts';
import { requireParticipantsRead } from '../../../src/core/actions/message-access.ts';
import { defaultConfig } from '../../../src/core/config.ts';

/** What an agent sees of a chat message's attachments: a descriptor, never the handle. */

const BACKEND = 'telegram';
const ACCOUNT = 'telegram-abc';
const CONVERSATION = `${BACKEND}:${ACCOUNT}:peer-1`;

function seed(dbPath: string): void {
  const db = openIndex(dbPath);
  try {
    db.prepare(
      `INSERT INTO conversations (id, backend, account_id, kind, classification, classification_reason)
       VALUES (?, ?, ?, 'direct', 'chat', 'synthetic')`,
    ).run(CONVERSATION, BACKEND, ACCOUNT);
    const message = db.prepare(
      `INSERT INTO conversation_messages
         (id, conversation_id, backend, account_id, presentation, remote_id, has_attachments,
          classification, classification_reason, from_self, sent_at)
       VALUES (?, ?, ?, ?, 'bubble', ?, ?, 'chat', 'synthetic', 0, ?)`,
    );
    message.run('m-voice', CONVERSATION, BACKEND, ACCOUNT, 'peer-1/1', 1, '2026-01-01T10:00:00.000Z');
    message.run('m-plain', CONVERSATION, BACKEND, ACCOUNT, 'peer-1/2', 0, '2026-01-01T10:01:00.000Z');
    db.prepare(
      `INSERT INTO message_attachments (message_id, idx, filename, mime_type, size, kind, duration_ms, handle)
         VALUES ('m-voice', 0, 'secret-name.ogg', 'audio/ogg', 4096, 'voice', 3000, '{"fileId":"f1"}')`,
    ).run();
    db.prepare(
      `INSERT INTO message_attachments (message_id, idx, filename, mime_type, size, kind, handle)
         VALUES ('m-voice', 1, 'gone.pdf', 'application/pdf', 10, 'file', NULL)`,
    ).run();
  } finally {
    db.close();
  }
}

export default async () => {
  await describe('conversationsShow attachments', async () => {
    const withWorld = async (body: (dbPath: string, configPath: string) => Promise<void>): Promise<void> => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-conv-attachments-'));
      const configPath = join(dir, 'config.json');
      writeFileSync(configPath, JSON.stringify({}));
      const dbPath = join(dir, 'index.db');
      try {
        seed(dbPath);
        await body(dbPath, configPath);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    await it('lists a voice note with its kind, duration and fetchability, without name or handle', async () => {
      await withWorld(async (dbPath, configPath) => {
        const shown = await conversationsShow({ id: CONVERSATION, dbPath, configPath });
        const voice = shown.messages.find((m) => m.ref.remoteId === 'peer-1/1');
        expect(voice?.attachments?.length).toBe(2);
        const [first, second] = voice?.attachments ?? [];
        expect(first.kind).toBe('voice');
        expect(first.mimeType).toBe('audio/ogg');
        expect(first.size).toBe(4096);
        expect(first.durationMs).toBe(3000);
        expect(first.fetchable).toBe(true);
        expect(second.fetchable).toBe(false);
        expect(JSON.stringify(shown)).not.toContain('secret-name');
        expect(JSON.stringify(shown)).not.toContain('fileId');
      });
    });

    await it('names the file only when bodies are asked for', async () => {
      await withWorld(async (dbPath, configPath) => {
        const shown = await conversationsShow({ id: CONVERSATION, dbPath, configPath, includeBodies: true });
        const voice = shown.messages.find((m) => m.ref.remoteId === 'peer-1/1');
        expect(voice?.attachments?.[0].filename).toBe('secret-name.ogg');
        expect(JSON.stringify(shown)).not.toContain('fileId');
      });
    });

    await it('leaves a message without attachments alone', async () => {
      await withWorld(async (dbPath, configPath) => {
        const shown = await conversationsShow({ id: CONVERSATION, dbPath, configPath });
        const plain = shown.messages.find((m) => m.ref.remoteId === 'peer-1/2');
        expect(plain?.attachments).toBe(undefined);
      });
    });
  });

  await describe('requireParticipantsRead', async () => {
    const OWN_TELEGRAM = '99385315';
    const OTHER_SIGNAL = 'a0a0a0a0-0000-4000-8000-000000000001';
    const rig = () => {
      const asked: unknown[] = [];
      const port: AccessPort = {
        request: async (ask) => {
          asked.push(ask);
          return null;
        },
      };
      const agent = {
        frontend: 'mcp' as const,
        session: 's',
        port,
        // The Telegram backend knows only its own network's address of the account owner.
        isSelf: async (_account: string, address: string) => address === OWN_TELEGRAM,
      };
      return { asked, agent };
    };

    await it('treats a person as the account itself when any of their addresses is', async () => {
      const { asked, agent } = rig();
      await requireParticipantsRead(defaultConfig(), agent, ACCOUNT, [[OWN_TELEGRAM, OTHER_SIGNAL]]);
      expect(asked.length).toBe(0);
    });

    await it('still asks for another person, whatever the account owner is', async () => {
      const { asked, agent } = rig();
      let refused = false;
      try {
        await requireParticipantsRead(defaultConfig(), agent, ACCOUNT, [[OWN_TELEGRAM], [OTHER_SIGNAL]]);
      } catch {
        refused = true;
      }
      expect(asked.length).toBe(1);
      expect(refused).toBe(true);
    });
  });
};
