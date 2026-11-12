import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolve } from '../../../src/core/agent-access.ts';
import {
  aiEnabled,
  defaultConfig,
  effectiveAgentAccess,
  parseConfig,
  saveConfig,
} from '../../../src/core/config.ts';
import { createMcpServer } from '../../../src/frontends/mcp/server.ts';

const ACC = 'xmpp-abc123';

export default async () => {
  await describe('AI switch (config.ui.ai)', async () => {
    await it('is off by default and for a file without agent settings', async () => {
      expect(aiEnabled(defaultConfig())).toBe(false);
      expect(aiEnabled(parseConfig('{}'))).toBe(false);
    });

    await it('treats a file that already configures agents as on', async () => {
      const grants = parseConfig(
        JSON.stringify({ grants: [{ capability: 'xmpp.send', target: `${ACC}/a@example.org` }] }),
      );
      expect(aiEnabled(grants)).toBe(true);
      const rules = parseConfig(
        JSON.stringify({ agentAccess: { rules: [{ account: ACC, read: 'allow' }] } }),
      );
      expect(aiEnabled(rules)).toBe(true);
      expect(aiEnabled(parseConfig(JSON.stringify({ agentAccess: { askWithoutRule: false } })))).toBe(true);
    });

    await it('lets an explicit value win over the migration', async () => {
      const off = parseConfig(
        JSON.stringify({ ui: { ai: false }, agentAccess: { rules: [{ account: ACC, read: 'allow' }] } }),
      );
      expect(aiEnabled(off)).toBe(false);
      expect(aiEnabled(parseConfig(JSON.stringify({ ui: { ai: true } })))).toBe(true);
    });

    await it('rejects a non-boolean value', async () => {
      expect(() => parseConfig(JSON.stringify({ ui: { ai: 'yes' } }))).toThrow(/config\.ui\.ai/);
    });

    await it('answers every policy query deny when off, even for the own address', async () => {
      const config = parseConfig(
        JSON.stringify({ ui: { ai: false }, agentAccess: { rules: [{ account: ACC, read: 'allow' }] } }),
      );
      const policy = effectiveAgentAccess(config);
      for (const kind of ['read', 'write'] as const) {
        expect(resolve(policy, { account: ACC, kind }).mode).toBe('deny');
        expect(resolve(policy, { account: ACC, contact: 'me@example.org', kind, self: true }).mode).toBe(
          'deny',
        );
      }
    });

    await it('leaves the policy as configured when on', async () => {
      const config = parseConfig(
        JSON.stringify({ ui: { ai: true }, agentAccess: { rules: [{ account: ACC, read: 'allow' }] } }),
      );
      const policy = effectiveAgentAccess(config);
      expect(resolve(policy, { account: ACC, kind: 'read' }).mode).toBe('allow');
      expect(resolve(policy, { account: ACC, kind: 'write' }).mode).toBe('ask');
    });

    await it('is saved and read back, and never written into agentAccess', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-ai-'));
      try {
        const path = join(dir, 'config.json');
        const config = defaultConfig();
        config.ui.ai = true;
        saveConfig(config, path);
        const text = readFileSync(path, 'utf8');
        expect(JSON.parse(text).ui.ai).toBe(true);
        expect(JSON.parse(text).agentAccess === undefined).toBe(true);
        expect(aiEnabled(parseConfig(text))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await it('serves no MCP tools when off', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-ai-'));
      const before = process.env.CURLEW_CONFIG;
      try {
        const path = join(dir, 'config.json');
        const config = defaultConfig();
        config.ui.ai = false;
        saveConfig(config, path);
        process.env.CURLEW_CONFIG = path;
        const server = createMcpServer() as unknown as { _registeredTools?: Record<string, unknown> };
        expect(Object.keys(server._registeredTools ?? {}).length).toBe(0);
      } finally {
        if (before === undefined) delete process.env.CURLEW_CONFIG;
        else process.env.CURLEW_CONFIG = before;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
