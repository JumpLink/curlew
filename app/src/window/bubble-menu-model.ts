/** The entries of a message's long-press menu, in the order they are shown. */

export type BubbleMenuId = 'reply' | 'edit' | 'delete' | 'copy';

export interface BubbleMenuEntry {
  id: BubbleMenuId;
  icon: string;
  destructive: boolean;
}

const ENTRIES: readonly BubbleMenuEntry[] = [
  { id: 'reply', icon: 'mail-reply-sender-symbolic', destructive: false },
  { id: 'edit', icon: 'document-edit-symbolic', destructive: false },
  { id: 'copy', icon: 'edit-copy-symbolic', destructive: false },
  { id: 'delete', icon: 'user-trash-symbolic', destructive: true },
];

/** The entries that apply to this message, Delete last so it is not hit by accident. */
export function bubbleMenuEntries(available: Readonly<Record<BubbleMenuId, boolean>>): BubbleMenuEntry[] {
  return ENTRIES.filter((entry) => available[entry.id]);
}

/** Touch drags scroll; only a pointer may select text in a bubble (the menu still copies). */
export function selectableFor(touch: boolean): boolean {
  return !touch;
}
