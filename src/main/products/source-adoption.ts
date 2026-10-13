import { writeProductFactModel } from './fact-models.ts';
import type { DatabaseSync } from 'node:sqlite';
import { UserFacingError } from '../../shared/errors.ts';
import { readSourceSnapshot, saveSourceSnapshot } from '../miaoshou/source-snapshots.ts';
import type { SourceSnapshot } from '../miaoshou/source-snapshots.ts';
import { receiveSourceProduct } from './repository.ts';
import { transaction } from '../application/transaction.ts';
import { randomUUID } from 'node:crypto';
import { assertRecordTable } from '../storage/record-table.ts';

export interface SourceAdoption {version:1;id:string;identity:string;adoptedSnapshotId:string;latestSnapshotId:string;productRevision:number;frozen:boolean;scopeModelVersion?:1}
export function readSourceAdoption(db:DatabaseSync,productId:string):SourceAdoption|null {
  if(Number(db.prepare('PRAGMA user_version').get()!.user_version)<23)return null;
  const row=db.prepare('SELECT record_json FROM product_source_adoptions WHERE id=?').get(productId);if(!row)return null;
  const value=JSON.parse(String(row.record_json)) as SourceAdoption;
  if(value.version!==1||value.id!==productId||!Number.isSafeInteger(value.productRevision)||value.productRevision<1||typeof value.frozen!=='boolean'
    ||value.scopeModelVersion!==undefined&&value.scopeModelVersion!==1
    ||Object.keys(value).filter(key=>key!=='scopeModelVersion').sort().join()!=='adoptedSnapshotId,frozen,id,identity,latestSnapshotId,productRevision,version')throw new UserFacingError('商品来源采用记录无效');
  for(const id of [value.adoptedSnapshotId,value.latestSnapshotId]){const source=readSourceSnapshot(db,id);if(!source||source.receipt.productId!==productId||source.identity!==value.identity)throw new UserFacingError('商品来源采用版本不匹配');}
  return value;
}
function save(db:DatabaseSync,state:SourceAdoption):void{
  db.prepare('INSERT INTO product_source_adoptions(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(state.id,JSON.stringify(state));
}
export function adoptReceivedSource(db:DatabaseSync,source:SourceSnapshot,prior:SourceAdoption|null,legacy=false,appliedAt=source.receipt.receivedAt):SourceAdoption{
  const productId=source.receipt.productId,product=db.prepare('SELECT revision FROM products WHERE id=?').get(productId);
  if(!prior){
    const revision=product?1:receiveSourceProduct(db,source.receipt,null);
    const state:SourceAdoption={version:1,id:productId,identity:source.identity,adoptedSnapshotId:source.id,latestSnapshotId:source.id,productRevision:revision,frozen:legacy&&hasStarted(db,productId),...(!product?{scopeModelVersion:1 as const}:{})};
    save(db,state);return state;
  }
  if(prior.identity!==source.identity||!product)throw new UserFacingError('来源归属或主档已变化');
  const state={...prior,latestSnapshotId:source.id,frozen:prior.frozen||hasStarted(db,productId)};
  if(!state.frozen&&Number(product.revision)===prior.productRevision&&source.id!==prior.adoptedSnapshotId){
    state.productRevision=receiveSourceProduct(db,source.receipt,prior.productRevision,appliedAt);state.adoptedSnapshotId=source.id;state.scopeModelVersion=1;
  }
  save(db,state);return state;
}
function hasStarted(db:DatabaseSync,productId:string):boolean{
  return !!db.prepare('SELECT 1 FROM listing_drafts WHERE product_id=? LIMIT 1').get(productId)
    ||!!db.prepare('SELECT 1 FROM assets WHERE product_id=? LIMIT 1').get(productId)
    ||!!db.prepare("SELECT 1 FROM automatic_listing_tasks t,json_each(t.record_json,'$.items') i WHERE json_extract(i.value,'$.productId')=? LIMIT 1").get(productId);
}
function ensureSourceAdoption(db:DatabaseSync,productId:string):SourceAdoption|null{
  let prior=readSourceAdoption(db,productId);
  if(!prior){
    const receipts=db.prepare("SELECT record_json FROM miaoshou_receipts WHERE json_extract(record_json,'$.productId')=?").all(productId);
    if(receipts.length>1)throw new UserFacingError('来源回执归属不明确');
    if(receipts.length)prior=adoptReceivedSource(db,saveSourceSnapshot(db,JSON.parse(String(receipts[0].record_json))),null,true);
  }
  return prior;
}
export function freezeSourceForProduct(db:DatabaseSync,productId:string):void{
  const prior=ensureSourceAdoption(db,productId);
  if(prior&&!prior.frozen)save(db,{...prior,frozen:true});
}
/** First scope edit may precede any draft/task freeze. Join the caller's product-save transaction. */
export function enterFactScopeModel(db:DatabaseSync,productId:string):void{
  writeProductFactModel(db,productId);
  const prior=readSourceAdoption(db,productId);
  if(prior&&prior.scopeModelVersion!==1)save(db,{...prior,scopeModelVersion:1});
}

export function adoptedSourceReceipt(db:DatabaseSync,productId:string){
  const state=readSourceAdoption(db,productId);return state?readSourceSnapshot(db,state.adoptedSnapshotId)!.receipt:null;
}
export function previewSourceAdoption(db:DatabaseSync,productId:string){
  const state=readSourceAdoption(db,productId);if(!state)return null;
  const product=db.prepare('SELECT revision,title,description FROM products WHERE id=?').get(productId);
  if(!product)throw new UserFacingError('来源主档不存在');
  const candidate=readSourceSnapshot(db,state.latestSnapshotId)!;
  return{productId,expectedRevision:Number(product.revision),snapshotId:candidate.id,source:candidate.receipt.snapshot,
    pending:state.latestSnapshotId!==state.adoptedSnapshotId,frozen:state.frozen||hasStarted(db,productId),
    requiresManualConfirmation:Number(product.revision)!==state.productRevision,
    current:{title:String(product.title),description:String(product.description)}};
}
/** Explicit replacement command, after preview. Never adopts into already processed drafts/tasks. */
export function adoptSource(db:DatabaseSync,input:{productId:string;expectedRevision:number;snapshotId:string;confirmReplaceManual:boolean}):SourceAdoption{
  return transaction(db,()=>{
    const preview=previewSourceAdoption(db,input.productId),state=readSourceAdoption(db,input.productId);
    if(!preview||!state||preview.expectedRevision!==input.expectedRevision||preview.snapshotId!==input.snapshotId)throw new UserFacingError('商品或来源版本已变化，请重新查看差异');
    if(preview.frozen)throw new UserFacingError('商品已有处理成果或任务，当前版本已冻结；原草稿和任务保持不变');
    if(preview.requiresManualConfirmation&&!input.confirmReplaceManual)throw new UserFacingError('存在人工修改，必须明确确认替换后才能采用来源版本');
    if(!preview.pending)return state;
    const source=readSourceSnapshot(db,input.snapshotId)!;
    const before={product:db.prepare('SELECT * FROM products WHERE id=?').get(input.productId),variants:db.prepare('SELECT * FROM variants WHERE product_id=?').all(input.productId),facts:db.prepare('SELECT * FROM facts WHERE product_id=?').all(input.productId)};
    const next={...state,scopeModelVersion:1 as const,adoptedSnapshotId:source.id,productRevision:receiveSourceProduct(db,source.receipt,input.expectedRevision,new Date().toISOString())};
    save(db,next);
    db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?)').run(randomUUID(),input.productId,'product.source-adopted','明确采用来源版本；原人工资料保留于审计',JSON.stringify({before,snapshotId:source.id}),new Date().toISOString());
    return next;
  });
}
function assertFactScopeRecord(db:DatabaseSync,row:Record<string,unknown>):void{
  const r=JSON.parse(String(row.record_json));
  const fact=db.prepare('SELECT product_id FROM facts WHERE id=?').get(r.id);
  const v1=r.version===1&&Object.keys(r).sort().join()==='id,productId,scope,source,sourceReceiptId,version'&&r.scope==='unknown'&&r.source==='source';
  const keys=['version','id','productId','scope','variantId','source','productRevision','confirmedAt','sourceReceiptId'];
  const v2=r.version===2&&Object.keys(r).every(k=>keys.includes(k))&&r.source==='manual'&&['common','variant','unknown'].includes(r.scope)&&Number.isSafeInteger(r.productRevision)&&r.productRevision>0&&typeof r.confirmedAt==='string'&&Number.isFinite(Date.parse(r.confirmedAt))
    &&(r.scope==='variant'?typeof r.variantId==='string'&&!!db.prepare('SELECT 1 FROM variants WHERE id=? AND product_id=?').get(r.variantId,r.productId):r.variantId===undefined);
  const product=db.prepare('SELECT revision FROM products WHERE id=?').get(r.productId);
  if((!v1&&!v2)||r.id!==row.id||fact&&fact.product_id!==r.productId||v2&&(!fact||!product||r.productRevision>Number(product.revision))||r.sourceReceiptId!==undefined&&typeof r.sourceReceiptId!=='string')throw new UserFacingError('来源属性范围记录无效');
}

export function assertSourceAdoptionHistory(db:DatabaseSync):void{
  if(Number(db.prepare('PRAGMA user_version').get()!.user_version)<23)return;
  for(const table of ['source_snapshots','product_source_adoptions','product_fact_scopes'])assertRecordTable(db,table);
  for(const row of db.prepare('SELECT id FROM source_snapshots').iterate())readSourceSnapshot(db,String(row.id));
  for(const row of db.prepare('SELECT id FROM product_source_adoptions').iterate()){
    const id=String(row.id);readSourceAdoption(db,id);
    if(!db.prepare('SELECT 1 FROM products WHERE id=?').get(id))throw new UserFacingError('来源采用主档缺失');
  }
  for(const row of db.prepare('SELECT id,record_json FROM product_fact_scopes').iterate()){
    assertFactScopeRecord(db,row);
  }
}
