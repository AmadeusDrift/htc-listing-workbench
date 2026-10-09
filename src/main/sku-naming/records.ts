import type { DatabaseSync } from 'node:sqlite';
import { UserFacingError } from '../../shared/errors.ts';
import { SKU_MAX_CHILDREN, SKU_MAX_SEQUENCE, SKU_NAMING_SETTINGS_KEY, assertSafeSku, parseSkuNamingSettings,
  parseSkuNamingTemplate, renderSkuBase, renderSkuChild, skuChildSuffix, skuCollectionDate,
  skuNamingInteger, skuNamingObject, skuNamingText } from '../../shared/sku-naming.ts';
import type { SkuNamingGroup } from '../../shared/sku-naming.ts';
import { SKU_NAMING_SCHEMA, SKU_NAMING_TABLES } from './schema.ts';

function fail(): never { throw new UserFacingError('SKU 命名记录、流水号或身份索引不一致，无法恢复备份'); }
function parseJson(raw: unknown, max = 2 * 1024 * 1024): unknown {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > max) return fail();
  try { return JSON.parse(raw); } catch { return fail(); }
}
export function validateSkuNamingGroup(raw: unknown): SkuNamingGroup {
  const value = skuNamingObject(raw, ['id', 'revision', 'storeScope', 'storeCode', 'sourceGroupKey', 'collectedAt', 'collectionDate', 'sequence', 'baseSku', 'templateSnapshot', 'children', 'createdAt']);
  const id = skuNamingText(value.id, 36, 'SKU 分配编号');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) return fail();
  const storeScope = skuNamingText(value.storeScope, 300, 'SKU 卖家身份'), storeCode = skuNamingText(value.storeCode, 100, 'SKU 店铺编号');
  const sourceGroupKey = skuNamingText(value.sourceGroupKey, 1024, 'SKU 来源商品组'), collectedAt = skuNamingText(value.collectedAt, 40, 'SKU 采集时间');
  const collectionDate = skuCollectionDate(collectedAt), sequence = skuNamingInteger(value.sequence, 1, SKU_MAX_SEQUENCE);
  if (value.collectionDate !== collectionDate) return fail();
  const snapshot = skuNamingObject(value.templateSnapshot, ['settingsRevision', 'template', 'prefix']);
  const template = parseSkuNamingTemplate(snapshot.template), prefix = skuNamingText(snapshot.prefix, 16, 'SKU 前缀');
  const settingsRevision = skuNamingInteger(snapshot.settingsRevision, 0, Number.MAX_SAFE_INTEGER - 1);
  const baseSku = assertSafeSku(value.baseSku);
  if (!Object.hasOwn(template.prefixes, storeCode) || template.prefixes[storeCode] !== prefix || renderSkuBase(template, prefix, collectionDate, sequence) !== baseSku) return fail();
  if (!Array.isArray(value.children) || value.children.length > SKU_MAX_CHILDREN) return fail();
  const keys = new Set<string>(), skus = new Set<string>([baseSku.toLowerCase()]);
  const children = value.children.map((rawChild, position) => {
    const child = skuNamingObject(rawChild, ['key', 'index', 'suffix', 'sku']);
    const key = skuNamingText(child.key, 256, 'SKU 子体身份'), index = position + 1, suffix = skuChildSuffix(index), sku = assertSafeSku(child.sku);
    if (child.index !== index || child.suffix !== suffix || renderSkuChild(template, baseSku, index) !== sku || keys.has(key) || skus.has(sku.toLowerCase())) return fail();
    keys.add(key); skus.add(sku.toLowerCase());
    return { key, index, suffix, sku };
  });
  const createdAt = skuNamingText(value.createdAt, 40, 'SKU 分配时间'); skuCollectionDate(createdAt);
  return { id, revision: skuNamingInteger(value.revision, 1, Number.MAX_SAFE_INTEGER - 1), storeScope, storeCode, sourceGroupKey, collectedAt, collectionDate, sequence,
    baseSku, templateSnapshot: { settingsRevision, template, prefix }, children, createdAt };
}

