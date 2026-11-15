import { describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendChangesTransaction, migrate, openIndexDb } from '@curlew/store';

import { listStamp } from '../../../src/window/conversation-list-store.ts';

export default async () => {
  describe('the conversation list stamp', () => {
    it('changes with the change journal and the config, not with other index writes', () => {
      const dir = mkdtempSync(join(tmpdir(), 'curlew-stamp-'));
      try {
        const path = join(dir, 'index.db');
        const cfg = join(dir, 'config.json');
        writeFileSync(cfg, '{}');
        const db = openIndexDb(path);
        try {
          migrate(db);
          const first = listStamp(path, cfg);
          expect(listStamp(path, cfg)).toBe(first);

          // What the daemon's lease heartbeat does every 30 s: a write that changes no list row.
          db.exec('CREATE TABLE IF NOT EXISTS stamp_probe (n INTEGER)');
          db.prepare('INSERT INTO stamp_probe (n) VALUES (?)').run(1);
          expect(listStamp(path, cfg)).toBe(first);

          appendChangesTransaction(db, [{ kind: 'messages', backend: 'xmpp' }]);
          const journalled = listStamp(path, cfg);
          expect(journalled === first).toBe(false);

          writeFileSync(cfg, '{"ui":{}}');
          expect(listStamp(path, cfg) === journalled).toBe(false);
        } finally {
          db.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('does not throw when nothing exists yet', () => {
      expect(listStamp('/nonexistent/index.db', '/nonexistent/config.json')).toBe('-|-');
    });
  });
};
