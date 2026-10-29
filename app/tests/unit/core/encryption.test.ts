/**
 * `config.encryption` — the setting that says a peer is never written to in the clear
 * (ADR 0006 §7).
 *
 * Every account id and address here is a placeholder. What these cases are about is that a
 * misspelled target is an ERROR rather than a silently weaker setting: a key that parses but
 * matches nothing would leave the person believing a peer is covered when it is not.
 */

import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultConfig, parseConfig, saveConfig } from '../../../src/core/config.ts';
import { encryptionRequired, requireEncryptionFor } from '../../../src/core/actions/omemo.ts';

const ACCOUNT = 'xmpp-abc123';
const PERSON = 'person@example.org';
const OTHER = 'other@example.org';

function config(encryption: Record<string, string>) {
  return parseConfig(JSON.stringify({ encryption }));
}

export default async function encryption(): Promise<void> {
  await describe('parsing config.encryption', async () => {
    await it('a missing section requires encryption nowhere', async () => {
      const parsed = parseConfig('{}');
      expect(Object.keys(parsed.encryption).length).toBe(0);
      expect(encryptionRequired(parsed, ACCOUNT, PERSON)).toBe(false);
    });

    await it('parses a per-peer and an account-wide target', async () => {
      const parsed = config({ [`${ACCOUNT}/${PERSON}`]: 'required', 'xmpp-other': 'required' });
      expect(parsed.encryption[`${ACCOUNT}/${PERSON}`]).toBe('required');
      expect(parsed.encryption['xmpp-other']).toBe('required');
    });

    await it('fails closed on a value that is not "required", naming the target', async () => {
      expect(() => config({ [ACCOUNT]: 'optional' })).toThrow(/config\.encryption\.xmpp-abc123/);
      expect(() => config({ [ACCOUNT]: 'Required' })).toThrow(/must be "required"/);
      expect(() => parseConfig(JSON.stringify({ encryption: [ACCOUNT] }))).toThrow(/must be an object/);
      expect(() => parseConfig(JSON.stringify({ encryption: 'required' }))).toThrow(/must be an object/);
    });

    await it('fails closed on a target that is empty or padded', async () => {
      expect(() => config({ '': 'required' })).toThrow(/must not be empty or padded/);
      expect(() => config({ [` ${ACCOUNT}`]: 'required' })).toThrow(/must not be empty or padded/);
    });
  });

  await describe('saving config.encryption', async () => {
    await it('writes the section back, and omits it when nothing is required', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-encryption-'));
      const path = join(dir, 'config.json');
      try {
        saveConfig(config({ [`${ACCOUNT}/${PERSON}`]: 'required' }), path);
        expect(JSON.parse(readFileSync(path, 'utf8')).encryption[`${ACCOUNT}/${PERSON}`]).toBe('required');

        // Like `grants`: an empty section is left out rather than written as `{}`, so a config
        // nobody set this in stays a config without the key.
        saveConfig(defaultConfig(), path);
        expect('encryption' in JSON.parse(readFileSync(path, 'utf8'))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  await describe('which peers it covers', async () => {
    await it('matches the peer it names, and nobody else', async () => {
      const parsed = config({ [`${ACCOUNT}/${PERSON}`]: 'required' });
      expect(encryptionRequired(parsed, ACCOUNT, PERSON)).toBe(true);
      expect(encryptionRequired(parsed, ACCOUNT, OTHER)).toBe(false);
      expect(encryptionRequired(parsed, 'xmpp-other', PERSON)).toBe(false);
    });

    await it('an account-wide target covers every peer of that account', async () => {
      const parsed = config({ [ACCOUNT]: 'required' });
      expect(encryptionRequired(parsed, ACCOUNT, PERSON)).toBe(true);
      expect(encryptionRequired(parsed, ACCOUNT, OTHER)).toBe(true);
      expect(encryptionRequired(parsed, 'xmpp-other', PERSON)).toBe(false);
    });

    await it('hands the session only the covered addresses of the account', async () => {
      const parsed = config({ [`${ACCOUNT}/${PERSON}`]: 'required' });
      expect(requireEncryptionFor(parsed, ACCOUNT, [PERSON, OTHER]).join(' ')).toBe(PERSON);
      expect(requireEncryptionFor(parsed, 'xmpp-other', [PERSON, OTHER]).length).toBe(0);
      expect(requireEncryptionFor(config({ [ACCOUNT]: 'required' }), ACCOUNT, [PERSON, OTHER]).length).toBe(
        2,
      );
    });
  });
}
