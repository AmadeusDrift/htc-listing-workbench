import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { saveInput,chat } from './fixtures/listing-ai.ts';
import { saveProviderReceipt } from '../src/main/ai/receipts.ts';
import { writeFileSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SkuNamingService } from '../src/main/sku-naming/service.ts';
import { openDatabase } from '../src/main/database.ts';
import { assertSalesPlanNamingIdentity } from '../src/main/sales-plans/history.ts';
import { validateSalesPlan } from '../src/main/sales-plans/records.ts';
import { buildListingContext } from '../src/main/listing-ai/context.ts';
import { AmazonPersistence } from '../src/main/amazon/persistence.ts';
import { DatabaseSync } from 'node:sqlite';
import {AutomaticListingService} from '../src/main/automatic-listing/service.ts';
import {validateAutomaticListingTask,sourceStamp} from '../src/main/automatic-listing/records.ts';
import {readListingRules} from '../src/main/listing-rules.ts';
import {assertTaskAdaptationHistory} from '../src/main/automatic-listing/adaptation.ts';
import {planSalesListings} from '../src/main/sales-plans/planning.ts';

import {oldKit,taskKit} from './fixtures/mixed-kit.ts';
const history=(f:Awaited<ReturnType<typeof oldKit>>)=>JSON.stringify({draft:f.persistence.record(f.ref.id),calls:f.db.prepare('SELECT * FROM ai_calls').all(),usage:f.db.prepare('SELECT * FROM ai_usage_ledger').all(),receipts:f.db.prepare('SELECT * FROM ai_provider_receipts').all(),results:f.db.prepare('SELECT * FROM ai_results').all()});
for(const [label,body] of [['null',null],['number',123],['string','invalid response content'],['raw JSON text','{broken json'],['boolean',false]] as const)test(`complete scalar ${label} response is received invalid and permits only authorized local unit adoption`,async t=>{
 const f=await oldKit(t);f.respond(()=>new Response('{}',{status:500}));await assert.rejects(()=>f.ai.suggest({productId:f.p.id,productRevision:f.p.revision,variantId:f.p.variants[0].id,ocrResultIds:[]}));
 const call=f.ai.listCalls()[0],receipt=await saveProviderReceipt(f.db,f.directory,call.id,{gateway:'deepseek',endpoint:'/chat/completions',model:call.model,status:200,requestId:null,receivedAt:new Date().toISOString(),body,costUsd:null},call.purposeSnapshot);
 f.db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify({...call,errorCode:'OUTPUT_INVALID',providerReceiptId:receipt.id}),call.id);
 const before=history(f),preview=f.amazon.previewSalesUnitAdoption({...f.ref,platformPieces:1,basis:'合成明确按原完整套装确认'});
 assert.equal(preview.canApply,true,'a complete hash-verified scalar response is invalid, not missing/unknown');assert.equal(history(f),before);
 const financial=()=>JSON.stringify(['ai_calls','ai_usage_ledger','ai_provider_receipts','ai_results'].map(table=>f.db.prepare('SELECT * FROM '+table).all())),oldFinancial=financial(),path=join(f.directory,receipt.relativePath),bytes=readFileSync(path);
 const next=f.amazon.adoptSalesUnit({...f.ref,platformPieces:1,basis:preview.basis,token:preview.token,confirmed:true});
 assert.equal(next.sku,f.plan.sku);assert.equal(next.salesPlan?.recipe.quantityVersion,2);assert.equal(f.requests.length,1);
 assert.equal(financial(),oldFinancial);assert.deepEqual(readFileSync(path),bytes,'local adoption preserves original raw invalid response');
});
test('paid provider failure without reliable result evidence keeps unit adoption blocked regardless of error label',async t=>{
 const f=await oldKit(t);f.respond(()=>new Response(JSON.stringify({error:{message:'Synthetic processing failure'}}),{status:500}));
 await assert.rejects(()=>f.ai.suggest({productId:f.p.id,productRevision:f.p.revision,variantId:f.p.variants[0].id,ocrResultIds:[]}),(e:any)=>e.code==='PROVIDER_ERROR');
 assert.equal(f.requests.length,1);const original=f.ai.listCalls()[0];
 assert.equal(JSON.parse(String(f.db.prepare('SELECT record_json FROM ai_usage_ledger WHERE id=?').get(original.id)?.record_json)).state,'UNKNOWN');
 for(const errorCode of ['PROVIDER_ERROR','INTERRUPTED','SERVICE_CLOSED','OUTPUT_INVALID','AUTH_FAILED','LEGACY_UNKNOWN']){
  f.db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify({...original,errorCode,...(errorCode==='OUTPUT_INVALID'?{responseReceived:true}:{})}),original.id);
  const before=history(f),preview=f.amazon.previewSalesUnitAdoption({...f.ref,platformPieces:1,basis:'合成按整套确认'});
  assert.equal(preview.canApply,false,errorCode+' without receipt/result is not a known terminal result');
  assert.throws(()=>f.amazon.adoptSalesUnit({...f.ref,platformPieces:1,basis:preview.basis,token:preview.token,confirmed:true}),/原.*请求|未知|核对/);
  assert.equal(history(f),before);assert.equal(f.requests.length,1);
 }
});
test('verified complete response distinguishes received invalid content and definitive rejection from processing errors',async t=>{
 const f=await oldKit(t);f.respond(()=>new Response('{}',{status:500}));await assert.rejects(()=>f.ai.suggest({productId:f.p.id,productRevision:f.p.revision,variantId:f.p.variants[0].id,ocrResultIds:[]}));
 const call=f.ai.listCalls()[0];
 for(const [status,body,errorCode,allowed] of [[401,{error:{code:401,message:'Synthetic authorization denial'}},'AUTH_FAILED',true],[200,{choices:[]},'OUTPUT_INVALID',true],[200,undefined,'OUTPUT_INVALID',false],[200,'[omitted: credential echo]','OUTPUT_INVALID',false],[200,{error:{code:500,message:'Synthetic processed failure'}},'OUTPUT_INVALID',false],[200,{choices:[{error:{code:500}}]},'OUTPUT_INVALID',false],[503,{error:{message:'Synthetic gateway failure'}},'PROVIDER_ERROR',false]] as const){
  const receipt=await saveProviderReceipt(f.db,f.directory,call.id,{gateway:'deepseek',endpoint:'/chat/completions',model:call.model,status,requestId:null,receivedAt:new Date().toISOString(),body,costUsd:null},call.purposeSnapshot);
  f.db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify({...call,errorCode,providerReceiptId:receipt.id}),call.id);
  const before=history(f),preview=f.amazon.previewSalesUnitAdoption({...f.ref,platformPieces:1,basis:'合成按整套确认'});
  assert.equal(preview.canApply,allowed,status+' '+errorCode);assert.equal(history(f),before);assert.equal(f.requests.length,1);
  if(allowed){const path=join(f.directory,receipt.relativePath),bytes=readFileSync(path);writeFileSync(path,Buffer.from('tampered'));
   assert.equal(f.amazon.previewSalesUnitAdoption({...f.ref,platformPieces:1,basis:'合成按整套确认'}).canApply,false,'tampered original response cannot prove certainty');writeFileSync(path,bytes);
   f.db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify({...call,errorCode,providerReceiptId:'0'.repeat(64)}),call.id);
   assert.equal(f.amazon.previewSalesUnitAdoption({...f.ref,platformPieces:1,basis:'合成按整套确认'}).canApply,false,'foreign receipt reference cannot prove certainty');
  }
 }
});
test('known local result remains usable when usage is unknown but an absent or foreign result does not prove completion',async t=>{
 const f=await oldKit(t);f.respond(()=>chat({title:'Filter Support',bullets:['A filter support kit.'],description:'A filter support kit.',attributes:[]}));
 const result=await f.ai.suggest({productId:f.p.id,productRevision:f.p.revision,variantId:f.p.variants[0].id,ocrResultIds:[]}),call=f.ai.listCalls()[0];
 const row=f.db.prepare('SELECT record_json FROM ai_usage_ledger WHERE id=?').get(call.id)!;
 const usage=JSON.parse(String(row.record_json));usage.state='UNKNOWN';usage.usage={promptTokens:0,completionTokens:0,processedImages:0};f.db.prepare('UPDATE ai_usage_ledger SET record_json=? WHERE id=?').run(JSON.stringify(usage),call.id);
 const before=history(f),preview=f.amazon.previewSalesUnitAdoption({...f.ref,platformPieces:1,basis:'合成按整套确认'});
 assert.equal(preview.canApply,true,'unknown usage is not unknown result');assert.equal(history(f),before);
 const legacy={...result};delete legacy.sourceSha256;f.db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify(legacy),result.id);
 assert.equal(f.amazon.previewSalesUnitAdoption({...f.ref,platformPieces:1,basis:'合成按整套确认'}).canApply,true,'strictly owned historical text result without later evidence hash remains known');
 f.db.prepare('DELETE FROM ai_results WHERE id=?').run(result.id);assert.equal(f.amazon.previewSalesUnitAdoption({...f.ref,platformPieces:1,basis:'合成按整套确认'}).canApply,false,'SUCCEEDED label without owned valid result cannot prove domain completion');
 f.db.prepare('INSERT INTO ai_results VALUES(?,?)').run(result.id,JSON.stringify({...result,productId:randomUUID()}));assert.equal(f.amazon.previewSalesUnitAdoption({...f.ref,platformPieces:1,basis:'合成按整套确认'}).canApply,false);
 assert.equal(f.requests.length,1);
});
test('unit preview is read-only and explicit adoption preserves original naming identity, history and quantity authority',async t=>{
 const f=await oldKit(t),before=JSON.stringify(f.persistence.record(f.ref.id));
 const financialHistory=JSON.stringify({calls:f.db.prepare('SELECT * FROM ai_calls').all(),usage:f.db.prepare('SELECT * FROM ai_usage_ledger').all()});
 assert.equal(typeof (f.amazon as any).previewSalesUnitAdoption,'function');
 const initial=f.amazon.previewSalesUnitAdoption(f.ref);
 assert.equal(initial.proposed?.totalCostCny,8.2);assert.equal(initial.proposed?.platformPieces,null);assert.equal(initial.canApply,false);
 assert.equal(JSON.stringify(f.persistence.record(f.ref.id)),before);assert.equal(f.requests.length,0);
 const preview=f.amazon.previewSalesUnitAdoption({...f.ref,platformPieces:1,basis:'人工确认每个完整支架套装作为1个销售商品，50是附件滤网数量'});
 assert.equal(preview.canApply,true);assert.equal(preview.previous.totalPieces,50);assert.equal(preview.proposed?.platformPieces,1);
 const next=f.amazon.adoptSalesUnit({...f.ref,token:preview.token,platformPieces:1,basis:preview.basis,confirmed:true});
 assert.equal(next.sku,f.plan.sku);assert.equal(next.salesPlan?.namingChildKey,f.plan.namingChildKey);assert.equal(next.salesPlan?.recipe.totalCostCny,8.2);
 assert.deepEqual(next.salesPlan?.unitAdoption?.previousRecipe,f.plan.recipe);assert.deepEqual(validateSalesPlan(next.salesPlan),next.salesPlan);
 assertSalesPlanNamingIdentity(f.db,next.salesPlan,next.mode,next.sellerId);
 assert.deepEqual(f.persistence.record(f.ref.id).previewResponse,{history:'keep preview'});assert.equal(f.requests.length,0);
 assert.equal((next.attributes.number_of_items as any)[0].value,1);
 const context=buildListingContext(next,f.p,0);assert.ok(context.evidence.some(e=>e.name==='销售件数'&&e.value==='1'));
 assert.ok(context.evidence.some(e=>e.name==='销售计量说明'&&e.value.includes('过滤网×50')));
 assert.equal(f.db.prepare("SELECT count(*) n FROM audit_events WHERE action='listing.sales-units.adopted'").get()?.n,1);
 assert.equal(JSON.stringify({calls:f.db.prepare('SELECT * FROM ai_calls').all(),usage:f.db.prepare('SELECT * FROM ai_usage_ledger').all()}),financialHistory);
 assert.throws(()=>f.amazon.adoptSalesUnit({...f.ref,token:preview.token,platformPieces:1,basis:preview.basis,confirmed:true}),/版本|更新/);
});
test('unit adoption refuses absent authorization, stale source, unknown or submitted state without touching historical recipe',async t=>{
 const f=await oldKit(t);assert.equal(typeof (f.amazon as any).previewSalesUnitAdoption,'function');
 const p=f.amazon.previewSalesUnitAdoption({...f.ref,platformPieces:1,basis:'人工按整套确认'}),input={...f.ref,token:p.token,platformPieces:1,basis:p.basis,confirmed:true};
 const before=JSON.stringify(f.persistence.record(f.ref.id));
 assert.throws(()=>f.amazon.adoptSalesUnit({...input,confirmed:false}),/明确|确认|授权/);assert.equal(JSON.stringify(f.persistence.record(f.ref.id)),before);
 for(const state of ['UNKNOWN','SUBMITTED','SUBMITTING']){const r=f.persistence.record(f.ref.id);r.draft.state=state;f.persistence.putRecord(r);const snapshot=JSON.stringify(f.persistence.record(f.ref.id));assert.throws(()=>f.amazon.adoptSalesUnit(input),/未知|提交|进行/);assert.equal(JSON.stringify(f.persistence.record(f.ref.id)),snapshot);}
 const r=f.persistence.record(f.ref.id);r.draft.state='DRAFT';f.persistence.putRecord(r);
 f.store.saveProduct({...saveInput(f.p),title:'后来未采用的新标题'});const snapshot=JSON.stringify(f.persistence.record(f.ref.id));assert.throws(()=>f.amazon.adoptSalesUnit(input),/来源|资料|变化/);assert.equal(JSON.stringify(f.persistence.record(f.ref.id)),snapshot);assert.equal(f.requests.length,0);
});
test('borrowed owner transaction rolls back adopted draft and audit when its second step fails',async t=>{
 const f=await oldKit(t),db=openDatabase(f.directory),preview=f.amazon.previewSalesUnitAdoption({...f.ref,platformPieces:1,basis:'按原整套确认平台件数'}),before=JSON.stringify(f.persistence.record(f.ref.id));
 try{
  db.exec('BEGIN IMMEDIATE');const next=f.amazon.applySalesUnitAdoption({...f.ref,platformPieces:1,basis:preview.basis},preview.token,db);
  assert.equal(next.salesPlan?.recipe.quantityVersion,2);assert.equal(JSON.parse(String(db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(f.ref.id)?.record_json)).draft.salesPlan.recipe.quantityVersion,2);
  assert.equal(db.prepare("SELECT count(*) n FROM audit_events WHERE action='listing.sales-units.adopted'").get()?.n,1);
  assert.throws(()=>db.exec('INSERT INTO deliberately_missing_second_owner_step VALUES(1)'),/no such table/);db.exec('ROLLBACK');
  assert.equal(JSON.stringify(f.persistence.record(f.ref.id)),before);assert.equal(db.prepare("SELECT count(*) n FROM audit_events WHERE action='listing.sales-units.adopted'").get()?.n,0);assert.equal(f.requests.length,0);
 }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}
});
test('putRecord cannot borrow a different in-memory database merely because both file paths are empty',()=>{
 const own=new DatabaseSync(':memory:'),other=new DatabaseSync(':memory:'),p=Object.create(AmazonPersistence.prototype) as AmazonPersistence;p.db=own;
 try{other.exec('BEGIN IMMEDIATE');assert.throws(()=>p.putRecord({} as any,other),/内存|连接|工作区/);other.exec('ROLLBACK');assert.throws(()=>p.putRecord({} as any,other),/同步事务/);}finally{own.close();other.close();}
});
test('copy evidence uses the explicitly adopted platform count and never promotes pending kit units to pieces',async t=>{
 const f=await oldKit(t),preview=f.amazon.previewSalesUnitAdoption({...f.ref,platformPieces:52,basis:'合成测试明确采用平台52件口径，未作为业务默认'});
 const next=f.amazon.adoptSalesUnit({...f.ref,platformPieces:52,basis:preview.basis,token:preview.token,confirmed:true});
 const legacy=buildListingContext(next,f.p,0,true);assert.equal(legacy.evidence.find(e=>e.id.endsWith(':sale-count'))?.value,'52 pieces');
 const full=buildListingContext(next,f.p,0);assert.equal((full.sourceProduct?.salesRecipe as any)?.unitAdoption,undefined,'historical erroneous recipe is audit data, not current copy evidence');
});

