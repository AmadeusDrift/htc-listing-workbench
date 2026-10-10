import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { MiaoshouImportResult, MiaoshouMapping, MiaoshouProduct, MiaoshouReceipt } from '../../shared/miaoshou-contracts.ts';
import type { WorkspaceStore } from '../store.ts';
import { assertUnambiguousRecordJson } from '../record-json.ts';
import { fail, fingerprint, importWarnings, localPrice, MiaoshouError, selectedImageIds, uuid, validateMiaoshouReceipt } from './validation.ts';
import { normalizeSourceAttributeV1 } from './source-attribute-normalization-v1.ts';

export { validateMiaoshouReceipt } from './validation.ts';
/** Creation history survives later edits/deletions, like source SKU mappings.
 * A missing random fact ID cannot authenticate its former existence by itself. */
export function assertMiaoshouFactHistory(db: DatabaseSync, receipt: MiaoshouReceipt): void {
  if (!receipt.factNormalizations) return;
  const fact = db.prepare('SELECT product_id FROM facts WHERE id=?');
  const identity = db.prepare('SELECT id FROM products WHERE id=? UNION ALL SELECT id FROM variants WHERE id=? UNION ALL SELECT id FROM miaoshou_receipts WHERE id=?');
  for (const entry of receipt.factNormalizations.entries) {
    const row = fact.get(entry.factId);
    if (row && row.product_id !== receipt.productId || identity.get(entry.factId, entry.factId, entry.factId)) return fail('STORAGE');
  }
}
export function assertMiaoshouHistory(db: DatabaseSync): void {
  assertUnambiguousRecordJson(db, 'miaoshou_receipts');
  const fingerprints = new Set<string>(), products = new Set<string>(), identifiers = new Set<string>();
  for (const row of db.prepare('SELECT id,record_json FROM miaoshou_receipts').iterate()) {
    const receipt = validateMiaoshouReceipt(JSON.parse(String(row.record_json)));
    if (row.id !== receipt.id || fingerprints.has(receipt.fingerprint) || products.has(receipt.productId)
      || !db.prepare('SELECT id FROM products WHERE id=?').get(receipt.productId)) return fail();
    fingerprints.add(receipt.fingerprint); products.add(receipt.productId);
    for (const id of [receipt.id, receipt.productId, ...receipt.skuMappings.map(s => s.localVariantId), ...(receipt.factNormalizations?.entries.map(entry => entry.factId) ?? [])]) { if (identifiers.has(id)) return fail(); identifiers.add(id); }
    assertMiaoshouFactHistory(db, receipt);
    for (const mapping of receipt.skuMappings) {
      const row = db.prepare('SELECT product_id FROM variants WHERE id=?').get(mapping.localVariantId);
      // Source history survives a user's deliberate deletion of a variant.
      if (row && row.product_id !== receipt.productId) return fail();
    }
  }
}
export function getReceipt(db: DatabaseSync, rawProductId: unknown): MiaoshouReceipt | null {
  const productId = uuid(rawProductId);
  try {
    const rows = db.prepare("SELECT id,record_json FROM miaoshou_receipts WHERE json_extract(record_json,'$.productId')=?").all(productId);
    if (!rows.length) return null; if (rows.length !== 1) return fail('STORAGE');
    const receipt = validateMiaoshouReceipt(JSON.parse(String(rows[0].record_json)));
    if (rows[0].id !== receipt.id || receipt.productId !== productId) return fail('STORAGE');
    assertMiaoshouFactHistory(db, receipt);
    return receipt;
  } catch (error) { if (error instanceof MiaoshouError) throw error; return fail('STORAGE'); }
}
function originalSpec(product: MiaoshouProduct, mapping: MiaoshouMapping, sourceKey: string): string {
  const selected = mapping.skus.find(s => s.sourceKey === sourceKey)!;
  const names = product.dimensions.flatMap(d => { const value = d.values.find(v => v.id === selected.dimensions[d.id]); return value ? [`${d.name}: ${value.name}`] : []; });
  if (!names.length) return `来源 SKU ${sourceKey}（规格待核对）`;
  const unresolved = product.dimensions.some(d => d.values.length && !selected.dimensions[d.id]);
  return names.join(' / ') + (unresolved ? '（部分规格待核对）' : '');
}
function result(receipt: MiaoshouReceipt, duplicate: boolean): MiaoshouImportResult {
  return { productId: receipt.productId, duplicate, warnings: importWarnings(receipt.snapshot, receipt.mapping), skuCount: receipt.snapshot.skus.length, imageCount: receipt.snapshot.images.length };
}
/** One connection owns the full local transaction; WorkspaceStore.importProducts is intentionally not nested. */
export function persistImport(db: DatabaseSync, store: WorkspaceStore, snapshot: MiaoshouProduct, mapping: MiaoshouMapping,
  accountScope: string, mode: 'demo' | 'live', receivedAt: string, assertNewImport?: (value: unknown) => void): MiaoshouImportResult {
  const contentFingerprint = fingerprint(snapshot, mapping, accountScope, mode);
  db.exec('BEGIN IMMEDIATE');
  try {
    const duplicates = db.prepare("SELECT id,record_json FROM miaoshou_receipts WHERE json_extract(record_json,'$.fingerprint')=?").all(contentFingerprint);
    if (duplicates.length > 1) return fail('STORAGE');
    if (duplicates.length) {
      const prior = validateMiaoshouReceipt(JSON.parse(String(duplicates[0].record_json)));
      if (prior.id !== duplicates[0].id || prior.fingerprint !== contentFingerprint) return fail('STORAGE');
      assertMiaoshouFactHistory(db, prior);
      store.getProduct(prior.productId); db.exec('COMMIT'); return result(prior, true);
    }
    const productId = randomUUID(), title = snapshot.title || `妙手商品 ${snapshot.remoteId}`, sourceUrl = snapshot.sources.find(source => source.sourceItemUrl)?.sourceItemUrl ?? '';
    const facts = snapshot.attributes.map(attribute => ({ id: randomUUID(), ...normalizeSourceAttributeV1(attribute) }));
    const entries = facts.flatMap((fact, attributeIndex) => fact.ruleIds.length ? [{ factId: fact.id, attributeIndex, rawName: snapshot.attributes[attributeIndex].name,
      rawValue: snapshot.attributes[attributeIndex].value, name: fact.name, value: fact.value, ruleIds: fact.ruleIds }] : []);
    const receipt = validateMiaoshouReceipt({ id: randomUUID(), productId, fingerprint: contentFingerprint, accountScope, mode, receivedAt, snapshot, mapping,
      skuMappings: snapshot.skus.map(s => ({ sourceKey: s.key, localVariantId: randomUUID(), imageIds: selectedImageIds(snapshot, mapping, s.key) })),
      ...(entries.length ? { factNormalizations: { version: 'source-attribute-normalization/v1', entries } } : {}) });
    const receiptJson = JSON.stringify(receipt);
    // Expanded per-SKU image references must still fit the encrypted backup record limit.
    if (Buffer.byteLength(receiptJson, 'utf8') > 4 * 1024 * 1024) return fail('TOO_LARGE');
    // The service checks credentials after conversion, before any business write.
    // Duplicate history returns above; the guard must not rewrite snapshots or traces.
    assertNewImport?.({ facts, receipt });
    db.prepare('INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?)').run(productId, title, sourceUrl, snapshot.description, 'draft', mode === 'demo' ? 'sample' : 'import', 1, receivedAt, receivedAt);
    db.prepare('INSERT INTO product_workspaces(product_id,lane,updated_at) VALUES (?,?,?)').run(productId, 'inbox', receivedAt);
    const insertSku = db.prepare('INSERT INTO variants VALUES (?,?,?,?,?,?,?,?,?,?)');
    snapshot.skus.forEach((sku, index) => {
      const id = receipt.skuMappings[index].localVariantId, spec = originalSpec(snapshot, mapping, sku.key);
      const price = mapping.priceField !== 'none' && mapping.currency === 'CNY' ? localPrice(sku[mapping.priceField]) : '';
      insertSku.run(id, productId, `MS-${id.replaceAll('-', '').toUpperCase()}`, spec, '', price, null, spec, price, index);
    });
    const sourceRef = sourceUrl && sourceUrl.length <= 2000 ? sourceUrl : `妙手公共采集箱:${snapshot.remoteId}`;
    const insertFact = db.prepare('INSERT INTO facts VALUES (?,?,?,?,?,?,?,?)');
    facts.forEach((fact, index) => insertFact.run(fact.id, productId, fact.name, fact.value, 'import', sourceRef, 'source_confirmed', index));
    db.prepare('INSERT INTO miaoshou_receipts(id,record_json) VALUES (?,?)').run(receipt.id, receiptJson);
    db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?,?)').run(randomUUID(), productId, 'miaoshou.imported', `从妙手${mode === 'demo' ? '演示采集箱' : '公共采集箱'}导入「${title}」`, JSON.stringify({ receiptId: receipt.id, mode, remoteId: snapshot.remoteId, skuCount: snapshot.skus.length }), receivedAt);
    db.exec('COMMIT'); return result(receipt, false);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Preserve the original controlled failure. */ }
    if (error instanceof MiaoshouError) throw error; return fail('STORAGE');
  }
}
