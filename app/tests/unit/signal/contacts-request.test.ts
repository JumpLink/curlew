import { describe, expect, it } from '@gjsify/unit';

import {
  CONTACTS_REQUEST_RETRY_MS,
  decodeFields,
  encodeContactsRequest,
  shouldRequestContacts,
} from '@curlew/signal';

/** The request that makes the phone upload its contact list, and when to send it. */
export default async () => {
  await describe('Signal contact request', async () => {
    await it('encodes Content.syncMessage.request.type = CONTACTS', async () => {
      const bytes = encodeContactsRequest();
      const sync = decodeFields(bytes).get(2)?.[0];
      expect(sync instanceof Uint8Array).toBe(true);
      const request = decodeFields(sync as Uint8Array).get(4)?.[0];
      expect(request instanceof Uint8Array).toBe(true);
      expect(decodeFields(request as Uint8Array).get(1)?.[0]).toBe(1n);
      expect(decodeFields(bytes).has(1)).toBe(false);
    });

    await it('asks when nothing arrived and nothing was asked', async () => {
      expect(shouldRequestContacts({ syncedAt: null, requestedAt: null }, 1_000)).toBe(true);
    });

    await it('does not ask again once a list arrived', async () => {
      expect(shouldRequestContacts({ syncedAt: 5, requestedAt: null }, 1e12)).toBe(false);
    });

    await it('waits a day after a request, then asks again', async () => {
      const at = 1_000_000;
      expect(shouldRequestContacts({ syncedAt: null, requestedAt: at }, at + 1000)).toBe(false);
      expect(shouldRequestContacts({ syncedAt: null, requestedAt: at }, at + CONTACTS_REQUEST_RETRY_MS)).toBe(
        true,
      );
    });
  });
};