test('task-owned unit adoption commits draft and original row identity together, then updates memory without resuming',async t=>{
 const f=await taskKit(t);try{
  const row=f.task.items[0],request={taskId:f.task.id,taskRevision:f.task.revision,itemKey:row.key,platformPieces:1,basis:'合成按整套确认'},before=history(f);
  const preview=(f.owner as any).previewSalesUnitAdoption(request);assert.equal(preview.unitPreview.canApply,true);assert.equal(history(f),before);
  const next=(f.owner as any).adoptSalesUnit({...request,token:preview.token,confirmed:true});
  assert.equal(next.status,'PAUSED');assert.equal(next.revision,f.task.revision+1);assert.equal(next.items[0].key,row.key);assert.equal(next.items[0].sku,row.sku);assert.equal(next.items[0].salesPlan.namingChildKey,f.plan.namingChildKey);assert.equal(next.items[0].salesPlan.recipe.quantityVersion,2);
  assert.deepEqual(f.owner.get(f.task.id),next);assert.deepEqual(validateAutomaticListingTask(next),next);assert.equal(f.amazon.getDraft(f.ref.id).salesPlan?.recipe.key,next.items[0].salesPlan.recipe.key);assert.equal(f.requests.length,0);
  const reopened=new AutomaticListingService(f.directory,f.deps);try{assert.deepEqual(reopened.get(next.id),next);}finally{await reopened.close();}
 }finally{await f.owner.close();}
});
test('task-owner unit adoption rolls back draft, task, audit and memory if the task checkpoint fails',async t=>{
 const f=await taskKit(t);try{
  const request={taskId:f.task.id,taskRevision:f.task.revision,itemKey:f.task.items[0].key,platformPieces:1,basis:'合成按整套确认'},preview=(f.owner as any).previewSalesUnitAdoption(request),before=history(f),beforeTask=JSON.stringify(f.owner.get(f.task.id));
  (f.owner as any).db.exec("CREATE TEMP TRIGGER fail_unit_task BEFORE UPDATE ON automatic_listing_tasks BEGIN SELECT RAISE(ABORT,'unit task checkpoint failure'); END");
  assert.throws(()=>(f.owner as any).adoptSalesUnit({...request,token:preview.token,confirmed:true}),/unit task checkpoint failure/);
  assert.equal(history(f),before);assert.equal(JSON.stringify(f.owner.get(f.task.id)),beforeTask);assert.equal(f.db.prepare("SELECT count(*) n FROM audit_events WHERE action='listing.sales-units.adopted'").get()?.n,0);assert.equal(f.requests.length,0);
 }finally{await f.owner.close();}
});
test('planning reads original task-only unit identities before allocating a replacement SKU',async t=>{
 const f=await taskKit(t),naming=new SkuNamingService(f.directory);try{
  const task=(f.owner as any).tasks.get(f.task.id);task.items[0].draftId=null;(f.owner as any).save(task);
  const before=JSON.stringify(f.db.prepare('SELECT * FROM sku_naming_identities').all()),target=f.amazon.getTarget(f.task.targetId);
  const options={existingPlans:()=>[{productId:f.p.id,targetId:target.id,sellerId:target.sellerId,marketplaceId:target.marketplaceId,mode:target.mode,plan:f.plan}]};
  assert.throws(()=>(planSalesListings as any)(f.p,null,target,readListingRules(f.db),naming,options),/原.*单位|计量|套装/);
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM sku_naming_identities').all()),before);assert.equal(f.requests.length,0);
  assert.equal((f.owner as any).readSalesPlans(f.p.id,target.id)[0].plan.sku,f.plan.sku,'Task owner exposes persisted identity even without a draft');
 }finally{naming.close();await f.owner.close();}
});
test('explicit unit adoption resolves only its original adaptation unit blocker with retained audit proof',async t=>{
 const f=await taskKit(t);try{
  const checked=f.owner.previewAdaptation(f.task.id),adapted=f.owner.applyAdaptation({taskId:f.task.id,token:checked.token});
  assert.deepEqual(adapted.adaptation?.blockedKeys,[f.task.items[0].key]);
  const request={taskId:adapted.id,taskRevision:adapted.revision,itemKey:adapted.items[0].key,platformPieces:1,basis:'合成原套销售单位明确确认'},preview=f.owner.previewSalesUnitAdoption(request);
  const next=f.owner.adoptSalesUnit({...request,token:preview.token,confirmed:true});
  assert.deepEqual(next.adaptation?.blockedKeys,adapted.adaptation?.blockedKeys);assert.equal(next.adaptation?.token,adapted.adaptation?.token);assert.deepEqual((next.adaptation as any)?.unitResolvedKeys,[request.itemKey]);
  assertTaskAdaptationHistory(f.db,next);
  const adopted=f.db.prepare("SELECT id,detail_json FROM audit_events WHERE action='automatic-listing.sales-units.adopted'").get()!,proof=JSON.parse(String(adopted.detail_json));
  f.db.prepare('UPDATE audit_events SET detail_json=? WHERE id=?').run(JSON.stringify({...proof,afterPlan:{...proof.afterPlan,sku:'FOREIGN-SKU'}}),adopted.id);assert.throws(()=>assertTaskAdaptationHistory(f.db,next),/计量解除|身份/);
  f.db.prepare('UPDATE audit_events SET detail_json=? WHERE id=?').run(adopted.detail_json,adopted.id);
  const original=f.db.prepare("SELECT id,detail_json FROM audit_events WHERE action='automatic-listing.adapted'").get()!,adaptProof=JSON.parse(String(original.detail_json));
  adaptProof.changes.push({...adaptProof.changes[0],kind:'BLOCKED',steps:['图片依赖'],fields:[]});f.db.prepare('UPDATE audit_events SET detail_json=? WHERE id=?').run(JSON.stringify(adaptProof),original.id);
  assert.throws(()=>assertTaskAdaptationHistory(f.db,next),/历史|计量|阻断/);f.db.prepare('UPDATE audit_events SET detail_json=? WHERE id=?').run(original.detail_json,original.id);
  const restart=new AutomaticListingService(f.directory,f.deps);try{assert.deepEqual(restart.get(next.id),next);}finally{await restart.close();}
  f.db.prepare("DELETE FROM audit_events WHERE action='automatic-listing.sales-units.adopted'").run();assert.throws(()=>new AutomaticListingService(f.directory,f.deps),/证明/);
  assert.equal(f.requests.length,0);
 }finally{await f.owner.close();}
});
test('unit owner refuses unsafe task status, in-flight pause and stale preview without mutating the original draft',async t=>{
 const f=await taskKit(t);try{
  const request=()=>({taskId:f.task.id,taskRevision:f.owner.get(f.task.id).revision,itemKey:f.task.items[0].key,platformPieces:1,basis:'合成按整套确认'}),before=JSON.stringify(f.amazon.getDraft(f.ref.id));
  for(const state of ['CREATED','QUEUED','RUNNING','WAITING','COMPLETED','CANCELLED']){const task=(f.owner as any).tasks.get(f.task.id);task.status=state;task.items[0].status=state==='COMPLETED'?'DONE':'FAILED';task.items[0].stage=state==='COMPLETED'?'COMPLETE':'DRAFT';(f.owner as any).save(task);assert.throws(()=>f.owner.previewSalesUnitAdoption(request()),/暂停/);assert.equal(JSON.stringify(f.amazon.getDraft(f.ref.id)),before);}
  const task=(f.owner as any).tasks.get(f.task.id);task.status='PAUSED';(f.owner as any).save(task);(f.owner as any).activeId=task.id;assert.throws(()=>f.owner.previewSalesUnitAdoption(request()),/暂停/);(f.owner as any).activeId=null;
  const input=request(),preview=f.owner.previewSalesUnitAdoption(input);task.error='其他本地检查点更新';(f.owner as any).save(task);assert.throws(()=>f.owner.adoptSalesUnit({...input,token:preview.token,confirmed:true}),/变化|检查点/);assert.equal(JSON.stringify(f.amazon.getDraft(f.ref.id)),before);assert.equal(f.requests.length,0);
 }finally{await f.owner.close();}
});

