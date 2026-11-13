import { describe, expect, it } from '@gjsify/unit';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openIndexDb } from '@curlew/store';

import { DEMO_ACCOUNTS } from '../../../src/core/demo/accounts.ts';
import { demoActive } from '../../../src/core/demo/active.ts';
import { demoDir, demoIsFresh, prepareDemo } from '../../../src/core/demo/index.ts';
import { generateDemo } from '../../../src/core/demo/generate.ts';

const NOW = Date.parse('2026-06-01T12:00:00Z');

export default async () => {
  describe('demo mode', () => {
    it('reads the CURLEW_DEMO flag', () => {
      expect(demoActive({ CURLEW_DEMO: '1' })).toBe(true);
      expect(demoActive({ CURLEW_DEMO: 'true' })).toBe(true);
      expect(demoActive({ CURLEW_DEMO: '0' })).toBe(false);
      expect(demoActive({})).toBe(false);
    });

    it('puts the demo directory where it is told to', () => {
      expect(demoDir({ CURLEW_DEMO_DIR: '/tmp/x-demo' })).toBe('/tmp/x-demo');
      expect(demoDir({ XDG_CACHE_HOME: '/tmp/cache' })).toBe('/tmp/cache/curlew-demo');
    });

    it('generates a varied, made-up index and a matching config', () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-demo-'));
      try {
        const summary = generateDemo(dir, NOW);
        expect(summary.conversations >= 20).toBe(true);
        expect(summary.messages >= 200).toBe(true);
        expect(summary.reactions > 0).toBe(true);
        expect(existsSync(join(dir, 'index.db'))).toBe(true);
        expect(demoIsFresh(dir)).toBe(true);

        const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as {
          backends: Record<string, { enabled: boolean }>;
          ui: { ai: boolean };
        };
        expect(config.ui.ai).toBe(true);
        for (const a of DEMO_ACCOUNTS) expect(config.backends[a.provider]?.enabled).toBe(true);

        const db = openIndexDb(join(dir, 'index.db'));
        try {
          const accounts = db.prepare('SELECT id FROM accounts').all() as Array<{ id: string }>;
          expect(accounts.length).toBe(DEMO_ACCOUNTS.length);
          const addresses = db
            .prepare('SELECT value FROM participant_addresses WHERE kind = ?')
            .all('email') as Array<{ value: string }>;
          expect(addresses.length > 0).toBe(true);
          for (const { value } of addresses) expect(/@[\w.-]*example\.(org|invalid)$/.test(value)).toBe(true);
          const stats = db
            .prepare(
              'SELECT COUNT(*) AS n FROM conversation_messages WHERE conversation_id NOT IN (SELECT id FROM conversations)',
            )
            .get() as { n: number };
          expect(stats.n).toBe(0);
        } finally {
          db.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('has the same structure on every run', () => {
      const a = mkdtempSync(join(tmpdir(), 'curlew-demo-'));
      const b = mkdtempSync(join(tmpdir(), 'curlew-demo-'));
      try {
        const first = generateDemo(a, NOW);
        const second = generateDemo(b, NOW);
        expect(second.conversations).toBe(first.conversations);
        expect(second.messages).toBe(first.messages);
        expect(second.reactions).toBe(first.reactions);
      } finally {
        rmSync(a, { recursive: true, force: true });
        rmSync(b, { recursive: true, force: true });
      }
    });

    it('points the process at the scratch directory and regenerates a stale one', () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-demo-'));
      try {
        const env: NodeJS.ProcessEnv = { CURLEW_DEMO_DIR: dir };
        expect(demoIsFresh(dir)).toBe(false);
        expect(prepareDemo(env)).toBe(dir);
        expect(env.CURLEW_DEMO).toBe('1');
        expect(env.CURLEW_DB_PATH).toBe(join(dir, 'index.db'));
        expect(env.CURLEW_CONFIG).toBe(join(dir, 'config.json'));
        expect(demoIsFresh(dir)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
};
