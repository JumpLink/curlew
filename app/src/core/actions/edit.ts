/**
 * Edit one of the person's own messages in a chat.
 *
 * The same road as `sendMessage` — ask the daemon that holds the account first, else open a
 * sender of our own — but with nothing to plan, log as a message or index: an edit is not a new
 * message. The write log still records it, because it reached the network. Only the window calls
 * this today; an agent has no edit tool, so no grant is involved (ADR 0008).
 */

import type { MessageBackend, MessageSender, ReplyTarget } from '@curlew/protocol';
import { _, fmt } from '@curlew/protocol';
import type { DaemonSendClient } from '../lib/daemon-send-client.ts';
import type { WriteFrontend } from '../write-log.ts';
import { writeThroughSender } from './sender-write.ts';

export interface EditParams {
  accountId: string;
  /** The chat's address, as for a send. */
  to: string;
  target: ReplyTarget;
  /** The new text for the message. */
  text: string;
  frontend: WriteFrontend;
  dbPath?: string;
  configPath?: string;
  writeLogPath?: string;
  /** Injected by tests: the backend that opens the sender. */
  backend?: MessageBackend;
  /** Injected by tests: how a request reaches a running daemon. */
  daemon?: DaemonSendClient;
}

/** Apply one edit through an open handle. Shared by the direct path and the daemon. */
export async function editThrough(
  sender: MessageSender,
  request: { to: string; target: ReplyTarget; text: string },
  backendName: string,
): Promise<void> {
  if (!sender.features.edits || sender.edit === undefined) {
    throw new Error(fmt(_('{backend} cannot edit a message'), { backend: backendName }));
  }
  if (request.target.fromSelf !== true) {
    throw new Error(_('only your own messages can be edited'));
  }
  await sender.edit(request);
}

export async function editMessage(params: EditParams): Promise<void> {
  await writeThroughSender(params, {
    wire: { edit: { target: params.target, text: params.text } },
    logId: `edit:${params.target.remoteId}`,
    apply: (sender, backendName) =>
      editThrough(sender, { to: params.to, target: params.target, text: params.text }, backendName),
  });
}
