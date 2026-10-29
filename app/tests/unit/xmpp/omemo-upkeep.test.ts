/**
 * Device upkeep, BTBV and the read-only surface of stage 2 (ADR 0006 §§3, 5, 6).
 *
 * Every key here comes from `@curlew/omemo` itself and every address is synthetic, so nothing
 * depends on bytes a fixture file would have to vouch for.
 */

import { describe, expect, it } from '@gjsify/unit';
import { generateKeyPair, LEGACY_PROFILE, MemoryOmemoStorage, toBase64 } from '@curlew/omemo';
import {
  deleteConsumedPreKeys,
  ensureBundle,
  ensureOwnDevice,
  hasVerifiedKey,
  loadOwnDevice,
  noteIdentity,
  SIGNED_PREKEY_PERIOD_MS,
  summarizeDevices,
} from '@curlew/xmpp';

import { decryptAccounts } from '../../../src/core/actions/omemo.ts';
import { registerOmemoTools } from '../../../src/frontends/mcp/tools/omemo.ts';
import { createRecorder } from '../mcp/recorder.ts';

const START = new Date('2026-01-01T00:00:00Z');
const alice = { jid: 'alice@example.org', deviceId: 11 };
const aliceTwo = { jid: 'alice@example.org', deviceId: 12 };

