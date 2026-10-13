import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabase } from '../src/main/database.ts';
import { ProcurementService } from '../src/main/procurement/service.ts';
import type { AmazonDraft, AmazonTarget, JsonObject } from '../src/shared/amazon-contracts.ts';
import type { ProductDetail } from '../src/shared/contracts.ts';
import { AmazonTransport, AmazonTransportError } from '../src/main/amazon/transport.ts';
import { buildSalesRecipes } from '../src/main/sales-plans/recipes.ts';
import { defaultListingRules } from '../src/shared/listing-rules.ts';
import { salesPurchaseComponents } from '../src/shared/sales-purchase.ts';

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
  const amazon={restoreItemLabelDownloads:(_scope:import('../src/main/amazon/transport.ts').LabelDownloadScope,_documents:{uri:string;expiration:number}[])=>{},executionTargetScope:()=>({target,generation:1}),createMarketplaceItemLabels:async(_id:string,body:JsonObject,guard?:()=>void)=>{guard?.();requests.push(body);return make();},downloadItemLabel:async(uri:string)=>download(uri)};
  let service=new implementation.ItemLabelService(dir,amazon,procurement,{now:()=>now,sleep:async()=>{}});
  t.after(async()=>{await service.close();procurement.close();});
  return {dir,product,draft,procurement,requests,amazon,now:()=>now,get service(){return service;},advance:(ms:number)=>now+=ms,setCreate:(fn:typeof make)=>make=fn,setDownload:(fn:typeof download)=>download=fn,reopen:async()=>{await service.close();service=new implementation!.ItemLabelService(dir,amazon,procurement,{now:()=>now,sleep:async()=>{}});},
    batch:()=>procurement.ensureAutomaticBatch(randomUUID(),[draftId],{[draftId]:5})[0]};
}

function realLabelTransport(f:ReturnType<typeof fixture>,status:()=>number){
  const calls:{url:string;init:RequestInit}[]=[],target=f.amazon.executionTargetScope().target;
  let transport:AmazonTransport;
  const reset=()=>{transport=new AmazonTransport({active:()=>target,generation:()=>1,credentials:()=>({...target,name:'test',clientId:'client',clientSecret:'secret',refreshToken:'refresh'}),pause:()=>{},audit:()=>{},redact:value=>value,remember:()=>{}},{now:f.now,sleep:async()=>{},resolveAddresses:async()=>['52.1.2.3'],fetch:async()=>{throw Error('native transport expected');},dataFetch:async(url,init)=>{
    calls.push({url,init});if(url.includes('/auth/o2/token'))return Response.json({access_token:'token',token_type:'bearer',expires_in:3600});
    if(url.includes('/items/labels'))return Response.json({documentDownloads:[{downloadType:'URL',uri:'https://labels.amazon.com/recovery.pdf?signature=synthetic-private'}]},{headers:{'x-amzn-requestid':'original-post'}});
    return status()===200?new Response(new Uint8Array(pdfBytes()),{headers:{'content-type':'application/pdf'}}):new Response('unavailable',{status:status()});
  }});};reset();
  f.amazon.createMarketplaceItemLabels=async(_id,body,guard)=>transport.createMarketplaceItemLabels(target,body,guard);
  f.amazon.downloadItemLabel=async uri=>transport.downloadItemLabel(uri);
  f.amazon.restoreItemLabelDownloads=(scope,documents)=>transport.restoreItemLabelDownloads(target,scope,documents);
  return {calls,reset,posts:()=>calls.filter(call=>call.url.includes('/items/labels')).length,gets:()=>calls.filter(call=>call.init.method==='GET').length};
}

test('real transport restores original GET capability after process restart and encrypted backup restore',async t=>{
  const f=fixture(t),batch=f.batch();let status=503;const transport=realLabelTransport(f,()=>status);
  const [row]=f.service.prepareBatch(batch.id);await f.service.runDue();assert.equal(transport.posts(),1);assert.equal(transport.gets(),2);
  const db=openDatabase(f.dir),snapshot={...f.service.get(row.id),status:'DOWNLOADING',nextDueAt:null};db.prepare('UPDATE item_labels SET record_json=? WHERE id=?').run(JSON.stringify(snapshot),row.id);db.close();
  const {createWorkspaceBackup,prepareWorkspaceRestore,commitWorkspaceRestore}=await import('../src/main/backup.ts');
  const archive=resolve('.test-data',randomUUID()+'.htcbackup'),destination=resolve('.test-data','real-label-restored-'+randomUUID());
  await createWorkspaceBackup(f.dir,archive,'synthetic-real-transport');await commitWorkspaceRestore(destination,await prepareWorkspaceRestore(destination,archive,'synthetic-real-transport'));
  transport.reset();status=200;await f.reopen();f.service.retry(row.id);await f.service.runDue();assert.equal(f.service.get(row.id).status,'READY');assert.equal(transport.posts(),1);
  transport.reset();const restored=new implementation!.ItemLabelService(destination,f.amazon,f.procurement,{now:f.now,sleep:async()=>{}});
  try{restored.retry(row.id);await restored.runDue();assert.equal(restored.get(row.id).status,'READY');assert.equal(restored.get(row.id).requestId,'original-post');assert.equal(restored.get(row.id).attempts,1);}finally{await restored.close();}
  assert.equal(transport.posts(),1);assert.equal(transport.gets(),4);
  for(const call of transport.calls.filter(call=>call.init.method==='GET')){assert.equal(call.init.credentials,'omit');assert.equal(call.init.redirect,'manual');assert.equal(new Headers(call.init.headers).has('authorization'),false);assert.equal(new Headers(call.init.headers).has('x-amz-access-token'),false);}
});

