import { describe, expect, it } from '@gjsify/unit';
import type { BackendCapabilities } from '@curlew/protocol';

import type { BackendStatus } from '../../../src/core/backends/registry.ts';
import { addableProtocols, mailProtocol, needsTerms } from '../../../src/window/account-add-model.ts';

function status(name: string, over: Partial<BackendStatus> = {}): BackendStatus {
  return {
    name,
    displayName: name,
    enabled: false,
    syncModel: 'server-archive',
    storeTier: 'derived',
    native: false,
    capabilities: {} as BackendCapabilities,
    terms: null,
    termsAccepted: false,
    ...over,
  };
}

export default async () => {
  await describe('addableProtocols', async () => {
    await it('leaves mail out and orders the chats the same way every time', async () => {
      const list = addableProtocols([status('xmpp'), status('mail'), status('whatsapp'), status('signal')]);
      expect(list.map((p) => p.backend)).toStrictEqual(['signal', 'whatsapp', 'xmpp']);
    });

    await it('offers mail apart, without terms, and only when the backend exists', async () => {
      const mail = mailProtocol([status('xmpp'), status('mail')]);
      expect(mail?.backend).toBe('mail');
      expect(mail !== null && needsTerms(mail)).toBe(false);
      expect(mailProtocol([status('xmpp')])).toBe(null);
    });

    await it('carries the terms until they are accepted', async () => {
      const terms = { summary: 'Unofficial protocol.' };
      const [pending] = addableProtocols([status('whatsapp', { terms })]);
      expect(needsTerms(pending)).toBe(true);
      const [accepted] = addableProtocols([status('whatsapp', { terms, termsAccepted: true })]);
      expect(needsTerms(accepted)).toBe(false);
      const [none] = addableProtocols([status('matrix')]);
      expect(needsTerms(none)).toBe(false);
    });

    await it('keeps whether the backend is enabled', async () => {
      const [on] = addableProtocols([status('matrix', { enabled: true })]);
      expect(on.enabled).toBe(true);
    });
  });
};
