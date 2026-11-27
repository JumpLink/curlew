import { describe, expect, it } from '@gjsify/unit';

import { liveChanges, type ShownMessage } from '../../../src/window/conversation-model.ts';
import {
  pendingClientId,
  pendingRow,
  pendingRowId,
  sendStateLabel,
  settledByPage,
  withPendingSends,
  type PendingSend,
  type SettlingRow,
} from '../../../src/window/pending-send-model.ts';

const CONVERSATION = 'xmpp:acc/peer@example.org';

/** A send on its way out, with as little said about it as the model needs. */
const sending = (over: Partial<PendingSend<string>> = {}): PendingSend<string> => ({
  clientId: 'c-1',
  choice: 'xmpp',
  backend: 'xmpp',
  accountId: 'acc',
  conversations: [CONVERSATION],
  text: 'hello',
  files: [],
  startedAt: '2026-11-27T10:00:00.000Z',
  state: 'pending',
  ...over,
});

/** A row as a page read reports it: the person's own message, a minute after the send started. */
const row = (over: Partial<SettlingRow> = {}): SettlingRow => ({
  id: 'm-1',
  conversationId: CONVERSATION,
  fromSelf: true,
  sentAt: '2026-11-27T10:01:00.000Z',
  bodyText: 'hello',
  ...over,
});

