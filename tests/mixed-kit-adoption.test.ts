import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { fixture,saveInput,chat } from './fixtures/listing-ai.ts';
import { saveProviderReceipt } from '../src/main/ai/receipts.ts';
import { writeFileSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SkuNamingService } from '../src/main/sku-naming/service.ts';
import { realAmazonSchema } from './fixtures/amazon/schema-fixture.ts';
import { defaultListingRules } from '../src/shared/listing-rules.ts';
import { applyBusinessRules } from '../src/main/amazon/business-rules.ts';
import { openDatabase } from '../src/main/database.ts';
import { assertSalesPlanNamingIdentity } from '../src/main/sales-plans/history.ts';
import { validateSalesPlan } from '../src/main/sales-plans/records.ts';
import { buildListingContext } from '../src/main/listing-ai/context.ts';
import { AmazonPersistence } from '../src/main/amazon/persistence.ts';
import { DatabaseSync } from 'node:sqlite';

async function oldKit(t:any){
 const f=await fixture(t),p=f.store.saveProduct({...saveInput(f.product),title:'过滤网支架',facts:[...f.product.facts,{id:randomUUID(),name:'采购币种',value:'CNY',state:'human_confirmed',source:'manual',sourceRef:'fixture'}],variants:saveInput(f.product).variants.map(v=>({...v,normalizedSpec:'',originalSpec:'黄色 / 支架+贴片+50只过滤网',purchasePrice:'8.2'}))});
 const v=p.variants[0],c={variantId:v.id,sourceKey:v.id,sourceSku:v.sku,specification:v.originalSpec,color:'Yellow',quantity:50,quotedCostCny:8.2,piecesPerQuote:50,sourcePackPieces:50};
 const key=createHash('sha256').update(JSON.stringify([[v.id,50]])).digest('hex'),recipe={key,groupKey:'a'.repeat(64),specification:v.originalSpec+' · 50 pc',color:'Yellow',components:[c],totalPieces:50,totalCostCny:8.2};
 const naming=new SkuNamingService(f.directory),target=f.amazon.listTargets()[0],sourceGroupKey=`local:${p.id}:${recipe.groupKey}`;
 const group=naming.allocate({storeScope:JSON.stringify([target.mode,target.sellerId]),storeCode:'U2',sourceGroupKey,collectedAt:p.createdAt,childKeys:[key]});naming.close();
 const plan={namingGroupId:group.id,sourceGroupKey,collectedAt:group.collectedAt,collectionBasis:'first_import' as const,sku:group.children[0].sku,baseSku:group.baseSku,recipe,parentage:'NONE' as const,parentSku:null,variationTheme:null,relationReason:'历史独立套装',familyResolved:true,namingChildKey:key};
 const db=openDatabase(f.directory),rules=defaultListingRules();rules.pricing.maxPrice=100;rules.pricing.promoEnabled=false;db.prepare('INSERT OR REPLACE INTO amazon_settings VALUES(?,?)').run('listing_rules_v1',JSON.stringify(rules));
 const schema={...realAmazonSchema(),...{targetId:target.id,mode:target.mode,key:f.draft.schema.key}},normal={...p,title:'普通夹子',variants:[{...v,originalSpec:'50 pc'}]};
 const result=applyBusinessRules({product:normal,variant:normal.variants[0],target,schema,attributes:{},measurements:{},costCny:8.2,saleUnit:{...recipe,components:[{...c,specification:'50pc'}]},packageMatchesSaleUnit:true,now:new Date()},rules);
 const persistence=(f.amazon as any).persistence,r=persistence.record(f.draft.id);Object.assign(r.draft,{productRevision:p.revision,sku:plan.sku,salesPlan:plan,listingProgram:'haul',schema,attributes:result.attributes,businessRules:result.report});r.previewResponse={history:'keep preview'};persistence.putRecord(r);
 db.close();return {...f,p,plan,db:persistence.db,persistence,ref:{id:r.draft.id,revision:r.draft.revision}};
}
const history=(f:Awaited<ReturnType<typeof oldKit>>)=>JSON.stringify({draft:f.persistence.record(f.ref.id),calls:f.db.prepare('SELECT * FROM ai_calls').all(),usage:f.db.prepare('SELECT * FROM ai_usage_ledger').all(),receipts:f.db.prepare('SELECT * FROM ai_provider_receipts').all(),results:f.db.prepare('SELECT * FROM ai_results').all()});
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
 for(const [status,body,errorCode,allowed] of [[401,{error:{code:401,message:'Synthetic authorization denial'}},'AUTH_FAILED',true],[200,{choices:[]},'OUTPUT_INVALID',true],[200,{error:{code:500,message:'Synthetic processed failure'}},'OUTPUT_INVALID',false],[200,{choices:[{error:{code:500}}]},'OUTPUT_INVALID',false],[503,{error:{message:'Synthetic gateway failure'}},'PROVIDER_ERROR',false]] as const){
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