export function assertSkuNamingHistory(db: DatabaseSync): void {
  const tableNames = Object.keys(SKU_NAMING_TABLES);
  for (const [index, name] of tableNames.entries()) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
    const indexes = db.prepare('SELECT origin FROM pragma_index_list(?)').all(name);
    if (row?.sql !== SKU_NAMING_SCHEMA[index] || indexes.length !== (index === 0 ? 1 : 3) || indexes.some(item => item.origin !== 'pk' && item.origin !== 'u')) return fail();
    if (Number(db.prepare(`SELECT count(*) AS n FROM ${name}`).get()!.n) > (index === 2 ? 500000 : 100000)) return fail();
  }
  const settings = db.prepare('SELECT value_json FROM amazon_settings WHERE key=?').get(SKU_NAMING_SETTINGS_KEY);
  if (settings) parseSkuNamingSettings(parseJson(settings.value_json, 512 * 1024));
  const sequences = new Map<string, number>();
  for (const row of db.prepare('SELECT * FROM sku_naming_sequences').all()) {
    const scope = skuNamingText(row.store_scope, 300, 'SKU 卖家身份'), date = skuNamingText(row.collection_date, 10, 'SKU 采集日期');
    if (skuCollectionDate(date + 'T00:00:00+08:00') !== date) return fail();
    sequences.set(JSON.stringify([scope, date]), skuNamingInteger(row.last_sequence, 1, SKU_MAX_SEQUENCE));
  }
  const identities = new Map<string, { storeScope: string; groupId: string; childKey: string; childIndex: number; sku: string }>();
  for (const row of db.prepare('SELECT * FROM sku_naming_groups').all()) {
    const group = validateSkuNamingGroup(parseJson(row.record_json));
    if (row.id !== group.id || row.store_scope !== group.storeScope || row.source_group_key !== group.sourceGroupKey
      || row.collection_date !== group.collectionDate || row.sequence !== group.sequence
      || (sequences.get(JSON.stringify([group.storeScope, group.collectionDate])) ?? 0) < group.sequence) return fail();
    for (const child of [{ key: '', index: 0, sku: group.baseSku }, ...group.children]) {
      const key = JSON.stringify([group.storeScope, child.sku.toLowerCase()]);
      if (identities.has(key)) return fail();
      identities.set(key, { storeScope: group.storeScope, groupId: group.id, childKey: child.key, childIndex: child.index, sku: child.sku });
    }
  }
  const duplicateJson = db.prepare(`SELECT 1 FROM sku_naming_groups WHERE EXISTS (
    SELECT 1 FROM json_tree(sku_naming_groups.record_json) AS member WHERE member.parent IS NOT NULL
    GROUP BY member.parent,member.key COLLATE BINARY HAVING COUNT(*)>1
  ) LIMIT 1`).get();
  if (duplicateJson) return fail();
  for (const row of db.prepare('SELECT * FROM sku_naming_identities').all()) {
    const key = JSON.stringify([row.store_scope, String(row.sku).toLowerCase()]), expected = identities.get(key);
    if (!expected || row.group_id !== expected.groupId || row.child_key !== expected.childKey || row.child_index !== expected.childIndex || row.sku !== expected.sku) return fail();
    identities.delete(key);
  }
  if (identities.size) return fail();
}

/** Called inside the restore transaction. Keeping the later ledger prevents recycled SKUs. */
export function retainSkuNamingHistory(current: DatabaseSync, snapshot: DatabaseSync): void {
  if (!current.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sku_naming_groups'").get()) return;
  assertSkuNamingHistory(current); assertSkuNamingHistory(snapshot);
  for (const row of current.prepare('SELECT * FROM sku_naming_sequences').all()) {
    snapshot.prepare('INSERT INTO sku_naming_sequences VALUES(?,?,?) ON CONFLICT(store_scope,collection_date) DO UPDATE SET last_sequence=max(last_sequence,excluded.last_sequence)').run(row.store_scope, row.collection_date, row.last_sequence);
  }
  for (const row of current.prepare('SELECT * FROM sku_naming_groups').all()) {
    const incoming = validateSkuNamingGroup(parseJson(row.record_json));
    const existing = snapshot.prepare('SELECT record_json FROM sku_naming_groups WHERE id=?').get(incoming.id);
    if (existing) {
      const previous = validateSkuNamingGroup(parseJson(existing.record_json));
      const { revision: _oldRevision, children: oldChildren, ...oldIdentity } = previous;
      const { revision: _newRevision, children: newChildren, ...newIdentity } = incoming;
      if (JSON.stringify(oldIdentity) !== JSON.stringify(newIdentity)
        || oldChildren.slice(0, newChildren.length).some((child, index) => newChildren[index] && JSON.stringify(child) !== JSON.stringify(newChildren[index]))) return fail();
      if (newChildren.length > oldChildren.length) snapshot.prepare('UPDATE sku_naming_groups SET record_json=? WHERE id=?').run(JSON.stringify(incoming), incoming.id);
    } else {
      try { snapshot.prepare('INSERT INTO sku_naming_groups VALUES(?,?,?,?,?,?)').run(row.id, row.store_scope, row.source_group_key, row.collection_date, row.sequence, row.record_json); }
      catch { return fail(); }
    }
    for (const child of [{ key: '', index: 0, sku: incoming.baseSku }, ...incoming.children]) {
      const prior = snapshot.prepare('SELECT * FROM sku_naming_identities WHERE store_scope=? AND sku=?').get(incoming.storeScope, child.sku);
      if (prior) { if (prior.group_id !== incoming.id || prior.child_key !== child.key || prior.child_index !== child.index || prior.sku !== child.sku) return fail(); }
      else {
        try { snapshot.prepare('INSERT INTO sku_naming_identities VALUES(?,?,?,?,?)').run(incoming.storeScope, child.sku, incoming.id, child.key, child.index); }
        catch { return fail(); }
      }
    }
  }
  assertSkuNamingHistory(snapshot);
}