test('real transport GET 503 exhausts three download rounds with one POST and actual backoff',async t=>{
  const f=fixture(t),batch=f.batch(),transport=realLabelTransport(f,()=>503);const [row]=f.service.prepareBatch(batch.id);
  await f.service.runDue();assert.equal(f.service.get(row.id).status,'QUEUED');const first=f.service.get(row.id);assert.ok(Date.parse(first.nextDueAt!)>f.now());
  await f.service.runDue();assert.equal(transport.gets(),2);
  for(let n=0;n<3;n++){f.advance(120000);await f.service.runDue();}
  const failed=f.service.get(row.id);assert.equal(failed.status,'FAILED');assert.equal(failed.errorCode,'HTTP_503');assert.equal(failed.downloadAttempts,3);assert.equal(failed.attempts,1);assert.equal(failed.requestId,'original-post');assert.equal(transport.posts(),1);assert.equal(transport.gets(),6);
});
function changeQuantity(f:ReturnType<typeof fixture>,batchId:string,stockQuantity:number|null){
  const batch=f.procurement.get(batchId);
  f.procurement.update({id:batch.id,revision:batch.revision,lines:batch.lines.map(({id,purchaseQuantity,purchasePrice,purchaseUnit,priceConfirmed})=>({id,purchaseQuantity,purchasePrice,purchaseUnit,priceConfirmed,stockQuantity})),shipmentConfirmationId:''});
  return f.service.syncBatch(batchId)[0];
}

test('verified prepare rejects damaged READY reuse and retains the old PDF on SKU retry',async t=>{
  const f=fixture(t),batch=f.batch();const [queued]=f.service.prepareBatch(batch.id);await f.service.runDue();
  const ready=f.service.get(queued.id);
  assert.equal((await f.service.prepareVerifiedBatch(batch.id))[0].id,ready.id);
  writeFileSync(join(f.dir,ready.files[0].relativePath),Buffer.from('corrupt'));
  assert.equal((await f.service.prepareVerifiedBatch(batch.id))[0].status,'FAILED');
  const retry=f.service.retry(ready.id);assert.notEqual(retry.id,ready.id);
  assert.equal(f.service.get(ready.id).current,false);assert.deepEqual(f.service.get(ready.id).files,ready.files);
  await f.service.runDue();assert.equal(f.service.get(retry.id).status,'READY');assert.equal(f.requests.length,1);
});

test('label lifecycle is projected from the label owner without revising manual procurement',async t=>{
  const f=fixture(t),batch=f.batch();f.service.prepareBatch(batch.id);await f.service.runDue();
  const current=f.procurement.get(batch.id);assert.equal(current.revision,batch.revision);assert.equal(current.lines[0].labelStatus,'READY');
});

test('A30 ten three-piece sales sets request ten labels and preserve source/recipe prices after manual revision',async t=>{
  const f=fixture(t),recipe=buildSalesRecipes(f.product,null,defaultListingRules())[0];
  recipe.components[0].quantity=3;recipe.totalPieces=3;recipe.totalCostCny=Math.round(recipe.components[0].quotedCostCny!*3/recipe.components[0].piecesPerQuote*1e8)/1e8;recipe.key=createHash('sha256').update(JSON.stringify(recipe.components.map(c=>[c.sourceKey,c.quantity]))).digest('hex');
  f.draft.salesPlan={namingGroupId:randomUUID(),sourceGroupKey:'synthetic',collectedAt:'2026-10-08T01:00:00Z',collectionBasis:'first_import',sku:f.draft.sku,baseSku:f.draft.sku,recipe,parentage:'NONE',parentSku:null,variationTheme:null,relationReason:'synthetic',familyResolved:true,namingChildKey:recipe.key};
  const original=JSON.stringify(f.draft.salesPlan),[batch]=f.procurement.ensureAutomaticBatch(randomUUID(),[f.draft.id],{[f.draft.id]:10});
  assert.equal(salesPurchaseComponents(batch.lines[0].salesRecipe!,10)[0].pieces,30);
  await f.service.prepareVerifiedBatch(batch.id);await f.service.runDue();assert.equal((f.requests[0].mskuQuantities as {quantity:number}[])[0].quantity,10);
  const current=f.procurement.get(batch.id),revised=f.procurement.update({id:current.id,revision:current.revision,lines:current.lines.map(({id,stockQuantity,purchaseUnit})=>({id,stockQuantity,purchaseUnit,purchaseQuantity:12,purchasePrice:'99.00',priceConfirmed:true})),shipmentConfirmationId:''});
  assert.equal(revised.lines[0].priceConfirmed,false);assert.equal(revised.lines[0].stockQuantity,10);assert.equal(revised.lines[0].purchaseQuantity,12);
  assert.equal(JSON.stringify(f.draft.salesPlan),original);assert.equal(f.product.variants[0].purchasePrice,'2.50');
});