test('planning reuses adopted original SKU and confirmed count, while an unrelated new variant remains eligible',async t=>{
 const f=await oldKit(t),naming=new SkuNamingService(f.directory);try{
  const p=f.amazon.previewSalesUnitAdoption({...f.ref,platformPieces:52,basis:'Synthetic explicitly verified platform count'}),adopted=f.amazon.adoptSalesUnit({...f.ref,platformPieces:52,basis:p.basis,token:p.token,confirmed:true}),target=f.amazon.getTarget(adopted.targetId),plan=adopted.salesPlan!;
  const port={existingPlans:()=>f.amazon.readSalesPlans(f.p.id,target.id)},before=JSON.stringify(f.db.prepare('SELECT * FROM sku_naming_identities').all());
  const planned=planSalesListings(f.p,null,target,readListingRules(f.db),naming,port);assert.equal(planned.length,1);assert.deepEqual(planned[0],plan);assert.equal(planned[0].recipe.platformPieces,52);assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM sku_naming_identities').all()),before);
  const product={...f.p,variants:[...f.p.variants,{...f.p.variants[0],id:randomUUID(),sku:'SOURCE-ORDINARY-NEW',originalSpec:'蓝色 20 pc',normalizedSpec:'Blue 20pc'}]};
  const withNew=planSalesListings(product,null,target,readListingRules(f.db),naming,port);assert.ok(withNew.some(row=>row.sku===plan.sku&&row.recipe.platformPieces===52));assert.ok(withNew.some(row=>row.recipe.components.some(c=>c.sourceSku==='SOURCE-ORDINARY-NEW')&&row.sku!==plan.sku));assert.equal(f.requests.length,0);
 }finally{naming.close();}
});

