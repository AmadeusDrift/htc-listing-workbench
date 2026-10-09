import type { DatabaseSync } from 'node:sqlite';
import { RECORD_INDEXES } from '../../src/main/record-indexes.ts';

/** Historical fixtures remove v13 sync, v11 receipts, v10 collection, and v9 expression indexes. */
export function dropRecordQueryIndexes(db: DatabaseSync): void {
  db.exec('DROP TABLE IF EXISTS miaoshou_sync_items; DROP TABLE IF EXISTS miaoshou_sync_runs; DROP TABLE IF EXISTS miaoshou_receipts; DROP TABLE IF EXISTS collection_captures; DROP TABLE IF EXISTS collection_receipts');
  for (const index of RECORD_INDEXES) db.exec(`DROP INDEX IF EXISTS ${index.name}`);
}