test('label reuse matches saved batch revision and paper while opening never claims printed',async t=>{
  const f=fixture(t),batch=f.batch();const [first]=f.service.prepareBatch(batch.id);await f.service.runDue();
  const handlers=new Map<string,Function>();const {installItemLabelIpc}=await import('../src/main/item-labels-ipc.ts');
  installItemLabelIpc(f.dir,{labels:f.service} as any,((name:string,_n:number,fn:Function)=>handlers.set(name,fn)) as any,{openPath:async()=>''} as any);
  await handlers.get('red:item-labels:open')!({id:first.id,fileIndex:1});assert.equal(f.service.get(first.id).status,'READY');
  const saved=f.procurement.get(batch.id);f.procurement.update({id:saved.id,revision:saved.revision,lines:saved.lines.map(({id,purchaseQuantity,stockQuantity,purchasePrice,purchaseUnit,priceConfirmed})=>({id,purchaseQuantity,stockQuantity,purchasePrice,purchaseUnit,priceConfirmed})),shipmentConfirmationId:'FBA12345'});
  const [revised]=await f.service.prepareVerifiedBatch(batch.id);assert.notEqual(revised.id,first.id);await f.service.runDue();
  const [paper]=await f.service.prepareVerifiedBatch(batch.id,{format:{labelType:'STANDARD_FORMAT',pageType:'A4_24',localeCode:'en_US'}});assert.notEqual(paper.id,revised.id);
});

test('adding revision binding cannot replay an unknown legacy label request',async t=>{
  const f=fixture(t),batch=f.batch(),[row]=f.service.prepareBatch(batch.id);
  const {itemLabelFingerprint}=await import('../src/main/item-labels/records.ts');
  delete row.batchRevision;row.fingerprint=itemLabelFingerprint(row);row.status='FAILED';row.errorCode='REQUEST_UNKNOWN';row.attempts=3;row.nextDueAt=null;
  const db=openDatabase(f.dir);db.prepare('UPDATE item_labels SET record_json=? WHERE id=?').run(JSON.stringify(row),row.id);db.close();
  const [current]=await f.service.prepareVerifiedBatch(batch.id);await f.service.runDue();
  assert.equal(current.status,'FAILED');assert.equal(current.errorCode,'REQUEST_UNKNOWN');assert.equal(current.attempts,3);assert.equal(f.requests.length,0);
});

test('UNKNOWN keeps its original identity through price/shipment revisions, prepare, retry and restart',async t=>{
  const f=fixture(t),batch=f.batch();f.setCreate(async()=>{throw new AmazonTransportError('unknown',null,'original-request',true);});
  const [initial]=await f.service.prepareVerifiedBatch(batch.id);await f.service.runDue();const original=f.service.get(initial.id);
  for(const change of ['same','price','shipment'] as const){
    if(change!=='same'){
      const b=f.procurement.get(batch.id);f.procurement.update({id:b.id,revision:b.revision,lines:b.lines.map(({id,purchaseQuantity,stockQuantity,purchasePrice,purchaseUnit,priceConfirmed})=>({id,purchaseQuantity,stockQuantity,purchasePrice:change==='price'?'9.99':purchasePrice,purchaseUnit,priceConfirmed})),shipmentConfirmationId:change==='shipment'?'FBA12345':''});
    }
    const [held]=await f.service.prepareVerifiedBatch(batch.id);assert.equal(held.id,original.id);assert.equal(held.attempts,1);assert.equal(held.requestId,'original-request');assert.equal(held.errorCode,'REQUEST_UNKNOWN');
    assert.throws(()=>f.service.retry(held.id),/未知|核对/);await f.service.runDue();assert.equal(f.requests.length,1);
    await f.reopen();assert.deepEqual(f.service.get(original.id),original);
  }
  const {createWorkspaceBackup,prepareWorkspaceRestore,commitWorkspaceRestore}=await import('../src/main/backup.ts');
  const archive=resolve('.test-data',randomUUID()+'.htcbackup'),destination=resolve('.test-data','unknown-restored-'+randomUUID());
  await createWorkspaceBackup(f.dir,archive,'synthetic-unknown-test');await commitWorkspaceRestore(destination,await prepareWorkspaceRestore(destination,archive,'synthetic-unknown-test'));
  const restored=openDatabase(destination);try{assert.deepEqual(JSON.parse(String(restored.prepare('SELECT record_json FROM item_labels WHERE id=?').get(original.id)!.record_json)),{...original,paused:true});}finally{restored.close();}
});

test('a late UNKNOWN response blocks an already queued newer revision of the same SKU',async t=>{
  const f=fixture(t),batch=f.batch();let reject!:(error:unknown)=>void;
  f.setCreate(()=>new Promise((_resolve,fail)=>{reject=fail;}));const [old]=f.service.prepareBatch(batch.id);const pending=f.service.runDue();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.service.get(old.id).requestPending,true);
  changeQuantity(f,batch.id,6);f.service.prepareBatch(batch.id);
  assert.equal(f.service.get(old.id).requestPending,true);
  reject(new AmazonTransportError('late unknown',null,'late-request',true));await pending;
  f.setCreate(async()=>({data:{documentDownloads:[{downloadType:'URL',uri:'https://labels.amazon.com/one.pdf'}]},status:200,requestId:'should-not-send'}));
  await f.service.runDue();assert.equal(f.requests.length,1);assert.equal(f.service.get(old.id).errorCode,'REQUEST_UNKNOWN');assert.equal(f.service.get(old.id).requestId,'late-request');
  assert.equal((await f.service.prepareVerifiedBatch(batch.id))[0].id,old.id);await f.reopen();await f.service.runDue();assert.equal(f.requests.length,1);
});

