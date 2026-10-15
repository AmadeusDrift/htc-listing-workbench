import type { DatabaseSync } from 'node:sqlite';
import { RECORD_INDEXES, SALES_IDENTITY_INDEXES } from '../../src/main/record-indexes.ts';

/** Historical fixtures remove v33 sale indexes, v18 completion, v13 sync, v11 receipts, v10 collection, and v9 expression indexes. */
export function dropRecordQueryIndexes(db: DatabaseSync): void {
  db.exec('DROP TABLE IF EXISTS listing_completion_operations; DROP TABLE IF EXISTS miaoshou_sync_items; DROP TABLE IF EXISTS miaoshou_sync_runs; DROP TABLE IF EXISTS miaoshou_receipts; DROP TABLE IF EXISTS collection_captures; DROP TABLE IF EXISTS collection_receipts');
  for (const index of [...RECORD_INDEXES,...SALES_IDENTITY_INDEXES]) db.exec(`DROP INDEX IF EXISTS ${index.name}`);
}

/** Explicit synthetic downgrade only: tables introduced after schema33 never existed in these old fixtures. */
export function dropPost33FixtureTables(db:DatabaseSync):void{
  db.exec('DROP TABLE IF EXISTS ai_spend_policies; DROP TABLE IF EXISTS ai_spend_reservations; DROP TABLE IF EXISTS controlled_run_scopes; DROP TABLE IF EXISTS image_review_journal; DROP TABLE IF EXISTS ai_category_operations');
}
