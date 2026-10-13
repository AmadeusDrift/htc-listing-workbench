import type { MiaoshouReceipt } from '../../shared/miaoshou-contracts.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { Fact, ProductDetail, SaveProductInput } from '../../shared/contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { assertOwner } from '../storage/owners.ts';

export function readFactScope(db:DatabaseSync,id:string):Pick<Fact,'scope'|'variantId'>{
  const row=db.prepare('SELECT record_json FROM product_fact_scopes WHERE id=?').get(id);
  if(!row)return {};
  const value=JSON.parse(String(row.record_json));
  return {scope:value.scope,...(value.scope==='variant'?{variantId:value.variantId}:{})};
}
/** Product-owned write port. Called within the product save transaction after its revision CAS. */
export function saveFactScopes(db:DatabaseSync,previous:ProductDetail,input:SaveProductInput):void{
  assertOwner('product','product_fact_scopes');
  const revision=db.prepare('SELECT revision FROM products WHERE id=?').get(input.id);
  if(Number(revision?.revision)!==input.revision)throw new UserFacingError('商品版本已变化，范围未保存');
  const ids=new Set(input.variants.map(v=>v.id));
  for(const fact of input.facts){
    const old=previous.facts.find(f=>f.id===fact.id);
    if(fact.scope==='variant'&&(!fact.variantId||!ids.has(fact.variantId)))throw new UserFacingError('事实范围的 SKU 不属于当前商品或已移除');
    // Old clients may omit scope; retain the saved binding rather than silently deleting it.
    if(fact.scope===undefined)continue;
    if(old?.scope===fact.scope&&old?.variantId===fact.variantId)continue;
    const prior=db.prepare('SELECT record_json FROM product_fact_scopes WHERE id=?').get(fact.id);
    const sourceReceiptId=prior?JSON.parse(String(prior.record_json)).sourceReceiptId:undefined;
    const record={version:2,id:fact.id,productId:input.id,scope:fact.scope,...(fact.scope==='variant'?{variantId:fact.variantId}:{}),source:'manual',productRevision:input.revision+1,confirmedAt:new Date().toISOString(),...(sourceReceiptId?{sourceReceiptId}:{})};
    db.prepare('INSERT INTO product_fact_scopes(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(fact.id,JSON.stringify(record));
  }
  if([...previous.facts,...input.facts].some(f=>f.scope!==undefined))db.prepare("UPDATE product_source_adoptions SET record_json=json_set(record_json,'$.scopeModelVersion',1) WHERE id=?").run(input.id);
  for(const old of previous.facts)if(!input.facts.some(f=>f.id===old.id))db.prepare('DELETE FROM product_fact_scopes WHERE id=?').run(old.id);
  for(const fact of input.facts){const scope=readFactScope(db,fact.id);if(scope.scope==='variant'&&!ids.has(scope.variantId!))throw new UserFacingError('请先调整已移除 SKU 的事实范围');}
}
export function assertFactScopeRecord(db:DatabaseSync,row:Record<string,unknown>):void{
  const r=JSON.parse(String(row.record_json));
  const fact=db.prepare('SELECT product_id FROM facts WHERE id=?').get(r.id);
  const v1=r.version===1&&Object.keys(r).sort().join()==='id,productId,scope,source,sourceReceiptId,version'&&r.scope==='unknown'&&r.source==='source';
  const keys=['version','id','productId','scope','variantId','source','productRevision','confirmedAt','sourceReceiptId'];
  const v2=r.version===2&&Object.keys(r).every(k=>keys.includes(k))&&r.source==='manual'&&['common','variant','unknown'].includes(r.scope)&&Number.isSafeInteger(r.productRevision)&&r.productRevision>0&&typeof r.confirmedAt==='string'&&Number.isFinite(Date.parse(r.confirmedAt))
    &&(r.scope==='variant'?typeof r.variantId==='string'&&!!db.prepare('SELECT 1 FROM variants WHERE id=? AND product_id=?').get(r.variantId,r.productId):r.variantId===undefined);
  const product=db.prepare('SELECT revision FROM products WHERE id=?').get(r.productId);
  if((!v1&&!v2)||r.id!==row.id||fact&&fact.product_id!==r.productId||v2&&(!fact||!product||r.productRevision>Number(product.revision))||r.sourceReceiptId!==undefined&&typeof r.sourceReceiptId!=='string')throw new UserFacingError('来源属性范围记录无效');
}

/** Scope the aggregate measurement input without modifying the immutable supplier receipt.
 * A source with explicit fact scopes has unbound prose. Only scoped current facts may be
 * broadcast; native SKU dimensions and selected specification remain SKU-owned.
 */
export function sourceMeasurementSnapshot(db:DatabaseSync,receipt:MiaoshouReceipt,variantId:string):MiaoshouReceipt['snapshot']{
  // Freezing a legacy source adds adoption metadata without changing its facts.
  // Only actual model entry or active scopes changes applicability; an empty new
  // source still has the model marker and cannot broadcast its unbound prose.
  const adoption=db.prepare('SELECT record_json FROM product_source_adoptions WHERE id=?').get(receipt.productId);
  const explicitModel=adoption&&JSON.parse(String(adoption.record_json)).scopeModelVersion===1;
  if(!explicitModel&&!db.prepare('SELECT 1 FROM facts f JOIN product_fact_scopes s ON s.id=f.id WHERE f.product_id=? LIMIT 1').get(receipt.productId))return receipt.snapshot;
  const attributes=db.prepare(`SELECT f.name,f.value,s.record_json FROM facts f JOIN product_fact_scopes s ON s.id=f.id
    WHERE f.product_id=? AND f.state IN ('source_confirmed','human_confirmed')`).all(receipt.productId).flatMap(row=>{
      const scope=JSON.parse(String(row.record_json));return scope.scope==='common'||scope.scope==='variant'&&scope.variantId===variantId?[{name:String(row.name),value:String(row.value)}]:[];
    });
  return {...receipt.snapshot,attributes,description:'',detailText:''};
}
