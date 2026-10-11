import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabase } from '../src/main/database.ts';
import { ProcurementService } from '../src/main/procurement/service.ts';
import type { AmazonDraft, AmazonTarget, JsonObject } from '../src/shared/amazon-contracts.ts';
import type { ProductDetail } from '../src/shared/contracts.ts';
import { AmazonTransportError } from '../src/main/amazon/transport.ts';

const implementation = await import('../src/main/item-labels/service.ts').catch(() => null);
export function pdfBytes(): Buffer {
  let body = '%PDF-1.4\n'; const offsets = [0];
  for (const [i,content] of ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 1 /Kids [3 0 R] >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>'].entries()) { offsets.push(Buffer.byteLength(body)); body += `${i+1} 0 obj\n${content}\nendobj\n`; }
  const start = Buffer.byteLength(body); body += `xref\n0 4\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(body);
}
function fixture(t: test.TestContext) {
  assert.ok(implementation?.ItemLabelService, 'persistent ItemLabelService must exist');
  const parent = resolve('.test-data'); mkdirSync(parent,{recursive:true}); const dir = mkdtempSync(join(parent,'item-labels-'));
  const productId = randomUUID(), variantId = randomUUID(), draftId = randomUUID(), targetId = randomUUID();
  const product = {id:productId,title:'Product',sourceUrl:'https://detail.1688.com/offer/123456.html',revision:1,origin:'import',assets:[],facts:[],variants:[{id:variantId,sku:'SKU-10-PACK',originalSpec:'10 per set',sourceSpec:'10 per set',normalizedSpec:'',purchasePrice:'2.50',sourcePurchasePrice:'2.50',inventory:999}]} as unknown as ProductDetail;
  const target = {id:targetId,name:'Store',mode:'live',sellerId:'seller',marketplaceId:'ATVPDKIKX0DER',region:'na',locale:'en_US',configured:true,paused:false} as AmazonTarget;
  const draft = {id:draftId,productId,variantId,sku:'SKU-10-PACK',targetId,targetName:'Store',sellerId:'seller',marketplaceId:target.marketplaceId,mode:'live',state:'PROCESSING',schema:{parentageLevel:'NONE'},submittedAt:'2026-10-07T00:00:00.000Z',checkedAt:'2026-10-07T00:30:00.000Z',listingIssues:[],updatedAt:'2026-10-07T00:30:00.000Z'} as unknown as AmazonDraft;
  const base = {listDrafts:()=>[draft],getDraft:()=>draft,getTarget:()=>target,getListingObservation:()=>({draftId,targetId,sellerId:'seller',marketplaceId:target.marketplaceId,sku:draft.sku,checkedAt:draft.checkedAt!,requestId:null,asin:'B012345678',fnsku:null,statuses:[],issues:[]})};
  const procurement = new ProcurementService(dir,{listProducts:()=>[{id:productId}],getProduct:()=>product},base);
  const db=openDatabase(dir); db.exec('CREATE TABLE IF NOT EXISTS item_labels(id TEXT PRIMARY KEY, record_json TEXT NOT NULL)'); db.close();
  let now=Date.parse('2026-10-08T00:00:00.000Z'); const requests: JsonObject[]=[];
  let make: () => Promise<{data:JsonObject;status:number;requestId:string|null}> = async()=>({data:{documentDownloads:[{downloadType:'URL',uri:'https://labels.amazon.com/one.pdf'},{downloadType:'URL',uri:'https://labels.amazon.com/two.pdf'}]},status:200,requestId:'request-1'});
  let download=async(_uri:string)=>pdfBytes();
  const amazon={executionTargetScope:()=>({target,generation:1}),createMarketplaceItemLabels:async(_id:string,body:JsonObject,guard?:()=>void)=>{guard?.();requests.push(body);return make();},downloadItemLabel:async(uri:string)=>download(uri)};
  let service=new implementation.ItemLabelService(dir,amazon,procurement,{now:()=>now,sleep:async()=>{}});
  t.after(async()=>{await service.close();procurement.close();});
  return {dir,product,draft,procurement,requests,amazon,get service(){return service;},advance:(ms:number)=>now+=ms,setCreate:(fn:typeof make)=>make=fn,setDownload:(fn:typeof download)=>download=fn,reopen:async()=>{await service.close();service=new implementation!.ItemLabelService(dir,amazon,procurement,{now:()=>now,sleep:async()=>{}});},
    batch:()=>procurement.ensureAutomaticBatch(randomUUID(),[draftId],{[draftId]:5})[0]};
}
function changeQuantity(f:ReturnType<typeof fixture>,batchId:string,stockQuantity:number|null){
  const batch=f.procurement.get(batchId);
  f.procurement.update({id:batch.id,revision:batch.revision,lines:batch.lines.map(({id,purchaseQuantity,purchasePrice,purchaseUnit,priceConfirmed})=>({id,purchaseQuantity,purchasePrice,purchaseUnit,priceConfirmed,stockQuantity})),shipmentConfirmationId:''});
  return f.service.syncBatch(batchId)[0];
}
test('automatic procurement is incremental and idempotent and preserves sales units', t=>{
  const f=fixture(t),job=randomUUID(); const [first]=f.procurement.ensureAutomaticBatch(job,[f.draft.id],{[f.draft.id]:5});
  const [again]=f.procurement.ensureAutomaticBatch(job,[f.draft.id],{[f.draft.id]:5});
  assert.equal(first.id,again.id); assert.equal(again.lines.length,1); assert.equal(again.lines[0].stockQuantity,5); assert.equal(again.lines[0].purchaseQuantity,null);
  f.draft.state='UNKNOWN'; assert.throws(()=>f.procurement.ensureAutomaticBatch(randomUUID(),[f.draft.id],{[f.draft.id]:5}));
});
test('all documents are persisted and checksum verified before READY, reopening does not request again',async t=>{
  const f=fixture(t),batch=f.batch(); const [queued]=f.service.syncBatch(batch.id); assert.equal(queued.status,'QUEUED');
  f.service.syncBatch(batch.id); await f.service.runDue(); assert.equal(f.requests.length,1); assert.equal((f.requests[0].mskuQuantities as {quantity:number}[])[0].quantity,5);
  const ready=f.service.get(queued.id); assert.equal(ready.status,'READY'); assert.equal(ready.files.length,2); assert.equal(f.procurement.get(batch.id).lines[0].labelStatus,'READY');
  assert.equal((await f.service.verifyFiles(ready.id)).files.length,2); await f.reopen(); f.service.syncBatch(batch.id); await f.service.runDue(); assert.equal(f.requests.length,1);
  writeFileSync(join(f.dir,ready.files[0].relativePath),Buffer.from('corrupted'));
  await assert.rejects(f.service.verifyFiles(ready.id)); assert.equal(f.service.get(ready.id).status,'FAILED');
});
test('late response stays stale after quantity changes, including cleared quantity',async t=>{
  const f=fixture(t),batch=f.batch(); const [old]=f.service.syncBatch(batch.id); let resolveRequest!: (v:{data:JsonObject;status:number;requestId:string})=>void;
  f.setCreate(()=>new Promise(resolve=>{resolveRequest=resolve;})); const running=f.service.runDue(); await new Promise(resolve=>setImmediate(resolve));
  const edit=f.procurement.get(batch.id); f.procurement.update({id:edit.id,revision:edit.revision,lines:edit.lines.map(line=>({...(({id,purchaseQuantity,purchasePrice,purchaseUnit,priceConfirmed})=>({id,purchaseQuantity,purchasePrice,purchaseUnit,priceConfirmed}))(line),stockQuantity:null})),shipmentConfirmationId:''});
  const [newest]=f.service.syncBatch(batch.id); assert.equal(newest.status,'WAITING_QUANTITY');
  resolveRequest({data:{documentDownloads:[{downloadType:'URL',uri:'https://labels.amazon.com/one.pdf'}]},status:200,requestId:'old'}); await running;
  assert.equal(f.service.get(old.id).status,'STALE'); assert.equal(f.service.get(newest.id).status,'WAITING_QUANTITY'); assert.equal(f.procurement.get(batch.id).lines[0].labelStatus,'WAITING_QUANTITY');
});
test('download errors and malformed PDFs never become READY or leak a signed URL',async t=>{
  const f=fixture(t),batch=f.batch(); f.setDownload(async()=>Buffer.from('<html>access denied</html>'));
  const [record]=f.service.syncBatch(batch.id); await f.service.runDue(); const failed=f.service.get(record.id);
  assert.equal(failed.status,'FAILED'); assert.equal(failed.files.length,0); assert.ok(!JSON.stringify(failed).includes('https://'));
});
test('retry counters survive restart and stop after finite attempts',async t=>{
  const f=fixture(t),batch=f.batch(); f.setCreate(async()=>{throw new AmazonTransportError('temporary',503,'retry-1');});
  const [record]=f.service.syncBatch(batch.id); for(let i=0;i<3;i++){await f.service.runDue(); await f.reopen(); f.advance(120000);}
  await f.service.runDue(); assert.equal(f.requests.length,3); assert.equal(f.service.get(record.id).status,'FAILED'); assert.equal(f.service.get(record.id).attempts,3);
  f.service.syncBatch(batch.id); await f.service.runDue(); assert.equal(f.requests.length,3);
});
test('pause and cancel prevent dispatch while an already sent label result is preserved',async t=>{
  const f=fixture(t),job=randomUUID(),[batch]=f.procurement.ensureAutomaticBatch(job,[f.draft.id],{[f.draft.id]:5});const [row]=f.service.syncBatch(batch.id,{jobId:job});
  f.service.pauseJob(job);await f.service.runDue();assert.equal(f.requests.length,0);await f.reopen();await f.service.runDue();assert.equal(f.requests.length,0);
  f.service.resumeJob(job);let release!:()=>void;f.setCreate(async()=>{await new Promise<void>(resolve=>{release=resolve;});return {data:{documentDownloads:[{downloadType:'URL',uri:'https://labels.amazon.com/a.pdf'}]},status:200,requestId:'finish-after-pause'};});
  const pending=f.service.runDue();await new Promise(resolve=>setImmediate(resolve));f.service.pauseJob(job);release();await pending;assert.equal(f.service.get(row.id).status,'READY');assert.equal(f.requests.length,1);
});
test('a cancelled queued record remains cancelled when a stale dispatch snapshot is drained',async t=>{
  const f=fixture(t),first=f.batch();f.service.syncBatch(first.id);const job=randomUUID(),[batch]=f.procurement.ensureAutomaticBatch(job,[f.draft.id],{[f.draft.id]:5});const [row]=f.service.syncBatch(batch.id,{jobId:job});
  let release!:()=>void;f.setCreate(async()=>{await new Promise<void>(resolve=>{release=resolve;});return {data:{documentDownloads:[{downloadType:'URL',uri:'https://labels.amazon.com/a.pdf'}]},status:200,requestId:'first'};});
  const running=f.service.runDue();await new Promise(resolve=>setImmediate(resolve));f.service.cancelJob(job);release();await running;assert.equal(f.service.get(row.id).status,'CANCELLED');assert.equal(f.requests.length,1);
});
test('batch file export requires one current complete label set for every row',async t=>{
  const f=fixture(t),batch=f.batch();f.service.syncBatch(batch.id);await f.service.runDue();assert.equal((await f.service.filesForBatch(batch.id)).length,2);
  const db=openDatabase(f.dir),updated=f.procurement.get(batch.id);updated.lines.push({...updated.lines[0],id:randomUUID(),draftId:randomUUID(),variantId:randomUUID(),sku:'SKU-TWO',labelStatus:'NOT_REQUESTED'});db.prepare('UPDATE procurement_batches SET record_json=? WHERE id=?').run(JSON.stringify(updated),batch.id);db.close();await assert.rejects(f.service.filesForBatch(batch.id));
});
test('changed target identity invalidates existing labels and creates an explicit context failure',async t=>{
  const f=fixture(t),batch=f.batch(),[old]=f.service.syncBatch(batch.id);await f.service.runDue();f.amazon.executionTargetScope().target.sellerId='NEW_SELLER';
  const [current]=f.service.syncBatch(batch.id);assert.equal(f.service.get(old.id).status,'STALE');assert.equal(current.status,'FAILED');assert.equal(current.errorCode,'TARGET_CONTEXT_CHANGED');await f.service.runDue();assert.equal(f.requests.length,1);
});
test('pause cannot turn an unknown sent request into an automatic replay, but explicit retry clears pause',async t=>{
  const f=fixture(t),job=randomUUID(),[batch]=f.procurement.ensureAutomaticBatch(job,[f.draft.id],{[f.draft.id]:5});const [row]=f.service.syncBatch(batch.id,{jobId:job});
  let fail!:(error:unknown)=>void;f.setCreate(()=>new Promise((_resolve,reject)=>{fail=reject;}));const running=f.service.runDue();await new Promise(resolve=>setImmediate(resolve));f.service.pauseJob(job);fail(new AmazonTransportError('unknown',null,null,true));await running;
  assert.equal(f.service.get(row.id).status,'FAILED');assert.equal(f.service.get(row.id).errorCode,'REQUEST_UNKNOWN');f.service.resumeJob(job);await f.service.runDue();assert.equal(f.requests.length,1);
  f.service.pauseJob(job);const retried=f.service.retry(row.id);assert.equal(retried.paused,false);assert.equal(retried.attempts,1);
});
test('verification refuses a label superseded while its files are being read',async t=>{
  const f=fixture(t),batch=f.batch(),[old]=f.service.syncBatch(batch.id);await f.service.runDue();
  const pending=f.service.verifyFiles(old.id);const newest=changeQuantity(f,batch.id,8);
  await assert.rejects(pending,/过期|变化/);
  assert.equal(f.service.get(old.id).current,false);assert.equal(f.service.get(newest.id).status,'QUEUED');
});
test('an integrity failure during verification never resurrects a superseded row',async t=>{
  const f=fixture(t),batch=f.batch(),[old]=f.service.syncBatch(batch.id);await f.service.runDue();
  writeFileSync(join(f.dir,f.service.get(old.id).files[0].relativePath),'broken');
  const pending=f.service.verifyFiles(old.id);const newest=changeQuantity(f,batch.id,null);await assert.rejects(pending);
  assert.equal(f.service.get(old.id).current,false);assert.equal(f.service.get(old.id).status,'STALE');
  assert.equal(f.service.list({batchId:batch.id}).filter(row=>row.current).length,1);
  assert.equal(f.service.get(newest.id).status,'WAITING_QUANTITY');assert.equal(f.procurement.get(batch.id).lines[0].labelStatus,'WAITING_QUANTITY');
});
test('batch export takes one coherent current snapshot after all file reads',async t=>{
  const f=fixture(t),batch=f.batch();f.service.syncBatch(batch.id);await f.service.runDue();
  const verify=f.service.verifyFiles.bind(f.service);f.service.verifyFiles=async id=>{const result=await verify(id);changeQuantity(f,batch.id,8);return result;};
  await assert.rejects(f.service.filesForBatch(batch.id),/过期|变化|未就绪/);
});
test('verified export bytes remain the checked bytes when the source file changes',async t=>{
  const f=fixture(t),batch=f.batch();f.service.syncBatch(batch.id);await f.service.runDue();
  const [file]=await f.service.filesForBatch(batch.id);writeFileSync(file.path,'replacement after verification');
  assert.deepEqual((file as typeof file&{bytes:Buffer}).bytes,pdfBytes());
});
test('export callers can synchronously recheck their final snapshot after writing files',async t=>{
  const f=fixture(t),batch=f.batch();f.service.syncBatch(batch.id);await f.service.runDue();const files=await f.service.filesForBatch(batch.id);
  const guard=(f.service as typeof f.service&{assertBatchSnapshot:(id:string,rows:typeof files[number]['record'][])=>void}).assertBatchSnapshot;
  assert.equal(typeof guard,'function');guard.call(f.service,batch.id,files.map(file=>file.record));changeQuantity(f,batch.id,8);
  assert.throws(()=>guard.call(f.service,batch.id,files.map(file=>file.record)),/变化|未就绪|过期/);
});
for(const failure of ['REQUEST_UNKNOWN','RETRY_EXHAUSTED'] as const)test(`credential rotation preserves ${failure} and its attempt budget until explicit retry`,async t=>{
  const f=fixture(t),batch=f.batch();f.setCreate(async()=>{throw new AmazonTransportError('failed',failure==='REQUEST_UNKNOWN'?null:503,null,failure==='REQUEST_UNKNOWN');});
  const [old]=f.service.syncBatch(batch.id);for(let i=0;i<(failure==='REQUEST_UNKNOWN'?1:3);i++){await f.service.runDue();f.advance(120000);}
  const attempts=f.service.get(old.id).attempts,count=f.requests.length,target=f.amazon.executionTargetScope().target;
  f.amazon.executionTargetScope=()=>({target,generation:2});const [rotated]=f.service.syncBatch(batch.id);await f.service.runDue();
  assert.equal(rotated.status,'FAILED');assert.equal(rotated.attempts,attempts);assert.equal(f.requests.length,count);
  await f.reopen();f.service.syncBatch(batch.id);await f.service.runDue();assert.equal(f.requests.length,count);
  const explicit=f.service.retry(rotated.id);assert.equal(explicit.attempts,attempts);await f.service.runDue();assert.equal(f.requests.length,count+1);
});
test('credential rotation does not bypass a cancelled job',async t=>{
  const f=fixture(t),job=randomUUID(),[batch]=f.procurement.ensureAutomaticBatch(job,[f.draft.id],{[f.draft.id]:5});f.service.syncBatch(batch.id,{jobId:job});f.service.cancelJob(job);
  const target=f.amazon.executionTargetScope().target;f.amazon.executionTargetScope=()=>({target,generation:2});const [cancelled]=f.service.syncBatch(batch.id);f.service.resumeJob(job);await f.service.runDue();
  assert.equal(cancelled.status,'CANCELLED');assert.equal(f.requests.length,0);
});
test('suspending scheduling leaves queued records intact until scheduling resumes',async t=>{
  const f=fixture(t),batch=f.batch(),[row]=f.service.syncBatch(batch.id);
  const suspend=(f.service as typeof f.service&{suspendScheduling:()=>void}).suspendScheduling;assert.equal(typeof suspend,'function');
  f.service.resume();suspend.call(f.service);await new Promise(resolve=>setTimeout(resolve,35));
  assert.equal(f.requests.length,0);assert.equal(f.service.get(row.id).status,'QUEUED');assert.equal(f.service.get(row.id).paused,false);
  f.service.resume();await new Promise(resolve=>setTimeout(resolve,35));assert.equal(f.requests.length,1);await f.service.runDue();
});

for(const failure of ['download','pdf','response','unexpected'] as const)test(`label failure preserves safe ${failure} detail across restart without automatic re-request`,async t=>{
  const f=fixture(t),batch=f.batch();
  if(failure==='download')f.setDownload(async()=>{throw new (await import('../src/shared/errors.ts')).UserFacingError('标签下载地址解析失败或超时');});
  if(failure==='pdf')f.setDownload(async()=>Buffer.from('not a PDF'));
  if(failure==='response')f.setCreate(async()=>({data:{},status:200,requestId:'local-test'}));
  if(failure==='unexpected')f.setDownload(async()=>{throw new Error('private signed URL secret');});
  const [row]=f.service.syncBatch(batch.id);await f.service.runDue();
  const failed=f.service.get(row.id);
  assert.equal(failed.status,'FAILED');
  assert.match(failed.message,failure==='download'?/解析失败或超时/:failure==='pdf'?/不是有效 PDF/:failure==='response'?/没有返回完整标签文件列表/:/标签文件下载失败/);
  assert.equal(failed.message.includes('secret'),false);
  await f.reopen();await f.service.runDue();assert.equal(f.requests.length,1);assert.equal(f.service.get(row.id).message,failed.message);
});
