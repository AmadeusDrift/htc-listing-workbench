import type { DatabaseSync } from 'node:sqlite';
import { assertOwner, type DataOwner } from './owners.ts';

/** Shared physical table, owner checked at the actual key before any write. */
export function writeOwnedSetting(db:DatabaseSync,owner:DataOwner,key:string,valueJson:string):void {
  assertOwner(owner,'amazon_settings',key);
  db.prepare('INSERT INTO amazon_settings(key,value_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run(key,valueJson);
}
