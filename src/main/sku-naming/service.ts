import { writeOwnedSetting } from '../storage/settings.ts';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../database.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { SKU_MAX_CHILDREN, SKU_MAX_SEQUENCE, SKU_NAMING_SETTINGS_KEY, assertSafeSku, defaultSkuNamingSettings,
  parseSkuNamingSettings, previewSkuNaming, renderSkuBase, renderSkuChild, resolveSkuNamingTemplate,
  skuChildSuffix, skuCollectionDate, skuNamingObject, skuNamingText } from '../../shared/sku-naming.ts';
import type { SkuNamingGroup, SkuNamingPreview, SkuNamingSettings } from '../../shared/sku-naming.ts';

export class SkuNamingService {
  private db: DatabaseSync;
  private closed = false;
  private borrowed = false;
  constructor(directory: string, transactionDb?: DatabaseSync) { this.db = transactionDb ?? openDatabase(directory); this.borrowed = !!transactionDb; }
  getSettings(): SkuNamingSettings {
    const row = this.db.prepare('SELECT value_json FROM amazon_settings WHERE key=?').get(SKU_NAMING_SETTINGS_KEY);
    return row ? parseSkuNamingSettings(JSON.parse(String(row.value_json))) : defaultSkuNamingSettings();
  }
  saveSettings(raw: unknown): SkuNamingSettings {
    const value = parseSkuNamingSettings(raw);
    return this.transaction(() => {
      if (this.getSettings().revision !== value.revision) throw new UserFacingError('SKU 命名规则已被更改，请刷新后再保存');
      const next = { ...value, revision: value.revision + 1 };
      writeOwnedSetting(this.db,'sales',SKU_NAMING_SETTINGS_KEY, JSON.stringify(next));
      return next;
    });
  }
  preview(raw: unknown): SkuNamingPreview { return previewSkuNaming(raw, this.getSettings()); }
  lookup(storeScope: string, sourceGroupKey: string): SkuNamingGroup | null {
    skuNamingText(storeScope, 300, '卖家身份'); skuNamingText(sourceGroupKey, 1024, '来源商品组');
    const row = this.db.prepare('SELECT record_json FROM sku_naming_groups WHERE store_scope=? AND source_group_key=?').get(storeScope, sourceGroupKey);
    return row ? JSON.parse(String(row.record_json)) as SkuNamingGroup : null;
  }
  allocate(raw: unknown): SkuNamingGroup {
    const input = skuNamingObject(raw, ['storeScope', 'storeCode', 'sourceGroupKey', 'collectedAt', 'childKeys'], ['targetId']);
    const storeScope = skuNamingText(input.storeScope, 300, '卖家身份'), storeCode = skuNamingText(input.storeCode, 100, 'SKU 店铺编号');
    const sourceGroupKey = skuNamingText(input.sourceGroupKey, 1024, '来源商品组'), collectedAt = skuNamingText(input.collectedAt, 40, '采集时间');
    const collectionDate = skuCollectionDate(collectedAt), targetId = input.targetId === undefined ? undefined : skuNamingText(input.targetId, 100, '目标店铺编号');
    if (!Array.isArray(input.childKeys) || input.childKeys.length > SKU_MAX_CHILDREN) throw new UserFacingError('SKU 子体数量超出限制');
    const childKeys = [...new Set(input.childKeys.map(key => skuNamingText(key, 256, '子体身份')))];
    return this.transaction(() => {
      const existing = this.lookup(storeScope, sourceGroupKey);
      if (existing) return this.appendChildren(existing, childKeys);
      const settings = this.getSettings(), template = resolveSkuNamingTemplate(settings, storeCode, targetId), prefix = template.prefixes[storeCode];
      const prior = this.db.prepare('SELECT last_sequence FROM sku_naming_sequences WHERE store_scope=? AND collection_date=?').get(storeScope, collectionDate);
      const sequence = Number(prior?.last_sequence ?? 0) + 1;
      if (sequence > SKU_MAX_SEQUENCE) throw new UserFacingError('此店铺采集日的 SKU 流水号已达到上限');
      const group: SkuNamingGroup = { id: randomUUID(), revision: 1, storeScope, storeCode, sourceGroupKey, collectedAt, collectionDate, sequence,
        baseSku: renderSkuBase(template, prefix, collectionDate, sequence), templateSnapshot: { settingsRevision: settings.revision, template, prefix },
        children: [], createdAt: new Date().toISOString() };
      this.db.prepare('INSERT INTO sku_naming_sequences VALUES(?,?,?) ON CONFLICT(store_scope,collection_date) DO UPDATE SET last_sequence=excluded.last_sequence').run(storeScope, collectionDate, sequence);
      this.db.prepare('INSERT INTO sku_naming_groups VALUES(?,?,?,?,?,?)').run(group.id, storeScope, sourceGroupKey, collectionDate, sequence, JSON.stringify(group));
      this.reserveIdentity(group, '', 0, group.baseSku);
      return this.appendChildren(group, childKeys);
    });
  }
  assertIdentity(raw: unknown): void {
    const input = skuNamingObject(raw, ['storeScope', 'sourceGroupKey', 'sku'], ['childKey']);
    const group = this.lookup(skuNamingText(input.storeScope, 300, '卖家身份'), skuNamingText(input.sourceGroupKey, 1024, '来源商品组'));
    const key = input.childKey === undefined ? undefined : skuNamingText(input.childKey, 256, '子体身份');
    const expected = key === undefined ? group?.baseSku : group?.children.find(child => child.key === key)?.sku;
    if (!expected || expected !== assertSafeSku(input.sku)) throw new UserFacingError('上架 SKU 与已分配的商品组身份不一致');
  }
  close(): void { if (!this.closed) { if (!this.borrowed) this.db.close(); this.closed = true; } }
  private appendChildren(group: SkuNamingGroup, keys: string[]): SkuNamingGroup {
    const known = new Set(group.children.map(child => child.key)), added = keys.filter(key => !known.has(key));
    if (group.children.length + added.length > SKU_MAX_CHILDREN) throw new UserFacingError('SKU 子体数量超出限制');
    if (!added.length) return group;
    for (const key of added) {
      const index = group.children.length + 1, sku = renderSkuChild(group.templateSnapshot.template, group.baseSku, index);
      this.reserveIdentity(group, key, index, sku);
      group.children.push({ key, index, suffix: skuChildSuffix(index), sku });
    }
    group.revision++;
    this.db.prepare('UPDATE sku_naming_groups SET record_json=? WHERE id=?').run(JSON.stringify(group), group.id);
    return group;
  }
  private reserveIdentity(group: SkuNamingGroup, childKey: string, index: number, sku: string): void {
    const conflict = this.db.prepare('SELECT group_id FROM sku_naming_identities WHERE store_scope=? AND sku=?').get(group.storeScope, sku);
    if (conflict) throw new UserFacingError(`SKU ${sku} 已被占用；请调整命名模板后重试`);
    this.db.prepare('INSERT INTO sku_naming_identities VALUES(?,?,?,?,?)').run(group.storeScope, sku, group.id, childKey, index);
  }
  private transaction<T>(action: () => T): T {
    if (this.borrowed) { if (!this.db.isTransaction) throw new Error('Naming requires an active owner transaction'); return action(); }
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
