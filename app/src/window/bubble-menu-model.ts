/** The entries of a message's long-press menu, in the order they are shown. */

export type BubbleMenuId = 'reply' | 'edit' | 'retry' | 'delete' | 'discard' | 'copy';

export interface BubbleMenuEntry {
  id: BubbleMenuId;
  icon: string;
  destructive: boolean;
}

const ENTRIES: readonly BubbleMenuEntry[] = [
  { id: 'reply', icon: 'mail-reply-sender-symbolic', destructive: false },
  { id: 'edit', icon: 'document-edit-symbolic', destructive: false },
  // A send that failed (ADR 0021 §5): sent again as the same message, or taken off this screen.
  { id: 'retry', icon: 'view-refresh-symbolic', destructive: false },
  { id: 'copy', icon: 'edit-copy-symbolic', destructive: false },
  { id: 'discard', icon: 'edit-clear-symbolic', destructive: true },
  { id: 'delete', icon: 'user-trash-symbolic', destructive: true },
];

/**
 * The entries that apply to this message, the destructive ones last so they are not hit by
 * accident. An id left out does not apply — a bubble offers either the entries of a message that
 * is on the network, or the two of a send that never got there.
 */
export function bubbleMenuEntries(
  available: Readonly<Partial<Record<BubbleMenuId, boolean>>>,
): BubbleMenuEntry[] {
  return ENTRIES.filter((entry) => available[entry.id] === true);
}

/** Touch drags scroll; only a pointer may select text in a bubble (the menu still copies). */
export function selectableFor(touch: boolean): boolean {
  return !touch;
}
