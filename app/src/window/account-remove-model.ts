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
  if (backend === 'mail') {
    return {
      heading: fmt(_('Remove {account}?'), { account: accountLabel }),
      body: _(
        'Curlew will forget the password for this account and stop reading its mail. Messages already on this computer stay, and nothing changes at your provider.',
      ),
      cancel: _('Cancel'),
      confirm: _('Remove Account'),
    };
  }
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

/** Networks that push each message once: the index here is the only copy there will ever be. */
const DELIVERY_ONLY = new Set(['signal', 'whatsapp']);

export interface DeleteDataCopy {
  /** The check button in the first confirmation. */
  option: string;
  heading: string;
  body: string;
  cancel: string;
  confirm: string;
}

/** The words of the extra "also delete the messages" step, with its own confirmation. */
export function deleteDataCopy(backend: string, accountLabel: string): DeleteDataCopy {
  const only = DELIVERY_ONLY.has(backend);
  const protocol = protocolLabel(backend);
  return {
    option: _('Also delete its messages on this computer'),
    heading: fmt(_('Delete all messages of {account}?'), { account: accountLabel }),
    body: only
      ? fmt(
          _(
            'Curlew will delete every message, attachment and picture of this account from this computer. {protocol} does not send them again, so this is the only copy: they cannot be recovered.',
          ),
          { protocol },
        )
      : _(
          'Curlew will delete every message, attachment and picture of this account from this computer. Nothing changes on the server, but Curlew cannot restore them without syncing again.',
        ),
    cancel: _('Cancel'),
    confirm: _('Delete Messages and Remove'),
  };
}
