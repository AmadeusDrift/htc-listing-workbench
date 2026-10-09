import type { DatabaseSync } from 'node:sqlite';
import type { ItemLabelFormat } from '../../shared/item-label-contracts.ts';
import { openDatabase } from '../database.ts';
import { validateItemLabelFormat } from './adapter.ts';

export class ItemLabelSettings {
  private db: DatabaseSync;
  constructor(directory: string) { this.db = openDatabase(directory); }
  get(): ItemLabelFormat {
    const row = this.db.prepare("SELECT value_json FROM amazon_settings WHERE key='item_label_format_v1'").get();
    return validateItemLabelFormat(row ? JSON.parse(String(row.value_json)) : undefined);
  }
  save(raw: unknown): ItemLabelFormat {
    const format = validateItemLabelFormat(raw);
    this.db.prepare("INSERT INTO amazon_settings(key,value_json) VALUES('item_label_format_v1',?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json").run(JSON.stringify(format));
    return format;
  }
  close(): void { this.db.close(); }
}
