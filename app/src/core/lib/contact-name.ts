/**
 * The name of the contact an agent request names, for the access prompt (ADR 0009 step 3).
 *
 * Resolved by the DAEMON from its own index, never taken from the request: the requester is the
 * agent, and a name it supplied could talk the person into allowing the wrong contact. A name is
 * convenience for the person; every failure here is "no name", and the prompt shows the address.
 */

import type { IndexDatabase } from '@curlew/store';

const MAX_NAME_CHARS = 60;
// Control characters, line/paragraph separators and bidi/zero-width marks.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Make a name safe to put into a notification: it comes from another person (a Signal profile, a
 * mail header), so it must not carry a line break or control character that fakes another line,
 * and is cut to a length that cannot push the real address out of view.
 */
export function sanitizeName(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const flat = raw
    .replace(UNSAFE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length === 0) return undefined;
  const chars = [...flat];
  return chars.length <= MAX_NAME_CHARS ? flat : `${chars.slice(0, MAX_NAME_CHARS - 1).join('')}…`;
}

function hasAddress(json: unknown, contact: string): boolean {
  try {
    const parsed = JSON.parse(String(json ?? '[]')) as unknown;
    return (
      Array.isArray(parsed) &&
      parsed.some((a) => typeof a?.value === 'string' && a.value.toLowerCase() === contact.toLowerCase())
    );
  } catch {
    return false;
  }
}

/**
 * The display name the index holds for `contact` of `account`: the chat peer (Signal ACI,
 * WhatsApp JID, Matrix MXID, …) by id or by address, else the address-book/mail participant that
 * owns the address. `undefined` when there is none or the lookup fails.
 */
export function contactNameFromIndex(
  db: IndexDatabase,
  account: string,
  contact: string | undefined,
): string | undefined {
  if (contact === undefined || contact === '') return undefined;
  try {
    const byId = db
      .prepare('SELECT display_name FROM chat_peers WHERE account_id = ? AND peer_id = ? LIMIT 1')
      .all(account, contact) as Array<Record<string, unknown>>;
    const direct = sanitizeName(byId[0]?.display_name as string | null | undefined);
    if (direct !== undefined) return direct;

    const peers = db
      .prepare('SELECT display_name, addresses_json FROM chat_peers WHERE account_id = ?')
      .all(account) as Array<Record<string, unknown>>;
    for (const peer of peers) {
      if (!hasAddress(peer.addresses_json, contact)) continue;
      const name = sanitizeName(peer.display_name as string | null | undefined);
      if (name !== undefined) return name;
    }

    const owners = db
      .prepare(
        `SELECT p.display_name FROM participant_addresses a JOIN participants p ON p.id = a.participant_id
          WHERE lower(a.value) = lower(?) LIMIT 1`,
      )
      .all(contact) as Array<Record<string, unknown>>;
    return sanitizeName(owners[0]?.display_name as string | null | undefined);
  } catch {
    return undefined;
  }
}