for(const superseded of [false,true])test(`restart holds an actually persisted REQUESTING request, superseded=${superseded}`,async t=>{
  const f=fixture(t),batch=f.batch(),[row]=f.service.prepareBatch(batch.id);
  row.status='REQUESTING';row.attempts=1;row.requestId='first-request';row.nextDueAt=null;
  const db=openDatabase(f.dir);db.prepare('UPDATE item_labels SET record_json=? WHERE id=?').run(JSON.stringify(row),row.id);db.close();
  if(superseded)changeQuantity(f,batch.id,6);
  await f.reopen();const held=f.service.get(row.id);
  assert.equal(held.errorCode,'REQUEST_UNKNOWN');assert.equal(held.id,row.id);assert.equal(held.attempts,1);assert.equal(held.requestId,'first-request');
  assert.equal(held.status,superseded?'STALE':'FAILED');assert.throws(()=>f.service.retry(row.id),/未知/);
  assert.equal((await f.service.prepareVerifiedBatch(batch.id))[0].id,row.id);await f.service.runDue();assert.equal(f.requests.length,0);
});

test('restart distinguishes a known response download from an unknown sent request',async t=>{
  const f=fixture(t),batch=f.batch(),[row]=f.service.prepareBatch(batch.id);row.status='DOWNLOADING';row.attempts=1;row.requestId='known-response';row.nextDueAt=null;
  const db=openDatabase(f.dir);db.prepare('UPDATE item_labels SET record_json=? WHERE id=?').run(JSON.stringify(row),row.id);db.close();
  await f.reopen();const held=f.service.get(row.id);assert.equal(held.errorCode,'INTERRUPTED');assert.equal(held.requestId,'known-response');
  assert.throws(()=>f.service.retry(row.id),/恢复|缺失|原标签/);assert.equal(f.requests.length,0);
});

test('known response resumes its saved download after restart without a second POST or exposing URL',async t=>{
  const f=fixture(t),batch=f.batch();f.setCreate(async()=>({data:{documentDownloads:[{downloadType:'URL',uri:'https://labels.amazon.com/one.pdf?signature=private-capability'}]},status:200,requestId:'known-result'}));
  f.setDownload(async()=>{throw Error('offline');});const [row]=f.service.prepareBatch(batch.id);await f.service.runDue();
  assert.equal(f.requests.length,1);
  // Restore the persisted in-download snapshot, as if the process died before catch ran.
  const db=openDatabase(f.dir),inFlight={...f.service.get(row.id),status:'DOWNLOADING',errorCode:null};db.prepare('UPDATE item_labels SET record_json=? WHERE id=?').run(JSON.stringify(inFlight),row.id);db.close();
  const {createWorkspaceBackup,prepareWorkspaceRestore,commitWorkspaceRestore}=await import('../src/main/backup.ts');
  const archive=resolve('.test-data',randomUUID()+'.htcbackup'),destination=resolve('.test-data','download-restored-'+randomUUID());
  await createWorkspaceBackup(f.dir,archive,'synthetic-download-test');await commitWorkspaceRestore(destination,await prepareWorkspaceRestore(destination,archive,'synthetic-download-test'));
  const restored=new implementation!.ItemLabelService(destination,f.amazon,f.procurement,{now:()=>Date.parse('2026-10-08T00:00:00.000Z'),sleep:async()=>{}});
  try{f.setDownload(async()=>pdfBytes());restored.retry(row.id);await restored.runDue();assert.equal(restored.get(row.id).status,'READY');assert.equal(f.requests.length,1);}finally{await restored.close();}
  await f.reopen();f.setDownload(async()=>pdfBytes());f.service.retry(row.id);await f.service.runDue();
  const ready=f.service.get(row.id);assert.equal(ready.status,'READY');assert.equal(ready.requestId,'known-result');assert.equal(ready.attempts,1);assert.equal(f.requests.length,1);
  assert.ok(!JSON.stringify(f.service.list()).includes('private-capability'));
});

test('expired saved downloads and legacy missing descriptors cannot generate a replacement request',async t=>{
  const f=fixture(t),batch=f.batch();f.setDownload(async()=>{throw Error('offline');});const [row]=f.service.prepareBatch(batch.id);await f.service.runDue();
  f.advance(16*60000);await f.reopen();assert.throws(()=>f.service.retry(row.id),/过期|恢复/);await f.service.runDue();assert.equal(f.requests.length,1);
});

test('a mismatched recovery fingerprint blocks download retry and keeps the original request',async t=>{
  const f=fixture(t),batch=f.batch();f.setDownload(async()=>{throw Error('offline');});const [row]=f.service.prepareBatch(batch.id);await f.service.runDue();
  const db=openDatabase(f.dir);db.prepare("UPDATE amazon_settings SET value_json=json_set(value_json,'$.fingerprint',?) WHERE key=?").run('a'.repeat(64),'item_label_download_v1:'+row.id);db.close();
  assert.throws(()=>f.service.retry(row.id),/不匹配/);await f.service.runDue();assert.equal(f.requests.length,1);assert.equal(f.service.get(row.id).attempts,1);
});

test('credential rotation cannot turn a known response into another POST',async t=>{
  const f=fixture(t),batch=f.batch();f.setDownload(async()=>{throw Error('offline');});f.service.prepareBatch(batch.id);await f.service.runDue();
  const target=f.amazon.executionTargetScope().target;f.amazon.executionTargetScope=()=>({target,generation:2});
  const [rotated]=await f.service.prepareVerifiedBatch(batch.id);assert.throws(()=>f.service.retry(rotated.id),/恢复|缺失|原标签/);await f.service.runDue();assert.equal(f.requests.length,1);
});

