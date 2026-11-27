import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DeliverySession, MessageBackend, MessageSender, SendingChatFlags } from '@curlew/protocol';

import { createDaemonSetChatFlagsHandler } from '../../../src/core/actions/daemon.ts';
import { pushChatFlags } from '../../../src/core/actions/chat-flags.ts';
import {
  DAEMON_WIRE_VERSION,
  parseDaemonSetChatFlagsReply,
  parseDaemonSetChatFlagsRequest,
} from '../../../src/core/lib/daemon-bus.ts';

// Synthetic only: a fake sender per case, a temporary config, nothing on any network.

const ACCOUNT = 'telegram-42';
const CHAT = '1001';

function fakeBackend(
  requests: SendingChatFlags[],
  opened: { n: number },
  over: { shares?: boolean; mutes?: boolean; pins?: boolean } = {},
): MessageBackend {
  const sender = {
    features: { chatFlags: true },
    setChatFlags: async (r: SendingChatFlags) => void requests.push(r),
    close: async () => {},
  } as unknown as MessageSender;
  return {
    manifest: {
      name: 'telegram',
      sendSharesReceiveState: over.shares === true,
      capabilities: { mutes: over.mutes ?? true, pins: over.pins ?? true },
    },
    listAccounts: async () => [{ id: ACCOUNT, identity: ACCOUNT, provider: 'telegram' }],
    openSender: async () => {
      opened.n += 1;
      return sender;
    },
  } as unknown as MessageBackend;
}

async function failure(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export default async () => {
  await describe('chat flags on the daemon route', async () => {
    await it('parses the wire request strictly and speaks version 10', async () => {
      expect(DAEMON_WIRE_VERSION).toBe(10);
      const wire = {
        v: DAEMON_WIRE_VERSION,
        backend: 'telegram',
        account: ACCOUNT,
        to: CHAT,
        mute: { muted: true, until: null },
      };
      expect(parseDaemonSetChatFlagsRequest(JSON.stringify(wire)).mute?.muted).toBe(true);
      for (const bad of [
        '{"v":8}',
        'nope',
        JSON.stringify({ ...wire, v: 8 }),
        JSON.stringify({ ...wire, to: '' }),
        JSON.stringify({ ...wire, mute: { muted: 'yes', until: null } }),
        JSON.stringify({ ...wire, mute: undefined }),
        JSON.stringify({ ...wire, favourite: 1 }),
      ]) {
        expect(
          (await failure(Promise.resolve().then(() => parseDaemonSetChatFlagsRequest(bad)))) !== null,
        ).toBe(true);
      }
      expect(parseDaemonSetChatFlagsReply(JSON.stringify({ v: DAEMON_WIRE_VERSION, kind: 'set' })).kind).toBe(
        'set',
      );
      expect(
        (await failure(
          Promise.resolve().then(() => parseDaemonSetChatFlagsReply('{"v":8,"kind":"set"}')),
        )) !== null,
      ).toBe(true);
    });

    await it('answers on the open connection, hands back without one, refuses a paused account', async () => {
      const requests: SendingChatFlags[] = [];
      const sessions = new Map<string, DeliverySession>();
      let paused = false;
      const handler = createDaemonSetChatFlagsHandler({
        log: () => {},
        sessions,
        isPaused: () => paused,
      } as never);
      const wire = {
        v: DAEMON_WIRE_VERSION,
        backend: 'telegram',
        account: ACCOUNT,
        to: CHAT,
        mute: { muted: true, until: '2026-12-01T00:00:00.000Z' },
        favourite: true,
      };
      expect((await handler(wire as never)).kind).toBe('not-followed');
      sessions.set(`telegram/${ACCOUNT}`, {
        openSender: async () =>
          ({
            features: { chatFlags: true },
            setChatFlags: async (r: SendingChatFlags) => void requests.push(r),
            close: async () => {},
          }) as unknown as MessageSender,
      } as unknown as DeliverySession);
      expect((await handler(wire as never)).kind).toBe('set');
      expect(requests.length).toBe(1);
      expect(requests[0].mute?.until).toBe('2026-12-01T00:00:00.000Z');
      expect(requests[0].favourite).toBe(true);
      paused = true;
      expect((await handler(wire as never)).kind).toBe('refused');
    });

    await it('pushes through the daemon first, then its own sender, and keeps a network without flags local', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-flags-'));
      try {
        const configPath = join(dir, 'config.json');
        writeFileSync(configPath, '{}');
        const requests: SendingChatFlags[] = [];
        const opened = { n: 0 };
        const base = {
          accountId: ACCOUNT,
          to: CHAT,
          mute: { muted: true, until: null },
          frontend: 'window' as const,
          dbPath: join(dir, 'index.db'),
          configPath,
          writeLogPath: join(dir, 'writes.log'),
        };
        const asked: unknown[] = [];
        const daemon = (reply: unknown) =>
          ({
            setChatFlags: async (r: unknown) => {
              asked.push(r);
              return reply;
            },
          }) as never;
        const shared = { ...base, backend: fakeBackend(requests, opened, { shares: true }) };
        expect(
          await pushChatFlags({ ...shared, daemon: daemon({ v: DAEMON_WIRE_VERSION, kind: 'set' }) }),
        ).toBe('pushed');
        expect(opened.n).toBe(0);
        expect(asked.length).toBe(1);
        expect(await pushChatFlags({ ...shared, daemon: daemon(null) })).toBe('pushed');
        expect(opened.n).toBe(1);
        expect(requests.length).toBe(1);
        const message = await failure(
          pushChatFlags({
            ...shared,
            daemon: daemon({ v: DAEMON_WIRE_VERSION, kind: 'failed', message: 'boom' }),
          }),
        );
        expect(message).toBe('boom');
        // A backend that keeps neither flag is never opened.
        const quiet = fakeBackend(requests, opened, { mutes: false, pins: false });
        expect(await pushChatFlags({ ...base, backend: quiet })).toBe('local');
        expect(opened.n).toBe(1);
        expect(await pushChatFlags({ ...base, mute: undefined, backend: quiet })).toBe('nothing');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
