import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {consistencyFixture} from './helpers/source-consistency.ts';
import {mockStorage} from './fixtures/listing-ai.ts';
import {AiService} from '../src/main/ai/service.ts';
import {HostingService} from '../src/main/hosting/service.ts';
import {AmazonService} from '../src/main/amazon/service.ts';
import {AutomaticListingService} from '../src/main/automatic-listing/service.ts';
import {validateAutomaticListingTask,sourceStamp} from '../src/main/automatic-listing/records.ts';
import {queryTaskSummaries as unpresented} from '../src/main/automatic-listing/task-query.ts';
import {inheritLegacyPurposeSettings} from '../src/main/ai/purpose-routing.ts';
import {fingerprint} from '../src/main/execution/records.ts';
import {defaultListingRules} from '../src/shared/listing-rules.ts';
import {DEFAULT_ITEM_LABEL_FORMAT} from '../src/shared/item-label-contracts.ts';
import {readConsistencyView} from '../src/main/source-image-consistency/proof.ts';
import {consistencyAttemptUnknown,latestConsistencyAttempt} from '../src/main/source-image-consistency/history.ts';


test('a historical missing draft remains UNKNOWN without blocking healthy rows or changing retained evidence',async t=>{
 const f=consistencyFixture(t),hosting=new HostingService(f.directory,f.store,mockStorage);let posts=0;
 const ai=new AiService(f.directory,f.store,hosting,mockStorage,{fetch:async()=>{posts++;return new Response('',{status:200});}});
 ai.saveConnection({id:'deepseek',apiKey:'quality-synthetic-key'});ai.saveFunctionSettings({id:'deepseek',model:'deepseek-flash',enabled:true});inheritLegacyPurposeSettings((ai as any).db,'deepseek','deepseek-flash',false);
 f.cleanup.push(async()=>{await ai.close();await hosting.close();});await assert.rejects(ai.observeSourceConsistency(f.context(),()=>{}));
 assert.equal(readConsistencyView(f.db,f.context()).status,'SYSTEM_REPAIR');assert.equal(consistencyAttemptUnknown(f.db,latestConsistencyAttempt(f.db,f.context())!),true);assert.equal(posts,1);
 const rules=defaultListingRules(),at='2026-10-15T00:00:00.000Z',hash='a'.repeat(64),p=f.store.getProductSnapshot(f.p.id),draftId=randomUUID(),healthy=f.store.createProduct(),otherUnknown=f.store.createProduct();
 const make=(product:typeof p,status='PENDING',code?:string,draft:string|null=null)=>{const v=product.variants[0];return {key:product.id+':'+v.id,productId:product.id,productRevision:product.revision,sourceStamp:sourceStamp(product),productTitle:product.title,variantId:v.id,sku:'SYN-'+v.id,stockSets:5,sourcesPrepared:false,status,stage:'SOURCES',draftId:draft,executionTaskIds:[],imageStarted:false,imageAttempts:0,repairAttempts:0,repair:null,batchId:null,error:code?'Historical retained unknown':null,...(code?{outcome:{version:1,kind:'UNKNOWN',code,message:'Historical retained unknown',classifiedAt:at,scope:{mode:'demo',sellerId:'synthetic',marketplaceId:'US',productId:product.id,recipeKey:v.id,recipeStamp:fingerprint({variantId:v.id}),sourceStamp:sourceStamp(product),rulesStamp:fingerprint(rules),ruleRevision:rules.revision},draftId:draft,draftRevision:draft?1:null}}:{})};};
 const missing=make(p,'FAILED','SOURCE_CONSISTENCY_SENT_UNKNOWN',draftId),normal=make(healthy),field=make(otherUnknown,'FAILED','FIELD_RESULT_UNKNOWN');
 const task=validateAutomaticListingTask({id:randomUUID(),revision:1,status:'PAUSED',targetId:'synthetic',targetName:'Synthetic',sellerId:'synthetic',marketplaceId:'US',mode:'demo',targetStamp:hash,profileId:'alpha',profileStamp:hash,rulesStamp:fingerprint(rules),ruleRevision:rules.revision,productType:'BOX',locale:'en_US',labelFormat:DEFAULT_ITEM_LABEL_FORMAT,items:[missing,normal,field],createdAt:at,updatedAt:at,error:null});
 f.db.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(task.id,JSON.stringify(task));
 const amazon=new AmazonService(f.directory,id=>f.store.getProductSnapshot(id),mockStorage,{fetch:async()=>{throw Error('unexpected external command');}});f.cleanup.push(()=>amazon.close());
 const automatic=new AutomaticListingService(f.directory,{store:f.store,rules:()=>rules,amazon,images:{getProgress:()=>null},execution:{list:()=>[]}} as any);f.cleanup.push(()=>automatic.close());
 assert.throws(()=>amazon.getDraft(draftId));
 const before=JSON.stringify(f.db.prepare('SELECT * FROM automatic_listing_tasks').all()),call=JSON.stringify(ai.listCalls()),usage=JSON.stringify(f.db.prepare('SELECT * FROM ai_usage_ledger').all()),own=(automatic as any).db,changes=own.prepare('SELECT total_changes() n').get()!.n;
 const savedCall=ai.listCalls()[0],receiptIndex=JSON.parse(String(f.db.prepare('SELECT record_json FROM ai_provider_receipts WHERE id=?').get(savedCall.providerReceiptId!)!.record_json)),rawPath=join(f.directory,receiptIndex.relativePath),originalBody=readFileSync(rawPath);
 assert.equal(unpresented((automatic as any).tasks,{taskIds:[task.id],page:1,pageSize:20},f.db).rows[0].counts.unknown,2);
 for(let i=0;i<20;i++){
  const summary=automatic.queryTaskSummaries({taskIds:[task.id],page:1,pageSize:20}).rows[0];assert.equal(summary.counts.unknown,2);assert.equal(summary.counts.pending,1);assert.equal(summary.counts.invalidOutput,0);
  const groups=automatic.queryTaskGroups({taskId:task.id,revision:1,page:1,pageSize:20,search:''});assert.equal(groups.kind,'page');if(groups.kind==='page'){assert.equal(groups.groups.length,3);const bad=groups.groups.find(row=>row.productId===p.id)!.items[0];assert.equal(bad.outcome,'unknown');assert.match(bad.reason,/暂不可读.*仍未知/);assert.match(bad.reason,/未发送/);assert.equal(groups.groups.find(row=>row.productId===healthy.id)!.items[0].outcome,'pending');assert.equal(groups.groups.find(row=>row.productId===otherUnknown.id)!.items[0].outcome,'unknown');}
  for(const row of [missing,normal,field]){const detail=automatic.getTaskItem({taskId:task.id,revision:1,itemKey:row.key});assert.equal(detail.kind,'item');if(detail.kind==='item'){assert.equal(detail.item.sku,row.sku);assert.equal(detail.item.draftId,row.draftId);if(row===missing){assert.equal(detail.item.outcome?.kind,'UNKNOWN');assert.equal(detail.item.outcome?.code,'EVIDENCE_READ_FAILED');}else if(row===field){assert.equal(detail.item.outcome?.code,'FIELD_RESULT_UNKNOWN');}else assert.equal(detail.item.status,'PENDING');}}
 }
 await assert.rejects(ai.observeSourceConsistency(f.context(),()=>{}));assert.equal(posts,1);
 assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM automatic_listing_tasks').all()),before);assert.equal(JSON.stringify(ai.listCalls()),call);assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM ai_usage_ledger').all()),usage);assert.equal(own.prepare('SELECT total_changes() n').get()!.n,changes);assert.deepEqual(readFileSync(rawPath),originalBody);
});
