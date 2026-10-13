import { writeOwnedSetting } from './storage/settings.ts';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './database.ts';
import { defaultListingRules, parseListingRules } from '../shared/listing-rules.ts';
import type { ListingRules } from '../shared/listing-rules.ts';
import { UserFacingError } from '../shared/errors.ts';

export const LISTING_RULES_KEY = 'listing_rules_v1';
export function readListingRules(db: DatabaseSync): ListingRules {
  const row = db.prepare('SELECT value_json FROM amazon_settings WHERE key=?').get(LISTING_RULES_KEY);
  return row ? parseListingRules(JSON.parse(String(row.value_json))) : defaultListingRules();
}
export class ListingRuleStore {
  private db: DatabaseSync;
  constructor(directory: string) { this.db = openDatabase(directory); }
  get(): ListingRules {
    return readListingRules(this.db);
  }
  save(raw: unknown): ListingRules {
    const value = parseListingRules(raw);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.get().revision !== value.revision) throw new UserFacingError('规则已更新，请重新读取后保存，避免覆盖其他修改');
      value.revision++;
      writeOwnedSetting(this.db,'settings',LISTING_RULES_KEY, JSON.stringify(value));
      this.db.exec('COMMIT'); return value;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db.close(); }
}
