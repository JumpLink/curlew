/**
 * What ONE thread can do (ADR 0015): a conversation with one peer or room on one backend.
 *
 * `BackendCapabilities` is the upper bound (what the network can ever do); this layer narrows it
 * with what is known about the thread, such as the peer having sent `Chat-Version` over mail.
 * Pure: no `gi://`, no `node:*`, so the window, the CLI and MCP ask the same question.
 *
 * Actions on ONE existing message (reaction, edit, delete for everyone, read receipt) are never
 * redirected to another protocol: a thread that cannot do them simply does not offer them. Only
 * NEW content may go through the next protocol, and only when the person chose that.
 */

import type { BackendCapabilities } from './messenger.ts';

/** The features a thread can offer, in the words a window uses for an entry or control. */
export interface ThreadCapabilities {
  reactions: boolean;
  /** Edit one of the person's own messages. */
  edits: boolean;
  /** Delete one of the person's own messages for everyone. */
  deletes: boolean;
  replies: boolean;
  attachments: boolean;
  readReceipts: boolean;
}

export type ThreadFeature = keyof ThreadCapabilities;

export const THREAD_FEATURES: readonly ThreadFeature[] = [
  'reactions',
  'edits',
  'deletes',
  'replies',
  'attachments',
  'readReceipts',
];

/** Features that address one existing message in its own network: never redirected. */
export const PINNED_FEATURES: readonly ThreadFeature[] = ['reactions', 'edits', 'deletes', 'readReceipts'];

/** What is known about a thread; every field beyond `backend` is optional and only narrows. */
export interface ThreadFacts {
  backend: string;
  /** Mail only: the peer sent `Chat-Version: 1.0`, so it speaks Delta Chat (ADR 0014). */
  emailChat?: boolean;
  /** The thread is the person's own note to self. */
  self?: boolean;
}

/** A backend's own narrowing of its upper bound for one thread; absent means "the manifest". */
export type ThreadNarrowing = (facts: ThreadFacts, upper: ThreadCapabilities) => ThreadCapabilities;

/** The upper bound of a backend, in thread vocabulary: every manifest flag that maps to a feature. */
export function upperBoundOf(capabilities: BackendCapabilities): ThreadCapabilities {
  return {
    reactions: capabilities.reactions,
    edits: capabilities.editsOwn,
    deletes: capabilities.deletesOwn,
    replies: capabilities.replies,
    attachments: capabilities.attachments,
    readReceipts: capabilities.readReceipts,
  };
}

/** Everything off. */
export const NO_THREAD_CAPABILITIES: ThreadCapabilities = Object.freeze({
  reactions: false,
  edits: false,
  deletes: false,
  replies: false,
  attachments: false,
  readReceipts: false,
});

/**
 * Mail narrows by the peer: only mail from a Delta Chat peer carries chat features. Anything else
 * is an ordinary mail thread, which gets the reply by `In-Reply-To` and attachments of mail but
 * no emoji row, no edit, no delete for everyone and no read receipt.
 */
export const narrowMailThread: ThreadNarrowing = (facts, upper) =>
  facts.emailChat
    ? upper
    : {
        ...upper,
        reactions: false,
        edits: false,
        deletes: false,
        readReceipts: false,
        // A plain mail reply is `In-Reply-To`, not a chat reply: it stays in the mail composer.
        replies: false,
      };

const NARROWINGS: Readonly<Record<string, ThreadNarrowing>> = { mail: narrowMailThread };

/**
 * What the thread can do: the backend's upper bound, narrowed by what is known about the thread.
 * A narrowing can only turn features off; it never exceeds the manifest.
 */
export function threadCapabilitiesOf(
  capabilities: BackendCapabilities,
  facts: ThreadFacts,
  narrowing: ThreadNarrowing | undefined = NARROWINGS[facts.backend],
): ThreadCapabilities {
  const upper = upperBoundOf(capabilities);
  if (!narrowing) return upper;
  const narrowed = narrowing(facts, upper);
  const result = { ...upper };
  for (const feature of THREAD_FEATURES) result[feature] = upper[feature] && narrowed[feature];
  return result;
}

/** The thread offers `feature`; the one question a window or an agent asks before showing it. */
export function threadCan(
  capabilities: BackendCapabilities,
  facts: ThreadFacts,
  feature: ThreadFeature,
): boolean {
  return threadCapabilitiesOf(capabilities, facts)[feature];
}
