import { describe, expect, it } from '@gjsify/unit';

import {
  NO_THREAD_CAPABILITIES,
  PINNED_FEATURES,
  THREAD_FEATURES,
  threadCan,
  threadCapabilitiesOf,
  upperBoundOf,
  type BackendCapabilities,
  type ThreadFacts,
} from '@curlew/protocol';

import { BUILTIN_PLUGINS } from '../../../src/core/backends/builtin.ts';

// The per-thread layer of ADR 0015: the manifest is the upper bound, the thread only narrows it.

const manifestOf = (name: string): BackendCapabilities =>
  BUILTIN_PLUGINS.find((p) => p.manifest.name === name)!.manifest.capabilities;

const chatty: BackendCapabilities = {
  ...manifestOf('mail'),
  reactions: true,
  editsOwn: true,
  deletesOwn: true,
  readReceipts: true,
  replies: true,
};

export default async () => {
  await describe('thread capabilities', async () => {
    await it('maps every manifest flag to its thread feature', async () => {
      expect(upperBoundOf(manifestOf('telegram'))).toStrictEqual({
        reactions: true,
        edits: true,
        deletes: true,
        replies: true,
        attachments: true,
        readReceipts: true,
      });
    });

    await it('offers chat features in a mail thread whose peer sent Chat-Version', async () => {
      const facts: ThreadFacts = { backend: 'mail', emailChat: true };
      expect(threadCan(chatty, facts, 'reactions')).toBe(true);
      expect(threadCan(chatty, facts, 'edits')).toBe(true);
      expect(threadCan(chatty, facts, 'deletes')).toBe(true);
      expect(threadCan(chatty, facts, 'readReceipts')).toBe(true);
    });

    await it('offers none of them in an ordinary mail thread', async () => {
      const result = threadCapabilitiesOf(chatty, { backend: 'mail', emailChat: false });
      expect(result.reactions).toBe(false);
      expect(result.edits).toBe(false);
      expect(result.deletes).toBe(false);
      expect(result.readReceipts).toBe(false);
      expect(result.attachments).toBe(true);
    });

    await it('never exceeds the manifest, even for a marked peer', async () => {
      const result = threadCapabilitiesOf(manifestOf('mail'), { backend: 'mail', emailChat: true });
      for (const feature of PINNED_FEATURES) expect(result[feature]).toBe(false);
    });

    await it('gives replies to a Delta Chat mail thread only', async () => {
      const mail = manifestOf('mail');
      expect(threadCan(mail, { backend: 'mail', emailChat: true }, 'replies')).toBe(true);
      expect(threadCan(mail, { backend: 'mail', emailChat: false }, 'replies')).toBe(false);
    });

    await it('leaves every non-mail backend at its manifest', async () => {
      for (const plugin of BUILTIN_PLUGINS) {
        if (plugin.manifest.name === 'mail') continue;
        const upper = upperBoundOf(plugin.manifest.capabilities);
        for (const emailChat of [false, true]) {
          expect(
            threadCapabilitiesOf(plugin.manifest.capabilities, { backend: plugin.manifest.name, emailChat }),
          ).toStrictEqual(upper);
        }
      }
    });

    await it("keeps today's mail answer: attachments only", async () => {
      const result = threadCapabilitiesOf(manifestOf('mail'), { backend: 'mail', emailChat: false });
      expect(result).toStrictEqual({ ...NO_THREAD_CAPABILITIES, attachments: true });
    });

    await it('lets a narrowing only turn features off', async () => {
      const result = threadCapabilitiesOf(manifestOf('signal'), { backend: 'signal' }, () => ({
        ...NO_THREAD_CAPABILITIES,
        attachments: true,
        reactions: true,
      }));
      expect(result.attachments).toBe(false);
      expect(result.reactions).toBe(true);
      expect(result.edits).toBe(false);
    });

    await it('pins reaction, edit, delete and read receipt to their own network', async () => {
      expect([...PINNED_FEATURES].sort()).toStrictEqual(['deletes', 'edits', 'reactions', 'readReceipts']);
      for (const feature of PINNED_FEATURES) expect(THREAD_FEATURES.includes(feature)).toBe(true);
    });
  });
};
