/** Where a message's reaction chips go: inside its bubble, or in a row under a bubble that is only media. */

export type ReactionPlacement = 'inside' | 'below';

/**
 * A bubble that holds only media (picture, gallery, clip, voice note, file with no caption) shows its
 * chips under it, so the media stays clean; a bubble with text keeps them inside, above the time.
 */
export function reactionPlacement(message: {
  bodyText?: string | null;
  notice?: boolean | string | null;
  hasAttachments: boolean;
}): ReactionPlacement {
  return message.hasAttachments && !message.bodyText?.trim() && !message.notice ? 'below' : 'inside';
}