export default async () => {
  describe('the pending bubble id', () => {
    it('is reversible and tells a real message id apart', () => {
      expect(pendingRowId('c-1')).toBe('pending:c-1');
      expect(pendingClientId(pendingRowId('c-1'))).toBe('c-1');
      expect(pendingClientId('m-1')).toBe(null);
    });
  });

  describe('sendStateLabel', () => {
    it('says what the bubble is doing, and says it differently once it failed', () => {
      expect(sendStateLabel('pending') !== sendStateLabel('failed')).toBe(true);
      expect(sendStateLabel('pending').length > 0).toBe(true);
      expect(sendStateLabel('failed').length > 0).toBe(true);
    });
  });

  describe('pendingRow', () => {
    it('is the own bubble in the first conversation it was sent to', () => {
      const shown = pendingRow(sending({ conversations: [CONVERSATION, 'other'] }));
      expect(shown.id).toBe('pending:c-1');
      expect(shown.conversationId).toBe(CONVERSATION);
      expect(shown.fromSelf).toBe(true);
      expect(shown.bodyText).toBe('hello');
      expect(shown.hasAttachments).toBe(false);
      // Nothing on any network yet: no remote id, so no reply, reaction or edit is offered.
      expect(shown.ref.remoteId === undefined).toBe(true);
    });

    it('carries each picked file as a part read from this machine', () => {
      const shown = pendingRow(
        sending({
          files: [
            { path: '/tmp/a.png', name: 'a.png', size: 12, temporary: false },
            { path: '/tmp/v.ogg', name: 'v.ogg', size: 34, temporary: true, voiceMs: 2000 },
          ],
        }),
      );
      expect(shown.hasAttachments).toBe(true);
      expect(shown.attachments?.length).toBe(2);
      expect(shown.attachments?.[0].localPath).toBe('/tmp/a.png');
      expect(shown.attachments?.[0].index).toBe(0);
      expect(shown.attachments?.[1].kind).toBe('voice');
      expect(shown.attachments?.[1].durationMs).toBe(2000);
    });
  });

  describe('settledByPage', () => {
    it('settles by the client id before the send has returned', () => {
      // The daemon wrote the delivered row while `sendMessage` was still waiting: the echo is
      // already in the page, named with the id the send went out under.
      const settled = settledByPage([sending()], [row({ id: 'm-7', clientId: 'c-1', bodyText: 'other' })]);
      expect(settled.get('c-1')).toBe('m-7');
    });

    it('settles by content when the network kept a name of its own', () => {
      const settled = settledByPage([sending()], [row({ clientId: 'network-id' })]);
      expect(settled.get('c-1')).toBe('m-1');
    });

    it('matches a send with files only against a row carrying as many', () => {
      const send = sending({ files: [{ path: '/tmp/a.png', name: 'a.png', size: 1, temporary: false }] });
      expect(settledByPage([send], [row()]).size).toBe(0);
      expect(settledByPage([send], [row({ attachments: [{}] })]).get('c-1')).toBe('m-1');
    });

    it('takes a server stamp truncated to the whole second', () => {
      // Telegram and WhatsApp report whole seconds, so the delivered row of a send started at
      // 10:00:00.750 is stamped 10:00:00 — earlier than the send, and still that send.
      const send = sending({ startedAt: '2026-11-27T10:00:00.750Z' });
      expect(settledByPage([send], [row({ sentAt: '2026-11-27T10:00:00Z' })]).get('c-1')).toBe('m-1');
    });

    it('takes a small disagreement between this clock and the server one', () => {
      const send = sending({ startedAt: '2026-11-27T10:00:00.000Z' });
      // Inside the window on either side.
      expect(settledByPage([send], [row({ sentAt: '2026-11-27T09:59:57.000Z' })]).get('c-1')).toBe('m-1');
      expect(settledByPage([send], [row({ sentAt: '2026-11-27T09:59:55.000Z' })]).get('c-1')).toBe('m-1');
    });

    it('never reaches behind the skew window into real history', () => {
      // A minute earlier is history, not a skewed stamp of this send.
      expect(settledByPage([sending()], [row({ sentAt: '2026-11-27T09:59:00.000Z' })]).size).toBe(0);
      // Just outside the window, so the bound is the window and not "anything earlier goes".
      expect(settledByPage([sending()], [row({ sentAt: '2026-11-27T09:59:54.000Z' })]).size).toBe(0);
      expect(settledByPage([sending()], [row({ sentAt: null })]).size).toBe(0);
      expect(settledByPage([sending()], [row({ sentAt: 'not a date' })]).size).toBe(0);
    });

    it('leaves a message from someone else, or from another chat, alone', () => {
      expect(settledByPage([sending()], [row({ fromSelf: false })]).size).toBe(0);
      expect(settledByPage([sending()], [row({ conversationId: 'elsewhere' })]).size).toBe(0);
    });

    it('gives each row to one send only, so two alike do not collapse into one', () => {
      const two = [sending(), sending({ clientId: 'c-2', startedAt: '2026-11-27T10:00:01.000Z' })];
      const settled = settledByPage(two, [row({ id: 'm-1' }), row({ id: 'm-2' })]);
      expect(settled.size).toBe(2);
      expect(new Set(settled.values()).size).toBe(2);
    });

    it('prefers the exact name over a lookalike row', () => {
      const settled = settledByPage(
        [sending()],
        [row({ id: 'm-content' }), row({ id: 'm-named', clientId: 'c-1' })],
      );
      expect(settled.get('c-1')).toBe('m-named');
    });

    it('leaves a failed send to Retry or Discard', () => {
      expect(settledByPage([sending({ state: 'failed' })], [row()]).size).toBe(0);
    });

    it('ignores the pending bubbles the page already shows', () => {
      const page = [{ ...row({ id: pendingRowId('c-1') }), bodyText: 'hello' }];
      expect(settledByPage([sending()], page).size).toBe(0);
    });
  });

  describe('the send that resolves after its bubble was already settled (§3.1)', () => {
    it('finds nothing left to settle once its entry is gone', () => {
      // What the view's `.then` does: it reads the entry back and returns when the page already
      // took it over. With the entry gone there is no second match, so nothing is appended twice.
      const page = [row({ id: 'm-7', clientId: 'c-1' })];
      expect(settledByPage([sending()], page).get('c-1')).toBe('m-7');
      expect(settledByPage([], page).size).toBe(0);
    });

    it('leaves one row when the appended message meets its indexed row', () => {
      // The other direction: the entry was still there, so the view dropped the bubble and
      // appended the message under `SendResult.originId`. The index wrote the same message under
      // an id of its own, and the next page read carries that. The existing diff reconciles the
      // two — the appended row is reported gone as the indexed one arrives, so whichever way the
      // view then applies it (swap or rebuild) the chat never holds both.
      const at = '2026-11-27T10:00:01.000Z';
      const shown = [
        { id: 'origin-7', conversationId: CONVERSATION, sentAt: at, bodyText: 'hello', fromSelf: true },
      ] as unknown as ShownMessage[];
      const fresh = [
        { id: 'm-echo-7', conversationId: CONVERSATION, sentAt: at, bodyText: 'hello', fromSelf: true },
      ] as unknown as ShownMessage[];
      const diff = liveChanges(shown, fresh);
      expect(diff.removed).toStrictEqual(['origin-7']);
      expect(diff.added.map((m) => m.id)).toStrictEqual(['m-echo-7']);
    });
  });

  describe('withPendingSends', () => {
    it('adds nothing when nothing is in flight', () => {
      const page = [pendingRow(sending())];
      expect(withPendingSends(page, []).length).toBe(1);
    });

    it('puts the bubbles after the page, oldest first', () => {
      const later = sending({ clientId: 'c-2', startedAt: '2026-11-27T10:05:00.000Z' });
      const rows = withPendingSends([], [later, sending()]);
      expect(rows.map((m) => m.id).join()).toBe('pending:c-1,pending:c-2');
    });
  });
};
