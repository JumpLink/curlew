import { describe, expect, it } from '@gjsify/unit';

import { BUILTIN_PLUGINS } from '../../../src/core/backends/builtin.ts';
import { CAPABILITY_NAMES } from '@curlew/protocol';

/**
 * One table for what each backend actually delivers.
 * Each entry lists the TRUE capabilities — everything else must be false.
 * A new capability field or a flipped flag fails here with a readable diff.
 */
const DELIVERED_CAPABILITIES: ReadonlyArray<{
  backend: string;
  manifest: (typeof BUILTIN_PLUGINS)[number]['manifest'];
  trueFlags: string;
}> = [
  {
    backend: 'mail',
    manifest: BUILTIN_PLUGINS.find((p) => p.manifest.name === 'mail')!.manifest,
    trueFlags: 'threads,groups,subject,folders,attachments',
  },
  {
    backend: 'telegram',
    manifest: BUILTIN_PLUGINS.find((p) => p.manifest.name === 'telegram')!.manifest,
    trueFlags: 'edits,threads,readReceipts,groups',
  },
  {
    backend: 'signal',
    manifest: BUILTIN_PLUGINS.find((p) => p.manifest.name === 'signal')!.manifest,
    trueFlags: 'edits,readReceipts,groups,e2ee',
  },
  {
    backend: 'whatsapp',
    manifest: BUILTIN_PLUGINS.find((p) => p.manifest.name === 'whatsapp')!.manifest,
    trueFlags: 'edits,readReceipts,groups,e2ee',
  },
  {
    backend: 'xmpp',
    manifest: BUILTIN_PLUGINS.find((p) => p.manifest.name === 'xmpp')!.manifest,
    trueFlags: 'edits,groups',
  },
  {
    backend: 'matrix',
    manifest: BUILTIN_PLUGINS.find((p) => p.manifest.name === 'matrix')!.manifest,
    trueFlags: 'edits,threads,readReceipts,groups,e2ee',
  },
];

export default async () => {
  await describe('Backend capabilities — delivered vs. declared', async () => {
    // A backend added without a row here would promise whatever its manifest says, unchecked.
    await it('covers every built-in backend', async () => {
      const listed = DELIVERED_CAPABILITIES.map((row) => row.backend).sort();
      expect(listed.join(',')).toBe(
        BUILTIN_PLUGINS.map((p) => p.manifest.name)
          .sort()
          .join(','),
      );
    });
    for (const { backend, manifest, trueFlags } of DELIVERED_CAPABILITIES) {
      await it(`${backend}: only ${trueFlags || '(none)'} are true`, async () => {
        const delivered = CAPABILITY_NAMES.filter((n) => manifest.capabilities[n]).join(',');
        expect(delivered).toBe(trueFlags);
      });
    }
  });
};
