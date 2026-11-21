/**
 * Narrow entry for @curlew/store/index-db: open, migrate and search the index, nothing else.
 *
 * The main entry also reaches the sync engines, secret files and the desktop paths. A shell that
 * only needs to prove the SQLite layer (the Android probe) imports this.
 */

export { openIndexDb, probeFts5 } from './db.ts';
export { migrate } from './schema.ts';
export { upsertAccount, upsertFolder, upsertMessages, searchIndex } from './index-store.ts';