test('transient download retries have their own finite budget and retain the original POST identity',async t=>{
  const f=fixture(t),batch=f.batch();f.setDownload(async()=>{throw new AmazonTransportError('download unavailable',503,'download-request',false);});
  const [row]=f.service.prepareBatch(batch.id);for(let n=0;n<4;n++){await f.service.runDue();f.advance(120000);}
  const failed=f.service.get(row.id);assert.equal(failed.status,'FAILED');assert.equal(failed.downloadAttempts,3);assert.equal(failed.attempts,1);assert.equal(failed.requestId,'request-1');assert.equal(f.requests.length,1);
});
test('automatic procurement is incremental and idempotent and preserves sales units', t=>{
  const f=fixture(t),job=randomUUID(); const [first]=f.procurement.ensureAutomaticBatch(job,[f.draft.id],{[f.draft.id]:5});
  const [again]=f.procurement.ensureAutomaticBatch(job,[f.draft.id],{[f.draft.id]:5});
  assert.equal(first.id,again.id); assert.equal(again.lines.length,1); assert.equal(again.lines[0].stockQuantity,5); assert.equal(again.lines[0].purchaseQuantity,null);
  f.draft.state='UNKNOWN'; assert.throws(()=>f.procurement.ensureAutomaticBatch(randomUUID(),[f.draft.id],{[f.draft.id]:5}));
});
test('all documents are persisted and checksum verified before READY, reopening does not request again',async t=>{
  const f=fixture(t),batch=f.batch(); const [queued]=f.service.prepareBatch(batch.id); assert.equal(queued.status,'QUEUED');
  f.service.prepareBatch(batch.id); await f.service.runDue(); assert.equal(f.requests.length,1); assert.equal((f.requests[0].mskuQuantities as {quantity:number}[])[0].quantity,5);
  const ready=f.service.get(queued.id); assert.equal(ready.status,'READY'); assert.equal(ready.files.length,2); assert.equal(f.procurement.get(batch.id).lines[0].labelStatus,'READY');
  assert.equal((await f.service.verifyFiles(ready.id)).files.length,2); await f.reopen(); f.service.prepareBatch(batch.id); await f.service.runDue(); assert.equal(f.requests.length,1);
  writeFileSync(join(f.dir,ready.files[0].relativePath),Buffer.from('corrupted'));
  await assert.rejects(f.service.verifyFiles(ready.id)); assert.equal(f.service.get(ready.id).status,'FAILED');
});
test('late response stays stale after quantity changes, including cleared quantity',async t=>{
  const f=fixture(t),batch=f.batch(); const [old]=f.service.prepareBatch(batch.id); let resolveRequest!: (v:{data:JsonObject;status:number;requestId:string})=>void;
  f.setCreate(()=>new Promise(resolve=>{resolveRequest=resolve;})); const running=f.service.runDue(); await new Promise(resolve=>setImmediate(resolve));
  const edit=f.procurement.get(batch.id); f.procurement.update({id:edit.id,revision:edit.revision,lines:edit.lines.map(line=>({...(({id,purchaseQuantity,purchasePrice,purchaseUnit,priceConfirmed})=>({id,purchaseQuantity,purchasePrice,purchaseUnit,priceConfirmed}))(line),stockQuantity:null})),shipmentConfirmationId:''});
  const [newest]=f.service.prepareBatch(batch.id); assert.equal(newest.status,'WAITING_QUANTITY');
  resolveRequest({data:{documentDownloads:[{downloadType:'URL',uri:'https://labels.amazon.com/one.pdf'}]},status:200,requestId:'old'}); await running;
  assert.equal(f.service.get(old.id).status,'STALE'); assert.equal(f.service.get(newest.id).status,'WAITING_QUANTITY'); assert.equal(f.procurement.get(batch.id).lines[0].labelStatus,'WAITING_QUANTITY');
});
test('download errors and malformed PDFs never become READY or leak a signed URL',async t=>{
  const f=fixture(t),batch=f.batch(); f.setDownload(async()=>Buffer.from('<html>access denied</html>'));
  const [record]=f.service.prepareBatch(batch.id); await f.service.runDue(); const failed=f.service.get(record.id);
  assert.equal(failed.status,'FAILED'); assert.equal(failed.files.length,0); assert.ok(!JSON.stringify(failed).includes('https://'));
});
test('retry counters survive restart and stop after finite attempts',async t=>{
  const f=fixture(t),batch=f.batch(); f.setCreate(async()=>{throw new AmazonTransportError('temporary',503,'retry-1');});
  const [record]=f.service.prepareBatch(batch.id); for(let i=0;i<3;i++){await f.service.runDue(); await f.reopen(); f.advance(120000);}
  await f.service.runDue(); assert.equal(f.requests.length,3); assert.equal(f.service.get(record.id).status,'FAILED'); assert.equal(f.service.get(record.id).attempts,3);
  f.service.prepareBatch(batch.id); await f.service.runDue(); assert.equal(f.requests.length,3);
});
test('pause and cancel prevent dispatch while an already sent label result is preserved',async t=>{
  const f=fixture(t),job=randomUUID(),[batch]=f.procurement.ensureAutomaticBatch(job,[f.draft.id],{[f.draft.id]:5});const [row]=f.service.prepareBatch(batch.id);
  f.service.pauseJob(job);await f.service.runDue();assert.equal(f.requests.length,0);await f.reopen();await f.service.runDue();assert.equal(f.requests.length,0);
  f.service.resumeJob(job);let release!:()=>void;f.setCreate(async()=>{await new Promise<void>(resolve=>{release=resolve;});return {data:{documentDownloads:[{downloadType:'URL',uri:'https://labels.amazon.com/a.pdf'}]},status:200,requestId:'finish-after-pause'};});
  const pending=f.service.runDue();await new Promise(resolve=>setImmediate(resolve));f.service.pauseJob(job);release();await pending;assert.equal(f.service.get(row.id).status,'READY');assert.equal(f.requests.length,1);
});
test('a cancelled queued record remains cancelled when a stale dispatch snapshot is drained',async t=>{
  const f=fixture(t),first=f.batch();f.service.prepareBatch(first.id);const job=randomUUID(),[batch]=f.procurement.ensureAutomaticBatch(job,[f.draft.id],{[f.draft.id]:5});const [row]=f.service.prepareBatch(batch.id);
  let release!:()=>void;f.setCreate(async()=>{await new Promise<void>(resolve=>{release=resolve;});return {data:{documentDownloads:[{downloadType:'URL',uri:'https://labels.amazon.com/a.pdf'}]},status:200,requestId:'first'};});
  const running=f.service.runDue();await new Promise(resolve=>setImmediate(resolve));f.service.cancelJob(job);release();await running;assert.equal(f.service.get(row.id).status,'CANCELLED');assert.equal(f.requests.length,1);
});
test('batch file export requires one current complete label set for every row',async t=>{
  const f=fixture(t),batch=f.batch();f.service.prepareBatch(batch.id);await f.service.runDue();assert.equal((await f.service.filesForBatch(batch.id)).length,2);
  const db=openDatabase(f.dir),updated=f.procurement.get(batch.id);updated.lines.push({...updated.lines[0],id:randomUUID(),draftId:randomUUID(),variantId:randomUUID(),sku:'SKU-TWO',labelStatus:'NOT_REQUESTED'});db.prepare('UPDATE procurement_batches SET record_json=? WHERE id=?').run(JSON.stringify(updated),batch.id);db.close();await assert.rejects(f.service.filesForBatch(batch.id));
});
test('changed target identity invalidates existing labels and creates an explicit context failure',async t=>{
  const f=fixture(t),batch=f.batch(),[old]=f.service.prepareBatch(batch.id);await f.service.runDue();f.amazon.executionTargetScope().target.sellerId='NEW_SELLER';
  const [current]=f.service.prepareBatch(batch.id);assert.equal(f.service.get(old.id).status,'STALE');assert.equal(current.status,'FAILED');assert.equal(current.errorCode,'TARGET_CONTEXT_CHANGED');await f.service.runDue();assert.equal(f.requests.length,1);
});
test('pause and ordinary retry cannot replay an unknown sent request',async t=>{
  const f=fixture(t),job=randomUUID(),[batch]=f.procurement.ensureAutomaticBatch(job,[f.draft.id],{[f.draft.id]:5});const [row]=f.service.prepareBatch(batch.id);
  let fail!:(error:unknown)=>void;f.setCreate(()=>new Promise((_resolve,reject)=>{fail=reject;}));const running=f.service.runDue();await new Promise(resolve=>setImmediate(resolve));f.service.pauseJob(job);fail(new AmazonTransportError('unknown',null,null,true));await running;
  assert.equal(f.service.get(row.id).status,'FAILED');assert.equal(f.service.get(row.id).errorCode,'REQUEST_UNKNOWN');f.service.resumeJob(job);await f.service.runDue();assert.equal(f.requests.length,1);
  f.service.pauseJob(job);assert.throws(()=>f.service.retry(row.id),/未知/);assert.equal(f.service.get(row.id).attempts,1);
});
test('verification refuses a label superseded while its files are being read',async t=>{
  const f=fixture(t),batch=f.batch(),[old]=f.service.prepareBatch(batch.id);await f.service.runDue();
  const pending=f.service.verifyFiles(old.id);const newest=changeQuantity(f,batch.id,8);
  await assert.rejects(pending,/过期|变化/);
  assert.equal(f.service.get(old.id).current,false);assert.equal(f.service.get(newest.id).status,'NOT_REQUESTED');
});
test('an integrity failure during verification never resurrects a superseded row',async t=>{
  const f=fixture(t),batch=f.batch(),[old]=f.service.prepareBatch(batch.id);await f.service.runDue();
  writeFileSync(join(f.dir,f.service.get(old.id).files[0].relativePath),'broken');
  const pending=f.service.verifyFiles(old.id);const newest=changeQuantity(f,batch.id,null);await assert.rejects(pending);
  assert.equal(f.service.get(old.id).current,false);assert.equal(f.service.get(old.id).status,'STALE');
  assert.equal(f.service.list({batchId:batch.id}).filter(row=>row.current).length,1);
  assert.equal(f.service.get(newest.id).status,'WAITING_QUANTITY');assert.equal(f.procurement.get(batch.id).lines[0].labelStatus,'WAITING_QUANTITY');
});
test('batch export takes one coherent current snapshot after all file reads',async t=>{
  const f=fixture(t),batch=f.batch();f.service.prepareBatch(batch.id);await f.service.runDue();
  const verify=f.service.verifyFiles.bind(f.service);f.service.verifyFiles=async id=>{const result=await verify(id);changeQuantity(f,batch.id,8);return result;};
  await assert.rejects(f.service.filesForBatch(batch.id),/过期|变化|未就绪/);
});
test('verified export bytes remain the checked bytes when the source file changes',async t=>{
  const f=fixture(t),batch=f.batch();f.service.prepareBatch(batch.id);await f.service.runDue();
  const [file]=await f.service.filesForBatch(batch.id);writeFileSync(file.path,'replacement after verification');
  assert.deepEqual((file as typeof file&{bytes:Buffer}).bytes,pdfBytes());
});
test('export callers can synchronously recheck their final snapshot after writing files',async t=>{
  const f=fixture(t),batch=f.batch();f.service.prepareBatch(batch.id);await f.service.runDue();const files=await f.service.filesForBatch(batch.id);
  const guard=(f.service as typeof f.service&{assertBatchSnapshot:(id:string,rows:typeof files[number]['record'][])=>void}).assertBatchSnapshot;
  assert.equal(typeof guard,'function');guard.call(f.service,batch.id,files.map(file=>file.record));changeQuantity(f,batch.id,8);
  assert.throws(()=>guard.call(f.service,batch.id,files.map(file=>file.record)),/变化|未就绪|过期/);
});
for(const failure of ['REQUEST_UNKNOWN','RETRY_EXHAUSTED'] as const)test(`credential rotation preserves ${failure} and its attempt budget until explicit retry`,async t=>{
  const f=fixture(t),batch=f.batch();f.setCreate(async()=>{throw new AmazonTransportError('failed',failure==='REQUEST_UNKNOWN'?null:503,null,failure==='REQUEST_UNKNOWN');});
  const [old]=f.service.prepareBatch(batch.id);for(let i=0;i<(failure==='REQUEST_UNKNOWN'?1:3);i++){await f.service.runDue();f.advance(120000);}
  const attempts=f.service.get(old.id).attempts,count=f.requests.length,target=f.amazon.executionTargetScope().target;
  f.amazon.executionTargetScope=()=>({target,generation:2});const [rotated]=f.service.prepareBatch(batch.id);await f.service.runDue();
  assert.equal(rotated.status,'FAILED');assert.equal(rotated.attempts,attempts);assert.equal(f.requests.length,count);
  await f.reopen();f.service.prepareBatch(batch.id);await f.service.runDue();assert.equal(f.requests.length,count);
  if(failure==='REQUEST_UNKNOWN'){assert.equal(rotated.id,old.id);assert.throws(()=>f.service.retry(rotated.id),/未知/);await f.service.runDue();assert.equal(f.requests.length,count);}else{const explicit=f.service.retry(rotated.id);assert.equal(explicit.attempts,attempts);await f.service.runDue();assert.equal(f.requests.length,count+1);}
});
test('credential rotation does not bypass a cancelled job',async t=>{
  const f=fixture(t),job=randomUUID(),[batch]=f.procurement.ensureAutomaticBatch(job,[f.draft.id],{[f.draft.id]:5});f.service.prepareBatch(batch.id);f.service.cancelJob(job);
  const target=f.amazon.executionTargetScope().target;f.amazon.executionTargetScope=()=>({target,generation:2});const [cancelled]=f.service.prepareBatch(batch.id);f.service.resumeJob(job);await f.service.runDue();
  assert.equal(cancelled.status,'CANCELLED');assert.equal(f.requests.length,0);
});
test('suspending scheduling leaves queued records intact until scheduling resumes',async t=>{
  const f=fixture(t),batch=f.batch(),[row]=f.service.prepareBatch(batch.id);
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
  const [row]=f.service.prepareBatch(batch.id);await f.service.runDue();
  const failed=f.service.get(row.id);
  assert.equal(failed.status,'FAILED');
  assert.match(failed.message,failure==='download'?/解析失败或超时/:failure==='pdf'?/不是有效 PDF/:failure==='response'?/没有返回完整标签文件列表/:/标签文件下载失败/);
  assert.equal(failed.message.includes('secret'),false);
  await f.reopen();await f.service.runDue();assert.equal(f.requests.length,1);assert.equal(f.service.get(row.id).message,failed.message);
});
test('ordinary reconciliation never authorizes labels and explicit preparation reuses READY',async t=>{
 const f=fixture(t),batch=f.batch();const [row]=f.service.syncBatch(batch.id);
 assert.equal(row.status,'NOT_REQUESTED');assert.equal(row.requestedAt,undefined);
 await f.service.runDue();await f.reopen();f.service.resume();await f.service.runDue();assert.equal(f.requests.length,0);
 f.service.prepareBatch(batch.id);await f.service.runDue();const ready=f.service.get(row.id);assert.equal(ready.status,'READY');assert.ok(ready.requestedAt);
 f.service.prepareBatch(batch.id);await f.service.runDue();assert.deepEqual(f.service.get(row.id),ready);assert.equal(f.requests.length,1);
 const changed=changeQuantity(f,batch.id,8);assert.equal(changed.status,'NOT_REQUESTED');assert.equal(changed.requestedAt,undefined);await f.service.runDue();assert.equal(f.requests.length,1);
});
test('legacy queued rows preserve evidence and cannot dispatch through startup or resumeJob',async t=>{
 const f=fixture(t),batch=f.batch(),[row]=f.service.syncBatch(batch.id);const db=openDatabase(f.dir);
 row.status='QUEUED';row.nextDueAt=row.updatedAt;row.attempts=2;row.requestId='legacy-request';delete row.requestedAt;
 db.prepare('UPDATE item_labels SET record_json=? WHERE id=?').run(JSON.stringify(row),row.id);db.close();
 await f.reopen();f.service.resume();f.service.resumeJob(row.jobId!);await f.service.runDue();const held=f.service.get(row.id);
 assert.equal(f.requests.length,0);assert.equal(held.status,'QUEUED');assert.equal(held.attempts,2);assert.equal(held.requestId,'legacy-request');assert.equal(held.paused,true);
 f.service.prepareBatch(batch.id);await f.service.runDue();assert.equal(f.requests.length,1);
});
test('prepare never retries failed unknown or exhausted labels and strict intent leaves fingerprints compatible',async t=>{
 const f=fixture(t),batch=f.batch();f.setCreate(async()=>{throw new AmazonTransportError('unknown',null,'unknown-id',true);});const [row]=f.service.prepareBatch(batch.id);await f.service.runDue();
 const failed=f.service.get(row.id);f.service.prepareBatch(batch.id);await f.service.runDue();assert.deepEqual(f.service.get(row.id),failed);assert.equal(f.requests.length,1);
 assert.throws(()=>f.service.retry(row.id),/未知/);await f.service.runDue();assert.equal(f.requests.length,1);assert.equal(f.service.get(row.id).attempts,1);
 const {validateItemLabelRecord}=await import('../src/main/item-labels/records.ts');for(const requestedAt of [null,123,'bad'])assert.throws(()=>validateItemLabelRecord({...failed,requestedAt}));
 const legacy={...failed};delete legacy.requestedAt;assert.equal(validateItemLabelRecord(legacy).fingerprint,failed.fingerprint);
});
test('legacy in-flight labels retain original evidence and block ordinary retry',async t=>{
 const f=fixture(t),batch=f.batch(),[row]=f.service.syncBatch(batch.id),db=openDatabase(f.dir);row.status='REQUESTING';row.attempts=1;row.requestId='sent-id';
 db.prepare('UPDATE item_labels SET record_json=? WHERE id=?').run(JSON.stringify(row),row.id);db.close();await f.reopen();const held=f.service.get(row.id);
 assert.equal(held.status,'FAILED');assert.equal(held.errorCode,'REQUEST_UNKNOWN');assert.equal(held.requestId,'sent-id');assert.equal(held.attempts,1);
 f.service.prepareBatch(batch.id);await f.service.runDue();assert.equal(f.requests.length,0);
 const audit=openDatabase(f.dir);const evidence=audit.prepare("SELECT detail_json FROM audit_events WHERE action='item-labels.legacy-interrupted'").get();audit.close();assert.equal(JSON.parse(String(evidence?.detail_json)).status,'REQUESTING');
 assert.throws(()=>f.service.retry(row.id),/未知/);await f.service.runDue();assert.equal(f.requests.length,0);
});
test('prepare IPC is explicit and ordinary procurement saves remain local',async t=>{
 const f=fixture(t),batch=f.batch(),handlers=new Map<string,Function>();
 const {installItemLabelIpc}=await import('../src/main/item-labels-ipc.ts');const {installOperationsIpc}=await import('../src/main/operations-ipc.ts');
 const handle=(name:string,_arity:number,fn:Function)=>{handlers.set(name,fn);};
 installItemLabelIpc(f.dir,{labels:f.service,labelSettings:{get:()=>({labelType:'STANDARD_FORMAT',pageType:'A4_21',localeCode:'en_US'})}} as any,handle as any,{} as any);
 installOperationsIpc(f.dir,{procurement:f.procurement,labels:f.service} as any,handle as any,{audit:()=>{}} as any);
 const current=f.procurement.get(batch.id);handlers.get('red:procurement:update')!({id:current.id,revision:current.revision,lines:current.lines.map(({id,purchaseQuantity,purchasePrice,purchaseUnit,priceConfirmed,stockQuantity})=>({id,purchaseQuantity,purchasePrice,purchaseUnit,priceConfirmed,stockQuantity})),shipmentConfirmationId:''});
 await f.service.runDue();assert.equal(f.requests.length,0);assert.equal(f.service.list({batchId:batch.id})[0].status,'NOT_REQUESTED');
 handlers.get('red:item-labels:prepare')!(batch.id);await f.service.runDue();assert.equal(f.requests.length,1);
});
test('beforeSend rejects revoked intent after scheduler selection',async t=>{
 const f=fixture(t),batch=f.batch(),[row]=f.service.prepareBatch(batch.id);
 f.amazon.createMarketplaceItemLabels=async(_id,body,guard)=>{const db=openDatabase(f.dir),stored=f.service.get(row.id);delete stored.requestedAt;db.prepare('UPDATE item_labels SET record_json=? WHERE id=?').run(JSON.stringify(stored),row.id);db.close();guard?.();f.requests.push(body);return {data:{},status:200,requestId:null};};
 await f.service.runDue();assert.equal(f.requests.length,0);assert.equal(f.service.get(row.id).attempts,0);assert.equal(f.service.get(row.id).requestedAt,undefined);
});
test('explicitly requested waiting SKU may continue after readiness without a second request intent',async t=>{
 const f=fixture(t),batch=f.batch();f.draft.state='UNKNOWN';const [row]=f.service.prepareBatch(batch.id);assert.equal(row.status,'WAITING_SKU');assert.ok(row.requestedAt);await f.service.runDue();assert.equal(f.requests.length,0);
 f.draft.state='PROCESSING';await f.service.runDue();assert.equal(f.requests.length,1);assert.equal(f.service.get(row.id).status,'READY');
});
