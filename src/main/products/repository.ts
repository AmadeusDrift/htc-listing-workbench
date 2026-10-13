import { writeProductFactModel } from './fact-models.ts';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { MiaoshouReceipt } from '../../shared/miaoshou-contracts.ts';
import { localPrice } from '../miaoshou/validation.ts';
import { normalizeSourceAttributeV1 } from '../miaoshou/source-attribute-normalization-v1.ts';
import { assertOwner } from '../storage/owners.ts';
import { UserFacingError } from '../../shared/errors.ts';

function specification(receipt:MiaoshouReceipt,key:string):string{
  const selected=receipt.mapping.skus.find(s=>s.sourceKey===key)!;
  const names=receipt.snapshot.dimensions.flatMap(d=>{const value=d.values.find(v=>v.id===selected.dimensions[d.id]);return value?[`${d.name}: ${value.name}`]:[];});
  if(!names.length)return `来源 SKU ${key}（规格待核对）`;
  return names.join(' / ')+(receipt.snapshot.dimensions.some(d=>d.values.length&&!selected.dimensions[d.id])?'（部分规格待核对）':'');
}
/** M02 is the sole writer for a received master. Caller supplies its shared transaction. */
export function receiveSourceProduct(db:DatabaseSync,receipt:MiaoshouReceipt,expectedRevision:number|null,appliedAt=receipt.receivedAt):number{
  assertOwner('product','products');
  const {snapshot,productId,mode}=receipt,title=snapshot.title||`妙手商品 ${snapshot.remoteId}`,receivedAt=appliedAt;
  const sourceUrl=snapshot.sources.find(s=>s.sourceItemUrl)?.sourceItemUrl??'';
  const oldSkus=new Map(db.prepare('SELECT id,sku FROM variants WHERE product_id=?').all(productId).map(r=>[String(r.id),String(r.sku)]));
  if(expectedRevision===null){
    db.prepare('INSERT INTO products VALUES(?,?,?,?,?,?,?,?,?)').run(productId,title,sourceUrl,snapshot.description,'draft',mode==='demo'?'sample':'import',1,receivedAt,receivedAt);
    db.prepare('INSERT INTO product_workspaces(product_id,lane,updated_at) VALUES(?,?,?)').run(productId,'inbox',receivedAt);
  }else{
    const changed=db.prepare('UPDATE products SET title=?,source_url=?,description=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(title,sourceUrl,snapshot.description,receivedAt,productId,expectedRevision);
    if(changed.changes!==1)throw new UserFacingError('商品版本已变化，未采用来源更新');
    const kept=new Set(receipt.skuMappings.map(m=>m.localVariantId));
    for(const id of oldSkus.keys())if(!kept.has(id))db.prepare('DELETE FROM variants WHERE id=? AND product_id=?').run(id,productId);
    db.prepare('DELETE FROM facts WHERE product_id=?').run(productId);
    db.prepare('DELETE FROM product_fact_scopes WHERE json_extract(record_json,\'$.productId\')=?').run(productId);
  }
  writeProductFactModel(db,productId);
  snapshot.skus.forEach((sku,index)=>{
    const id=receipt.skuMappings[index].localVariantId,spec=specification(receipt,sku.key),price=receipt.mapping.priceField!=='none'&&receipt.mapping.currency==='CNY'?localPrice(sku[receipt.mapping.priceField]):'';
    if(oldSkus.has(id))db.prepare('UPDATE variants SET original_spec=?,source_spec=?,purchase_price=?,source_purchase_price=?,position=? WHERE id=? AND product_id=?').run(spec,spec,price,price,index,id,productId);
    else db.prepare('INSERT INTO variants VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,productId,`MS-${id.replaceAll('-','').toUpperCase()}`,spec,'',price,null,spec,price,index);
  });
  const sourceRef=sourceUrl&&sourceUrl.length<=2000?sourceUrl:`妙手公共采集箱:${snapshot.remoteId}`;
  snapshot.attributes.forEach((attribute,index)=>{
    const normalized=normalizeSourceAttributeV1(attribute),entry=receipt.factNormalizations?.entries.find(e=>e.attributeIndex===index),id=entry?.factId??randomUUID();
    db.prepare('INSERT INTO facts VALUES(?,?,?,?,?,?,?,?)').run(id,productId,normalized.name,normalized.value,'import',sourceRef,'source_confirmed',index);
    // Unbound product-level attributes cannot be silently upgraded to a variant fact.
    db.prepare('INSERT INTO product_fact_scopes(id,record_json) VALUES(?,?)').run(id,JSON.stringify({version:1,id,productId,scope:'unknown',source:'source',sourceReceiptId:receipt.id}));
  });
  return expectedRevision===null?1:expectedRevision+1;
}
