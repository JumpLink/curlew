/**
 * The words of the "Remove account" confirmation. Pure, so both runtimes test that the promise it
 * makes — messages stay, the service still lists the device — is the one the code keeps.
 */

import { _, fmt } from '@curlew/protocol';

import { protocolLabel } from './conversation-list-model.ts';

export interface RemoveAccountCopy {
  heading: string;
  body: string;
  cancel: string;
  confirm: string;
}

export function removeAccountCopy(backend: string, accountLabel: string): RemoveAccountCopy {
  const protocol = protocolLabel(backend);
  return {
    heading: fmt(_('Remove {account}?'), { account: accountLabel }),
    body: fmt(
      _(
        'Curlew will forget the login for this account and stop syncing it. Messages already on this computer stay. The account stays linked on {protocol} until you remove this device there.',
      ),
      { protocol },
    ),
    cancel: _('Cancel'),
    confirm: _('Remove Account'),
  };
}
