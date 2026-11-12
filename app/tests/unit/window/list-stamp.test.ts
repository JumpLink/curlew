import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listStamp } from '../../../src/window/conversation-list-store.ts';

export default async () => {
  describe('the conversation list stamp', () => {
    it('stays equal until the index, its journal or the config change', () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-stamp-'));
      try {
        const db = join(dir, 'index.db');
        const cfg = join(dir, 'config.json');
        writeFileSync(db, 'a');
        writeFileSync(cfg, '{}');
        const first = listStamp(db, cfg);
        expect(listStamp(db, cfg)).toBe(first);
        writeFileSync(`${db}-wal`, 'new write');
        const withJournal = listStamp(db, cfg);
        expect(withJournal === first).toBe(false);
        writeFileSync(cfg, '{"ui":{}}');
        expect(listStamp(db, cfg) === withJournal).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('does not throw when nothing exists yet', () => {
      expect(listStamp('/nonexistent/index.db', '/nonexistent/config.json')).toBe('-|-|-');
    });
  });
};