export default async function omemoUpkeep(): Promise<void> {
  await describe('own device', async () => {
    await it('is created once and then loaded, never replaced', async () => {
      const storage = new MemoryOmemoStorage();
      expect(await loadOwnDevice(storage)).toBeUndefined();
      const first = await ensureOwnDevice(storage, [1, 2]);
      const second = await ensureOwnDevice(storage, [1, 2]);
      expect(second.deviceId).toBe(first.deviceId);
      expect(toBase64(second.identityKey.publicKey)).toBe(toBase64(first.identityKey.publicKey));
    });

    await it('avoids a device id the account already publishes', async () => {
      const storage = new MemoryOmemoStorage();
      const device = await ensureOwnDevice(storage, [5]);
      expect(device.deviceId === 5).toBe(false);
    });
  });

  await describe('bundle upkeep', async () => {
    await it('fills the prekeys on the first call and reports a change', async () => {
      const storage = new MemoryOmemoStorage();
      const device = await ensureOwnDevice(storage);
      const state = await ensureBundle(storage, device, { now: () => START });
      expect(state.changed).toBe(true);
      expect(state.bundle.preKeys.length).toBe(LEGACY_PROFILE.preKeyCount);
    });

    await it('publishes nothing new when nothing expired and nothing was spent', async () => {
      const storage = new MemoryOmemoStorage();
      const device = await ensureOwnDevice(storage);
      await ensureBundle(storage, device, { now: () => START });
      const again = await ensureBundle(storage, device, { now: () => new Date(START.getTime() + 1000) });
      expect(again.changed).toBe(false);
    });

    await it('rotates the signed prekey after its period and keeps the old one for late senders', async () => {
      const storage = new MemoryOmemoStorage();
      const device = await ensureOwnDevice(storage);
      const first = await ensureBundle(storage, device, { now: () => START });
      const firstId = await storage.loadCurrentSignedPreKeyId();
      const later = new Date(START.getTime() + SIGNED_PREKEY_PERIOD_MS + 1);
      const second = await ensureBundle(storage, device, { now: () => later });
      expect(second.changed).toBe(true);
      expect(toBase64(second.bundle.signedPreKey) === toBase64(first.bundle.signedPreKey)).toBe(false);
      expect((await storage.loadCurrentSignedPreKeyId()) === firstId).toBe(false);
      expect((await storage.listSignedPreKeyIds()).length).toBe(2);
    });

    await it('replenishes below the threshold and deletes only consumed prekeys', async () => {
      const storage = new MemoryOmemoStorage();
      const device = await ensureOwnDevice(storage);
      await ensureBundle(storage, device, { now: () => START });
      const ids = await storage.listPreKeyIds();
      const spend = ids.length - LEGACY_PROFILE.preKeyRefillThreshold + 1;
      for (const id of ids.slice(0, spend)) await storage.markPreKeyConsumed(id, START.toISOString());

      // Marked is not deleted: a MAM catch-up may meet the same prekey again.
      expect((await storage.listPreKeyIds()).length).toBe(ids.length);
      const deleted = await deleteConsumedPreKeys(storage);
      expect(deleted.length).toBe(spend);

      const refilled = await ensureBundle(storage, device, { now: () => START });
      expect(refilled.changed).toBe(true);
      expect(refilled.bundle.preKeys.length).toBe(LEGACY_PROFILE.preKeyCount);
    });
  });

  await describe('BTBV', async () => {
    await it('accepts a first key blindly and knows it again', async () => {
      const storage = new MemoryOmemoStorage();
      const key = generateKeyPair().publicKey;
      const first = await noteIdentity(storage, alice, key, START);
      expect(first.outcome).toBe('new');
      expect(first.record.trust).toBe('blind');
      expect((await noteIdentity(storage, alice, key, START)).outcome).toBe('known');
    });

    await it('leaves a new device undecided once a person has verified a key of that contact', async () => {
      const storage = new MemoryOmemoStorage();
      const noted = await noteIdentity(storage, alice, generateKeyPair().publicKey, START);
      await storage.saveIdentity(alice, { ...noted.record, trust: 'verified' });
      expect(await hasVerifiedKey(storage, alice.jid)).toBe(true);
      const other = await noteIdentity(storage, aliceTwo, generateKeyPair().publicKey, START);
      expect(other.record.trust).toBe('undecided');
    });

    await it('does not let a changed key inherit trust', async () => {
      const storage = new MemoryOmemoStorage();
      const noted = await noteIdentity(storage, alice, generateKeyPair().publicKey, START);
      await storage.saveIdentity(alice, { ...noted.record, trust: 'verified' });
      const replaced = await noteIdentity(storage, alice, generateKeyPair().publicKey, START);
      expect(replaced.outcome).toBe('replaced');
      expect(replaced.record.trust).toBe('undecided');
    });
  });

  await describe('device summary', async () => {
    await it('shows fingerprints, trust and session presence, never key material', async () => {
      const storage = new MemoryOmemoStorage();
      await noteIdentity(storage, alice, generateKeyPair().publicKey, START);
      const [summary] = await summarizeDevices(storage, alice.jid);
      expect(summary?.fingerprint.length).toBe(64);
      expect(summary?.session).toBe(false);
      expect(summary?.trust).toBe('blind');
      expect(JSON.stringify(summary).includes('rivate')).toBe(false);
    });

    await it('skips a damaged identity row instead of failing the listing', async () => {
      const storage = new MemoryOmemoStorage();
      await noteIdentity(storage, alice, generateKeyPair().publicKey, START);
      await storage.saveIdentity(aliceTwo, {
        publicKey: '%%%',
        trust: 'blind',
        firstSeen: START.toISOString(),
      });
      expect((await summarizeDevices(storage, alice.jid)).length).toBe(1);
    });
  });

  await describe('the xmpp.omemo grant and its MCP tool', async () => {
    await it('decrypts only for accounts a grant names, once each', async () => {
      expect(decryptAccounts(undefined)).toEqualArray([]);
      expect(
        decryptAccounts([
          { capability: 'xmpp.omemo', target: 'xmpp-1' },
          { capability: 'xmpp.omemo', target: 'xmpp-1' },
          { capability: 'xmpp.send', target: 'xmpp-2/bob@example.org' },
        ]),
      ).toEqualArray(['xmpp-1']);
    });

    await it('registers omemo_devices as read-only and closed-world', async () => {
      const rec = createRecorder();
      registerOmemoTools(rec.server);
      expect(rec.names()).toEqualArray(['omemo_devices']);
      const tool = rec.find('omemo_devices');
      expect(tool?.annotations?.readOnlyHint).toBe(true);
      expect(tool?.annotations?.openWorldHint).toBe(false);
    });
  });
}
