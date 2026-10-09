import { createHash } from 'node:crypto';
import type { ItemLabelRecord, ItemLabelFile } from '../../shared/item-label-contracts.ts';
import { ITEM_LABEL_STATUSES } from '../../shared/item-label-contracts.ts';
import { identifier, record, text } from '../../shared/validation.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { timestamp } from '../procurement/records.ts';
import { validateItemLabelFormat } from './adapter.ts';

export function itemLabelFingerprint(v: Pick<ItemLabelRecord,'jobId'|'batchId'|'lineId'|'draftId'|'productId'|'variantId'|'targetId'|'sellerId'|'marketplaceId'|'sku'|'mode'|'targetGeneration'|'quantity'|'format'>): string {
  return createHash('sha256').update(JSON.stringify([v.jobId,v.batchId,v.lineId,v.draftId,v.productId,v.variantId,v.targetId,v.sellerId,v.marketplaceId,v.sku,v.mode,v.targetGeneration,v.quantity,validateItemLabelFormat(v.format)])).digest('hex');
}
export function validateItemLabelRecord(raw: unknown): ItemLabelRecord {
  const v=record(raw,'商品标签记录',['id','jobId','batchId','lineId','draftId','productId','variantId','targetId','sellerId','marketplaceId','sku','mode','targetGeneration','quantity','format','fingerprint','version','current','status','paused','attempts','nextDueAt','createdAt','updatedAt','requestId','errorCode','message','files']);
  if(!['live','demo'].includes(String(v.mode)) || !ITEM_LABEL_STATUSES.includes(v.status as never) || typeof v.current!=='boolean' || typeof v.paused!=='boolean' || !Number.isSafeInteger(v.version) || Number(v.version)<1 || !Number.isSafeInteger(v.targetGeneration)||Number(v.targetGeneration)<0||!Number.isSafeInteger(v.attempts)||Number(v.attempts)<0||Number(v.attempts)>1000) throw new UserFacingError('商品标签记录状态无效');
  if(v.quantity!==null&&(!Number.isSafeInteger(v.quantity)||Number(v.quantity)<0||Number(v.quantity)>1000000))throw new UserFacingError('商品标签记录数量无效');
  const id=identifier(v.id);
  if(!Array.isArray(v.files)||v.files.length>100)throw new UserFacingError('商品标签文件集合无效');
  const files: ItemLabelFile[]=v.files.map((raw,index)=>{
    const f=record(raw,'商品标签文件',['relativePath','sha256','byteSize','index']);
    if(f.index!==index+1 || f.relativePath!==`documents/item-labels/${id}/${index+1}.pdf` || typeof f.sha256!=='string'||!/^[a-f0-9]{64}$/.test(f.sha256)||!Number.isSafeInteger(f.byteSize)||Number(f.byteSize)<64||Number(f.byteSize)>32*1024*1024)throw new UserFacingError('商品标签文件引用无效');
    return {relativePath:f.relativePath as string,sha256:f.sha256,byteSize:Number(f.byteSize),index:index+1};
  });
  const result:ItemLabelRecord={id,jobId:v.jobId===null?null:identifier(v.jobId),batchId:identifier(v.batchId),lineId:identifier(v.lineId),draftId:identifier(v.draftId),productId:identifier(v.productId),variantId:identifier(v.variantId),targetId:text(v.targetId,'店铺',100,true),sellerId:text(v.sellerId,'卖家',100,true),marketplaceId:text(v.marketplaceId,'站点',20,true),sku:text(v.sku,'SKU',255,true),mode:v.mode as ItemLabelRecord['mode'],targetGeneration:Number(v.targetGeneration),quantity:v.quantity as number|null,format:validateItemLabelFormat(v.format),fingerprint:text(v.fingerprint,'标签指纹',64,true),version:Number(v.version),current:v.current,status:v.status as ItemLabelRecord['status'],paused:v.paused,attempts:Number(v.attempts),nextDueAt:v.nextDueAt===null?null:timestamp(v.nextDueAt),createdAt:timestamp(v.createdAt),updatedAt:timestamp(v.updatedAt),requestId:v.requestId===null?null:text(v.requestId,'请求标识',160,true),errorCode:v.errorCode===null?null:text(v.errorCode,'错误类型',100,true),message:text(v.message,'标签状态说明',1200),files};
  if(result.fingerprint!==itemLabelFingerprint(result))throw new UserFacingError('商品标签绑定指纹无效');
  if(result.status==='READY'&&(!result.files.length||!result.current||result.quantity===null||result.quantity<1||result.quantity>10000))throw new UserFacingError('已就绪标签缺少完整文件或当前绑定');
  if(!result.current&&result.status!=='STALE')throw new UserFacingError('旧版本标签状态无效');
  if(result.status==='QUEUED'&&result.nextDueAt===null)throw new UserFacingError('标签队列缺少时间');
  return result;
}