async function oldMixedTaskPlanning(t:test.TestContext,ordinary=false){
 const f=await taskKit(t);await f.owner.close();
 const original=saveInput(f.p),product=f.store.saveProduct({...original,title:ordinary?'Ordinary Clips':f.p.title,variants:[...original.variants.map(v=>({...v,originalSpec:ordinary?'黄色 50pc':v.originalSpec})),{...original.variants[0],id:randomUUID(),sku:'SOURCE-SECOND-KIT',originalSpec:ordinary?'蓝色 50pc':'米色 / 支架+贴片+50只过滤网',normalizedSpec:''}]});
 const components=product.variants.map(v=>({...f.plan.recipe.components[0],variantId:v.id,sourceKey:v.id,sourceSku:v.sku,specification:v.originalSpec,quantity:5})),key=createHash('sha256').update(JSON.stringify([...components].sort((a,b)=>a.sourceKey.localeCompare(b.sourceKey)).map(c=>[c.sourceKey,c.quantity]))).digest('hex');
 const naming=new SkuNamingService(f.directory),target=f.amazon.getTarget(f.task.targetId),group=naming.allocate({storeScope:JSON.stringify([target.mode,target.sellerId]),storeCode:'U2',sourceGroupKey:f.plan.sourceGroupKey,collectedAt:f.plan.collectedAt,childKeys:[key]});
 const plan=validateSalesPlan({...f.plan,sku:group.children.find(child=>child.key===key)!.sku,namingChildKey:key,recipe:{...f.plan.recipe,key,specification:'历史错误混色10pc',color:'Mixed colors',components,totalPieces:10,totalCostCny:1.64}});
 const task=structuredClone(f.task);Object.assign(task.items[0],{key:product.id+':'+key,sku:plan.sku,salesPlan:plan,draftId:null,productRevision:product.revision,sourceStamp:sourceStamp(product)});f.db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(validateAutomaticListingTask(task)),task.id);
 const owner=new AutomaticListingService(f.directory,f.deps),port={existingPlans:()=>owner.readSalesPlans(product.id,target.id)},ledger=()=>JSON.stringify(['sku_naming_groups','sku_naming_identities','sku_naming_sequences'].map(table=>f.db.prepare('SELECT * FROM '+table).all()));
 return{...f,product,plan,task,owner,naming,target,port,ledger};
}
test('planning rejects exact source overlap with an unresolved original mixed-kit task before any SKU allocation',async t=>{
 const f=await oldMixedTaskPlanning(t);try{
  const before=f.ledger(),original=f.db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(f.task.id)!.record_json;
  assert.equal(f.port.existingPlans().length,1);assert.equal(f.port.existingPlans()[0].plan.recipe.totalCostCny,1.64);
  assert.throws(()=>planSalesListings(f.product,null,f.target,readListingRules(f.db),f.naming,f.port),/原.*单位|计量|套装/);
  assert.equal(f.ledger(),before);assert.equal(f.db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(f.task.id)!.record_json,original);assert.equal(f.requests.length,0);
 }finally{f.naming.close();await f.owner.close();}
});
test('unresolved mixed-kit history does not block completely disjoint ordinary variants or another owner scope',async t=>{
 const f=await oldMixedTaskPlanning(t);try{
  const ordinary={...f.product,title:'Ordinary Clip',variants:[{...f.product.variants[0],id:randomUUID(),sku:'SOURCE-DISJOINT-NEW',originalSpec:'蓝色 20 pc',normalizedSpec:'Blue 20pc'}]};
  assert.ok(planSalesListings(ordinary,null,f.target,readListingRules(f.db),f.naming,f.port).length>0);
  for(const field of ['productId','targetId','sellerId','marketplaceId','mode'] as const){const prior=f.port.existingPlans()[0],outside={...prior,[field]:field==='mode'?'live':randomUUID()};assert.ok(planSalesListings(f.product,null,f.target,readListingRules(f.db),f.naming,{existingPlans:()=>[outside]}).length>0,field+' owner must not block another scope');}
  assert.equal(f.requests.length,0);
 }finally{f.naming.close();await f.owner.close();}
});
test('ordinary proven homogeneous old mixed recipe remains eligible when its new recipes share sources',async t=>{
 const f=await oldMixedTaskPlanning(t,true);try{
  const rows=planSalesListings(f.product,null,f.target,readListingRules(f.db),f.naming,f.port);assert.ok(rows.length>0);assert.equal(f.requests.length,0);
 }finally{f.naming.close();await f.owner.close();}
});
