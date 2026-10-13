import { transaction } from '../application/transaction.ts';
import { sourceIdentity, saveSourceSnapshot, readSourceSnapshot } from './source-snapshots.ts';
import { readSourceAdoption, adoptReceivedSource, adoptedSourceReceipt } from '../products/source-adoption.ts';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { MiaoshouImportResult, MiaoshouMapping, MiaoshouProduct, MiaoshouReceipt } from '../../shared/miaoshou-contracts.ts';
import type { WorkspaceStore } from '../store.ts';
import { assertUnambiguousRecordJson } from '../record-json.ts';
import { fail, fingerprint, importWarnings, MiaoshouError, selectedImageIds, uuid, validateMiaoshouReceipt } from './validation.ts';
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
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='source_snapshots' AND type='table'").get())for(const row of db.prepare('SELECT id FROM source_snapshots').iterate()){
    const source=readSourceSnapshot(db,String(row.id));if(!source)return fail('STORAGE');assertMiaoshouFactHistory(db,source.receipt);
  }
}
export function getReceipt(db: DatabaseSync, rawProductId: unknown): MiaoshouReceipt | null {
  const productId = uuid(rawProductId);
  const adopted=adoptedSourceReceipt(db,productId);if(adopted)assertMiaoshouFactHistory(db,adopted);
  try {
    const rows = db.prepare("SELECT id,record_json FROM miaoshou_receipts WHERE json_extract(record_json,'$.productId')=?").all(productId);
    if (!rows.length) return adopted; if (rows.length !== 1) return fail('STORAGE');
    const receipt = validateMiaoshouReceipt(JSON.parse(String(rows[0].record_json)));
    if (rows[0].id !== receipt.id || receipt.productId !== productId) return fail('STORAGE');
    assertMiaoshouFactHistory(db, receipt);
    return adopted??receipt;
  } catch (error) { if (error instanceof MiaoshouError) throw error; return fail('STORAGE'); }
}
function result(receipt: MiaoshouReceipt, duplicate: boolean): MiaoshouImportResult {
  return { productId: receipt.productId, duplicate, warnings: importWarnings(receipt.snapshot, receipt.mapping), skuCount: receipt.snapshot.skus.length, imageCount: receipt.snapshot.images.length };
}
/** M01 persists immutable source; M02 owns the master writes in the same local transaction. */
export function persistImport(db:DatabaseSync,_store:WorkspaceStore,snapshot:MiaoshouProduct,mapping:MiaoshouMapping,
  accountScope:string,mode:'demo'|'live',receivedAt:string,assertNewImport?:(value:unknown)=>void):MiaoshouImportResult {
  try{return transaction(db,()=>{
    const contentFingerprint=fingerprint(snapshot,mapping,accountScope,mode),identity=sourceIdentity(snapshot,accountScope,mode);
    const originals=db.prepare("SELECT record_json FROM miaoshou_receipts WHERE json_extract(record_json,'$.accountScope')=? AND json_extract(record_json,'$.mode')=?").all(accountScope,mode)
      .map(row=>validateMiaoshouReceipt(JSON.parse(String(row.record_json)))).filter(receipt=>sourceIdentity(receipt.snapshot,accountScope,mode)===identity);
    if(originals.length>1)return fail('STORAGE');
    const original=originals[0],productId=original?.productId??randomUUID();
    if(original){assertMiaoshouFactHistory(db,original);const adopted=adoptedSourceReceipt(db,productId);if(adopted)assertMiaoshouFactHistory(db,adopted);}
    let prior=original?readSourceAdoption(db,productId):null;
    if(original&&!prior){assertMiaoshouFactHistory(db,original);prior=adoptReceivedSource(db,saveSourceSnapshot(db,original),null,true);}
    const known=original?db.prepare("SELECT id FROM source_snapshots WHERE json_extract(record_json,'$.receipt.fingerprint')=?").get(contentFingerprint):null;
    if(known){adoptReceivedSource(db,readSourceSnapshot(db,String(known.id))!,prior,false,receivedAt);return result(adoptedSourceReceipt(db,productId)??original,true);}
    const previous=original?(adoptedSourceReceipt(db,productId)??original):null;
    const facts=snapshot.attributes.map(attribute=>({id:randomUUID(),...normalizeSourceAttributeV1(attribute)}));
    const entries=facts.flatMap((fact,index)=>fact.ruleIds.length?[{factId:fact.id,attributeIndex:index,rawName:snapshot.attributes[index].name,rawValue:snapshot.attributes[index].value,name:fact.name,value:fact.value,ruleIds:fact.ruleIds}]:[]);
    const receipt=validateMiaoshouReceipt({id:randomUUID(),productId,fingerprint:contentFingerprint,accountScope,mode,receivedAt,snapshot,mapping,
      skuMappings:snapshot.skus.map(s=>({sourceKey:s.key,localVariantId:previous?.skuMappings.find(m=>m.sourceKey===s.key)?.localVariantId??randomUUID(),imageIds:selectedImageIds(snapshot,mapping,s.key)})),
      ...(entries.length?{factNormalizations:{version:'source-attribute-normalization/v1',entries}}:{})});
    const json=JSON.stringify(receipt);if(Buffer.byteLength(json,'utf8')>4*1024*1024)return fail('TOO_LARGE');
    assertNewImport?.({facts,receipt});
    const source=saveSourceSnapshot(db,receipt),state=adoptReceivedSource(db,source,prior);
    if(!original)db.prepare('INSERT INTO miaoshou_receipts(id,record_json) VALUES(?,?)').run(receipt.id,json);
    db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?)').run(randomUUID(),productId,'miaoshou.imported',original?'已接收来源新版本；人工和已处理资料受保护':'从妙手接收商品',JSON.stringify({receiptId:receipt.id,sourceSnapshotId:source.id,adopted:state.adoptedSnapshotId===source.id,mode,remoteId:snapshot.remoteId,skuCount:snapshot.skus.length}),receivedAt);
    const output=result(receipt,!!original);
    if(state.adoptedSnapshotId!==source.id)output.warnings.push('来源新版本已保存，人工修改或已处理商品保持原版本；请核对后明确采用。');
    return output;
  });}catch(error){if(error instanceof MiaoshouError)throw error;return fail('STORAGE');}
}
