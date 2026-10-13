import type { DatabaseSync } from 'node:sqlite';
import { UserFacingError } from '../../shared/errors.ts';
import { assertOwner } from '../storage/owners.ts';
import { assertRecordTable } from '../storage/record-table.ts';
export const PRODUCT_FACT_MODEL_TABLES={product_fact_models:['id','record_json']};
/** Read-only compatibility: never backfill a legacy product or rewrite an old fingerprint. */
export function readProductFactModel(db:DatabaseSync,productId:string):1|undefined{
  const version=Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if(version>=30){
    const row=db.prepare('SELECT id,record_json FROM product_fact_models WHERE id=?').get(productId);
    if(row){assertModelRecord(db,row);return 1;}
  }
  if(version<23)return undefined;
  const adoption=db.prepare('SELECT record_json FROM product_source_adoptions WHERE id=?').get(productId);
  if(adoption){
    const model=JSON.parse(String(adoption.record_json)).scopeModelVersion;
    if(model!==undefined&&model!==1)throw new UserFacingError('事实模型版本无效');
    if(model===1)return 1;
  }
  return db.prepare('SELECT 1 FROM facts f JOIN product_fact_scopes s ON s.id=f.id WHERE f.product_id=? LIMIT 1').get(productId)?1:undefined;
}
/** Caller owns the product revision/CAS transaction. No fact deletion clears this marker. */
export function writeProductFactModel(db:DatabaseSync,productId:string):void{
  assertOwner('product','product_fact_models');
  if(!db.prepare('SELECT 1 FROM products WHERE id=?').get(productId))throw new UserFacingError('事实模型主档不存在');
  db.prepare('INSERT INTO product_fact_models(id,record_json) VALUES(?,?) ON CONFLICT(id) DO NOTHING').run(productId,JSON.stringify({version:1,id:productId,productId,scopeModelVersion:1}));
}
export function assertProductFactModels(db:DatabaseSync):void{
  if(Number(db.prepare('PRAGMA user_version').get()!.user_version)<30)return;
  assertRecordTable(db,'product_fact_models');
  const foreignKeys=db.prepare('PRAGMA foreign_key_list(product_fact_models)').all();
  if(foreignKeys.length!==1||foreignKeys[0].table!=='products'||foreignKeys[0].from!=='id'||foreignKeys[0].to!=='id'||foreignKeys[0].on_delete!=='CASCADE')throw new UserFacingError('事实模型主档关联结构无效');
  for(const row of db.prepare('SELECT id,record_json FROM product_fact_models').iterate()){
    assertModelRecord(db,row);
  }
}

function assertModelRecord(db:DatabaseSync,row:Record<string,unknown>):void{
    const r=JSON.parse(String(row.record_json));
    if(!r||Object.keys(r).sort().join()!=='id,productId,scopeModelVersion,version'||r.version!==1||r.scopeModelVersion!==1||r.id!==row.id||r.productId!==r.id||!db.prepare('SELECT 1 FROM products WHERE id=?').get(r.id))throw new UserFacingError('事实模型记录无效');
}
