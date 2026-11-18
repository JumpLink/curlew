/**
 * React to one message of a chat: the person's emoji on it, or none.
 *
 * The same road as `sendMessage` — ask the daemon that holds the account first, else open a
 * sender of our own — but with nothing to plan, log as a message or index: a reaction is not a
 * message. The write log still records it, because it reached the network. Only the window
 * calls this today; an agent has no reaction tool, so no grant is involved (ADR 0008).
 */

import type { MessageBackend, MessageSender, ReplyTarget } from '@curlew/protocol';
import { _, fmt } from '@curlew/protocol';
import type { DaemonSendClient } from '../lib/daemon-send-client.ts';
import type { WriteFrontend } from '../write-log.ts';
import { writeThroughSender } from './sender-write.ts';

export interface ReactParams {
  accountId: string;
  /** The chat's address, as for a send. */
  to: string;
  target: ReplyTarget;
  /** The emoji to react with; null takes the person's reaction back. */
  emoji: string | null;
  /** With `emoji: null`: the emoji being taken back (see `SendingReaction.previous`). */
  previous?: string;
  frontend: WriteFrontend;
  dbPath?: string;
  configPath?: string;
  writeLogPath?: string;
  /** Injected by tests: the backend that opens the sender. */
  backend?: MessageBackend;
  /** Injected by tests: how a request reaches a running daemon. */
  daemon?: DaemonSendClient;
}

/** Put one reaction on the wire through an open handle. Shared by the direct path and the daemon. */
export async function reactThrough(
  sender: MessageSender,
  request: { to: string; target: ReplyTarget; emoji: string | null; previous?: string },
  backendName: string,
): Promise<void> {
  if (!sender.features.reactions || sender.react === undefined) {
    throw new Error(fmt(_('{backend} cannot send a reaction'), { backend: backendName }));
  }
  await sender.react(request);
}

export async function reactToMessage(params: ReactParams): Promise<void> {
  const request = {
    to: params.to,
    target: params.target,
    emoji: params.emoji,
    ...(params.previous === undefined ? {} : { previous: params.previous }),
  };
  await writeThroughSender(params, {
    wire: {
      reaction: {
        target: params.target,
        emoji: params.emoji,
        ...(request.previous === undefined ? {} : { previous: request.previous }),
      },
    },
    logId: `reaction:${params.target.remoteId}`,
    check: (backend) => {
      if (!backend.manifest.capabilities.reactions) {
        throw new Error(fmt(_('{backend} cannot send a reaction'), { backend: backend.manifest.name }));
      }
    },
    apply: (sender, backendName) => reactThrough(sender, request, backendName),
  });
}
