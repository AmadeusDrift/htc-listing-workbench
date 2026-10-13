import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBatch,readItem,writeBatch,writeItem,assertBatchHistory,invalid,terminal } from './records.ts';
import { batchFingerprint as listingFingerprint } from './records.ts';
import { providerReceiptFiles } from '../receipts.ts';
import type { BatchRecord,BatchItem } from '../../../shared/ai-batch-contracts.ts';

const has=(db:DatabaseSync,table:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
function batchIdentity(b:BatchRecord){return {id:b.id,taskId:b.taskId,phase:b.phase,fingerprint:b.fingerprint,credentialScope:b.credentialScope,purpose:b.purpose,model:b.model,schemaFingerprint:b.schemaFingerprint,itemIds:b.itemIds,createdAt:b.createdAt};}
function itemIdentity(i:BatchItem){const {state,receiptId,resultFingerprint,reportedCostUsd,adoption,...identity}=i;return identity;}
/** A restored intent cannot reacquire permission to send or adopt automatically. */
export function pauseBatchHistory(db:DatabaseSync){
  if(!has(db,'ai_batches'))return;
  for(const row of db.prepare('SELECT id FROM ai_batches').all()){
    const value=readBatch(db,String(row.id));writeBatch(db,{...value,locallyStopped:true,state:value.state==='submitting'?'submission_unknown':value.state});
  }
}
/** Same transaction as restore safety history. No new remote actions or domain results. */
export function retainBatchHistory(current:DatabaseSync,snapshot:DatabaseSync){
  if(!has(current,'ai_batches')){pauseBatchHistory(snapshot);return;}
  assertBatchHistory(current);assertBatchHistory(snapshot);
  for(const row of current.prepare('SELECT id FROM ai_batches').all()){
    const value=readBatch(current,String(row.id)),oldRow=snapshot.prepare('SELECT id FROM ai_batches WHERE id=?').get(value.id),old=oldRow?readBatch(snapshot,value.id):null;
    if(old&&listingFingerprint(batchIdentity(old))!==listingFingerprint(batchIdentity(value)))invalid('恢复Batch身份冲突，未修改当前工作区');
    if(old?.remoteBatchId&&value.remoteBatchId&&old.remoteBatchId!==value.remoteBatchId)invalid('恢复Batch远端身份冲突');
    if(old&&terminal(old.remoteStatus)&&terminal(value.remoteStatus)&&old.remoteStatus!==value.remoteStatus)invalid('恢复Batch终态冲突');
    const latest=old&&terminal(old.remoteStatus)&&!terminal(value.remoteStatus)?old:value;
    writeBatch(snapshot,{...latest,remoteBatchId:old?.remoteBatchId??value.remoteBatchId,remoteStatus:latest.remoteStatus??old?.remoteStatus??value.remoteStatus,
      submittedAt:old?.submittedAt??value.submittedAt,receiptIds:[...new Set([...(old?.receiptIds??[]),...value.receiptIds])],reportedCostUsd:latest.reportedCostUsd??old?.reportedCostUsd??value.reportedCostUsd,
      state:latest.state==='prepared'&&(old?.submittedAt||value.submittedAt)?'submission_unknown':latest.state,locallyStopped:true});
    for(const id of value.itemIds){
      const item=readItem(current,id),oldItem=old?readItem(snapshot,id):null;
      if(oldItem&&listingFingerprint(itemIdentity(oldItem))!==listingFingerprint(itemIdentity(item)))invalid('恢复Batch项目身份冲突');
      if(oldItem?.resultFingerprint&&item.resultFingerprint&&oldItem.resultFingerprint!==item.resultFingerprint)invalid('恢复Batch项目结果冲突');
      if(oldItem?.adoption&&item.adoption&&listingFingerprint(oldItem.adoption)!==listingFingerprint(item.adoption))invalid('恢复Batch采用身份冲突');
      const chosen=oldItem?.resultFingerprint&&!item.resultFingerprint?oldItem:item;
      writeItem(snapshot,{...chosen,state:chosen.state==='prepared'&&(old?.submittedAt||value.submittedAt)?'waiting':chosen.state,adoption:oldItem?.adoption??item.adoption});
    }
  }
  pauseBatchHistory(snapshot);assertBatchHistory(snapshot);
}
/** Keep original raw receipts and image send intents when restoring an older snapshot. */
export function retainProviderReceipts(current:DatabaseSync,snapshot:DatabaseSync,currentDirectory:string,snapshotDirectory:string){
  if(!has(current,'ai_provider_receipts'))return;
  for(const receipt of providerReceiptFiles(current,currentDirectory)){
    const old=snapshot.prepare('SELECT record_json FROM ai_provider_receipts WHERE id=?').get(receipt.id);
    if(old&&listingFingerprint(JSON.parse(String(old.record_json)))!==listingFingerprint(receipt))invalid('恢复AI收据身份冲突');
    const source=join(currentDirectory,receipt.relativePath),target=join(snapshotDirectory,receipt.relativePath),folder=lstatSync(join(currentDirectory,'ai-receipts')),stat=lstatSync(source);
    if(!folder.isDirectory()||folder.isSymbolicLink()||!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size!==receipt.byteSize)invalid('原AI收据文件身份无效');
    const bytes=readFileSync(source);if(createHash('sha256').update(bytes).digest('hex')!==receipt.sha256)invalid('原AI收据校验失败');
    const targetDirectory=join(snapshotDirectory,'ai-receipts');mkdirSync(targetDirectory,{recursive:true});const targetStat=lstatSync(targetDirectory);if(!targetStat.isDirectory()||targetStat.isSymbolicLink())invalid('恢复收据目录无效');
    if(existsSync(target)){const s=lstatSync(target);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size!==receipt.byteSize||createHash('sha256').update(readFileSync(target)).digest('hex')!==receipt.sha256)invalid('恢复收据文件冲突');}
    else writeFileSync(target,bytes,{flag:'wx'});
    snapshot.prepare('INSERT OR IGNORE INTO ai_provider_receipts VALUES(?,?)').run(receipt.id,JSON.stringify(receipt));
  }
  for(const row of current.prepare('SELECT id,record_json FROM ai_image_requests').all()){
    const old=snapshot.prepare('SELECT record_json FROM ai_image_requests WHERE id=?').get(row.id);
    if(old&&listingFingerprint(JSON.parse(String(old.record_json)))!==listingFingerprint(JSON.parse(String(row.record_json))))invalid('恢复图像发送意图冲突');
    snapshot.prepare('INSERT OR IGNORE INTO ai_image_requests VALUES(?,?)').run(row.id,row.record_json);
  }
}
