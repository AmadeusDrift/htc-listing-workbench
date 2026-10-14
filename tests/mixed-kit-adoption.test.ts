import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { fixture,saveInput } from './fixtures/listing-ai.ts';
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
test('unit preview is read-only and explicit adoption preserves original naming identity, history and quantity authority',async t=>{
 const f=await oldKit(t),before=JSON.stringify(f.persistence.record(f.ref.id));
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
