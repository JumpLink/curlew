import { describe, expect, it } from '@gjsify/unit';

import { activeCatalogue, setCatalogue } from '@curlew/protocol';
import {
  reportUndecryptable,
  redactSdkText,
  sdkLogLine,
  takeUndecryptable,
  undecryptableSummary,
} from '@curlew/matrix';

/** Shaped like the SDK's decryption warning; every value is invented. */
const SAMPLE =
  'Error decrypting event (id=$evt1234567890abcdefXYZ_-+/ type=m.room.encrypted sender=@alice:example.org ' +
  'room=!abc:example.org ts=1700000000000 sender_key=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MDEyMzQ1 ' +
  'session=c2Vzc2lvbmlkZmFrZWZha2VmYWtlMTIzNDU2): DecryptionError: no key';

const IDENTIFIERS = [
  '@alice:example.org',
  '!abc:example.org',
  '$evt1234567890abcdefXYZ_-+/',
  'evt1234567890abcdefXYZ',
  'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MDEyMzQ1',
  'c2Vzc2lvbmlkZmFrZWZha2VmYWtlMTIzNDU2',
];

/** The summary is translated; pin the source language so the host's locale cannot change it. */
function english(run: () => void): void {
  const previous = activeCatalogue();
  setCatalogue(undefined);
  try {
    run();
  } finally {
    setCatalogue(previous);
  }
}

export default async () => {
  await describe('Matrix SDK log redaction', async () => {
    await it('leaves no identifier of the SDK warning behind and keeps the text readable', async () => {
      const out = redactSdkText(SAMPLE);
      for (const id of IDENTIFIERS) expect(out.includes(id)).toBe(false);
      expect(out.includes('sender=@…')).toBe(true);
      expect(out.includes('room=!…')).toBe(true);
      expect(out.includes('DecryptionError: no key')).toBe(true);
    });

    await it('redacts a v12 room id without a server and an old-style event id with one', async () => {
      const out = redactSdkText('room !Zm9vYmFyYmF6cXV4 and $oldstyle:example.org gone');
      expect(out).toBe('room !… and $… gone');
    });

    await it('passes a plain message through unchanged', async () => {
      expect(redactSdkText('Failed to sync: connection reset')).toBe('Failed to sync: connection reset');
    });

    await it('prints a forwarded warning redacted, with the level', async () => {
      const line = sdkLogLine('warning', [
        'Cannot send to',
        '@bob:example.org',
        new Error('room !r1:example.org'),
        { body: 'secret' },
      ]);
      expect(line).toBe('matrix warning: Cannot send to @… room !… […]');
    });

    await it('counts the decryption warning instead of printing it, and reports one line', async () => {
      takeUndecryptable();
      for (let i = 0; i < 3; i++) expect(sdkLogLine('warning', [SAMPLE])).toBe(null);
      const printed: string[] = [];
      english(() => {
        reportUndecryptable((line) => printed.push(line));
        reportUndecryptable((line) => printed.push(line));
      });
      expect(printed.join('|')).toBe('matrix: 3 events not decryptable');
    });

    await it("counts the crypto machine's own decryption warning too", async () => {
      takeUndecryptable();
      const machine =
        'WARN matrix_sdk_crypto::machine: Failed to decrypt a room event: ' +
        "Can't find the room key to decrypt the event, withheld code: None";
      expect(sdkLogLine('warning', [machine])).toBe(null);
      expect(takeUndecryptable()).toBe(1);
    });

    await it('words the summary for one event and for none', async () => {
      english(() => expect(undecryptableSummary(1)).toBe('matrix: 1 event not decryptable'));
      expect(undecryptableSummary(0)).toBe(null);
    });
  });
};
