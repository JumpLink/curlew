/** The words of the confirmation before an account is paused. */

import { _, _n, fmt } from '@curlew/protocol';

/** What pausing does, with the number of chats that disappear from the list. */
export function pauseBody(conversations: number): string {
  const hidden =
    conversations > 0
      ? fmt(_n('{n} conversation will be hidden.', '{n} conversations will be hidden.', conversations), {
          n: conversations,
        })
      : _('Its conversations will be hidden.');
  return `${hidden} ${_('Nothing is deleted, and switching the account on again brings everything back.')}`;
}
