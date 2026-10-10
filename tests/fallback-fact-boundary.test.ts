import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { applyBusinessRules, ruleSourceMapping } from '../src/main/amazon/business-rules.ts';
import { sourceMappingReport, demoSchema } from '../src/main/amazon/demo.ts';
import { defaultListingRules } from '../src/shared/listing-rules.ts';
import { realAmazonSchema } from './fixtures/amazon/schema-fixture.ts';
import { pricingEvidenceCurrent, pricingOutcome } from '../src/main/automatic-listing/outcomes.ts';
import { WorkspaceStore } from '../src/main/store.ts';
import { AmazonService } from '../src/main/amazon/service.ts';
import { saveInput, mockStorage, fixture as aiFixture } from './fixtures/listing-ai.ts';
import type { ProductDetail, Variant, Fact } from '../src/shared/contracts.ts';
import type { AmazonDraft, AmazonTarget, JsonObject, SchemaSelection, ListingProgram } from '../src/shared/amazon-contracts.ts';
import type { AmazonPersistence } from '../src/main/amazon/persistence.ts';
import { currentFactAuthority } from '../src/main/amazon/fact-authority.ts';
import { isMissingOnlyPreview } from '../src/main/amazon/preview-validation.ts';
import { listingHash } from '../src/main/amazon/context.ts';
import { validateAttributes } from '../src/main/amazon/schema.ts';
import { imageListingSnapshot, assertImageMeasurements } from '../src/main/image-workflow/image-facts.ts';
import { buildListingContext } from '../src/main/listing-ai/context.ts';
import { assertPricingDecision } from '../src/main/listing-ai/history.ts';

const variant={id:'v',sku:'FALLBACK-SKU',originalSpec:'Plain',sourceSpec:'Plain',normalizedSpec:'',purchasePrice:'2.4',sourcePurchasePrice:'2.4',inventory:null} as Variant;
const product={id:'p',title:'Plain',description:'',facts:[],variants:[variant]} as unknown as ProductDetail;
const target={id:'t',name:'U8',marketplaceId:'ATVPDKIKX0DER',mode:'demo'} as AmazonTarget;
const rules=defaultListingRules();
const fact=(name:string,value:string,state:Fact['state']='human_confirmed'):Fact=>({id:randomUUID(),name,value,state,source:'manual',sourceRef:'Synthetic confirmed fact'});
const run=(extra:Partial<Parameters<typeof applyBusinessRules>[0]>={})=>applyBusinessRules({product,variant,target,schema:realAmazonSchema(),attributes:{},measurements:{},costCny:2.4,now:new Date('2026-10-10T00:00:00Z'),...extra},rules);

test('Haul default estimates quote privately without inventing product claims',()=>{
  const result=run();
  for(const field of ['brand','manufacturer','country_of_origin','import_designation','gpsr_safety_attestation','batteries_required','supplier_declared_dg_hz_regulation','required_product_compliance_certificate','item_dimensions','item_package_dimensions','item_package_weight'])assert.equal(result.attributes[field],undefined,field);
  assert.ok(result.report.quote);assert.deepEqual(result.report.pricingDecision?.inputs,{costCny:2.4,dimensionsInches:[1.97,1.97,1.97],weightPounds:.22});
  assert.equal(result.report.pricingDecision?.version,2);
  assert.deepEqual((result.report.pricingDecision as any).attributeInputs,{});

});

test('existing partial measurements are preserved while their missing axes are only estimated',()=>{
  const attributes={item_package_dimensions:[{length:{value:9,unit:'inches'},marketplace_id:target.marketplaceId}]};
  const result=run({attributes});assert.deepEqual(result.attributes.item_package_dimensions,attributes.item_package_dimensions);
  assert.deepEqual((result.report.pricingDecision as any).attributeInputs,attributes);
  assert.deepEqual(result.report.pricingDecision?.inputs.dimensionsInches,[9,1.97,1.97]);
});

test('v2 successful estimates retain a precise current attribute snapshot',()=>{
  const result=run(),draft={attributes:result.attributes,businessRules:result.report,marketplaceId:target.marketplaceId,schema:realAmazonSchema()} as AmazonDraft;
  assert.equal(pricingEvidenceCurrent(draft,rules),true);
  draft.attributes.item_package_dimensions=[{length:{value:1.970001,unit:'inches'}}];
  assert.equal(pricingEvidenceCurrent(draft,rules),false);
  assert.deepEqual(pricingOutcome(draft,rules),{kind:'NEEDS_INPUT',code:'PRICING_EVIDENCE_STALE'});
});

test('supported partial source axes retain actual IDs without sibling measurements',()=>{
  const length=fact('包装长度','5 cm'),p={...product,facts:[length]},attributes={item_package_dimensions:[{length:{value:1.97,unit:'inches'},marketplace_id:target.marketplaceId}]};
  const mapping=sourceMappingReport(p,variant,realAmazonSchema(),target,'haul',attributes).find(m=>m.field==='item_package_dimensions')!;
  assert.deepEqual(mapping.sourceFactIds,[length.id]);
});

test('native precision is not validated through rounded inches',()=>{
  const schema=realAmazonSchema(),properties=schema.schema.properties as JsonObject;
  const raw=properties.item_package_dimensions as any;raw.items.properties.length.properties.unit.enum=['inches','cm'];
  const length=fact('包装长度','5.000001 cm'),p={...product,facts:[length]},attributes={item_package_dimensions:[{length:{value:5.000002,unit:'cm'}}]};
  const mapping=sourceMappingReport(p,variant,schema,target,'haul',attributes).find(m=>m.field==='item_package_dimensions')!;
  assert.equal(mapping.status,'needs_input');assert.deepEqual(mapping.sourceFactIds,[]);
});

test('unknown protected fields and unsupported measurement shapes fail with exact authority issues',()=>{
  const schema=realAmazonSchema();delete (schema.schema.properties as JsonObject).item_package_dimensions;
  const attributes={item_package_dimensions:[{length:{value:1.97,unit:'inches'}}]};
  assert.deepEqual(currentFactAuthority(product,schema,target,attributes).issues.map(i=>[i.code,i.attributeNames]),[['FACT_AUTHORITY_REQUIRED',['item_package_dimensions']]]);
  const unsupported=realAmazonSchema();(unsupported.schema.properties as any).item_package_dimensions.items.properties.length={type:'object',properties:{value:{type:'number'}}};
  assert.equal(currentFactAuthority({...product,facts:[fact('包装长度','5 cm')]},unsupported,target,attributes).issues[0].code,'FACT_AUTHORITY_REQUIRED');
});

test('native measurement disagreement cannot become a reliable ROI rejection through ROUND2',()=>{
  const schema=realAmazonSchema();for(const axis of ['length','width','height'])(schema.schema.properties as any).item_package_dimensions.items.properties[axis].properties.unit.enum=['inches','cm'];
  const p={...product,facts:[fact('包装长度','5.000001 cm'),fact('包装宽度','5 cm'),fact('包装高度','5 cm'),fact('包装重量','100 g')]};
  const attributes={item_package_dimensions:[{length:{value:5.000002,unit:'cm'},width:{value:5,unit:'cm'},height:{value:5,unit:'cm'},marketplace_id:target.marketplaceId}]};
  const result=run({schema,product:p,attributes,costCny:999});assert.equal(result.report.pricingDecision?.status,'needs_input');assert.equal(result.report.pricingDecision?.evidence.dimensions,'unverified');
});

test('same-valued real facts win over historical business labels and preserve their source IDs',()=>{
  const schema=realAmazonSchema();(schema.schema.properties as JsonObject).import_designation={type:'array',items:{type:'object',properties:{value:{enum:['Imported']},marketplace_id:{type:'string'}},required:['value']}};
  const facts=[fact('品牌','无品牌'),fact('原产国','CN'),fact('包装长度','5 cm'),fact('包装宽度','5 cm'),fact('包装高度','5 cm'),fact('包装重量','100 g')],p={...product,facts};
  const result=run({product:p,schema}),historical={...result.report,fields:Object.fromEntries(Object.entries(result.attributes).map(([name,value])=>[name,{value,reason:'业务默认；historical only'}]))};
  const mapping=ruleSourceMapping(sourceMappingReport(p,variant,schema,target,'haul',result.attributes),historical,result.attributes);
  for(const [field,names] of [['country_of_origin',['原产国']],['item_package_dimensions',['包装长度','包装宽度','包装高度']],['item_package_weight',['包装重量']]] as const)
    assert.deepEqual(mapping.find(m=>m.field===field)!.sourceFactIds.sort(),facts.filter(f=>names.includes(f.name as never)).map(f=>f.id).sort());
  assert.equal((result.attributes.brand as any)[0].value,'Generic');assert.equal((result.attributes.import_designation as any)[0].value,'Imported');
  assert.deepEqual(currentFactAuthority(p,schema,target,result.attributes).issues,[]);
  const changed={...p,facts:[...facts,fact('原产国','JP','conflicting')]};
  assert.ok(currentFactAuthority(changed,schema,target,result.attributes).issues.some(i=>i.code==='FACT_SOURCE_CONFLICT'&&i.attributeNames.includes('country_of_origin')));
});

test('each present axis needs evidence while missing siblings remain schema responsibilities',()=>{
  const length=fact('包装长度','5 cm'),width=fact('包装宽度','5 cm'),height=fact('包装高度','5 cm');
  const attrs={item_package_dimensions:[{length:{value:1.97,unit:'inches'}}]};
  for(const facts of [[length],[length,width,height]]){
    const authority=currentFactAuthority({...product,facts},realAmazonSchema(),target,attrs);
    assert.deepEqual(authority.issues,[]);assert.deepEqual(authority.fields.get('item_package_dimensions')!.sourceFactIds,[length.id]);
  }
  const mixed={item_package_dimensions:[{...attrs.item_package_dimensions[0],width:{value:1.97,unit:'inches'}}]};
  const unsupported=currentFactAuthority({...product,facts:[length]},realAmazonSchema(),target,mixed);
  assert.deepEqual(unsupported.fields.get('item_package_dimensions')!.unsupported,['width']);assert.deepEqual(unsupported.fields.get('item_package_dimensions')!.sourceFactIds,[length.id]);
  const conflicting=currentFactAuthority({...product,facts:[length,{...width,state:'conflicting'}]},realAmazonSchema(),target,mixed);
  assert.equal(conflicting.issues[0].code,'FACT_SOURCE_CONFLICT');assert.deepEqual(conflicting.fields.get('item_package_dimensions')!.sourceFactIds,[length.id]);
});

test('depth alias is one-way; explicit invalid depth and unmeasured thickness cannot borrow length',()=>{
  const schema=realAmazonSchema(),properties=schema.schema.properties as JsonObject,scalar={type:'array',items:{type:'object',properties:{value:{type:'number'},unit:{enum:['inches','cm']}}}};
  properties.item_depth=scalar;properties.item_thickness=scalar;properties.item_length=scalar;
  const length=fact('商品长度','5 cm'),attributes={item_depth:[{value:1.97,unit:'inches'}]};
  assert.deepEqual(currentFactAuthority({...product,facts:[length]},schema,target,attributes).fields.get('item_depth')!.sourceFactIds,[length.id]);
  for(const state of ['human_confirmed','conflicting'] as const){const result=currentFactAuthority({...product,facts:[length,fact('商品深度',state==='conflicting'?'5 cm':'invalid',state)]},schema,target,attributes);assert.equal(result.issues.length,1);assert.deepEqual(result.fields.get('item_depth')!.sourceFactIds,[]);}
  assert.equal(currentFactAuthority({...product,facts:[length]},schema,target,{item_thickness:attributes.item_depth}).issues.length,1);
  assert.equal(currentFactAuthority({...product,facts:[fact('商品深度','5 cm')]},schema,target,{item_length:attributes.item_depth}).issues.length,1);
});

test('multiple SKUs need exact receipt measurements; product facts never stand in for a sibling',()=>{
  const p={...product,variants:[variant,{...variant,id:'other'}],facts:[fact('包装长度','5 cm')]},attrs={item_package_dimensions:[{length:{value:1.97,unit:'inches'}}]};
  assert.equal(currentFactAuthority(p,realAmazonSchema(),target,attrs).issues.length,1);
  const exact=currentFactAuthority(p,realAmazonSchema(),target,attrs,{package:{length:{value:5,unit:'cm'}}});assert.deepEqual(exact.issues,[]);assert.deepEqual(exact.fields.get('item_package_dimensions')!.sourceFactIds,[]);
  assert.equal(currentFactAuthority(p,realAmazonSchema(),target,attrs,{package:{length:{value:6,unit:'cm'}}}).issues.length,1);
});

test('v2 snapshots distinguish absent, null, partial, unit, precision and array ordering; v1 parser stays exact',()=>{
  const result=run(),draft={listingProgram:'haul',attributes:result.attributes,businessRules:result.report,marketplaceId:target.marketplaceId,schema:realAmazonSchema()} as AmazonDraft;
  assert.doesNotThrow(()=>assertPricingDecision(result.report,draft));
  for(const value of [null,[],[{length:{value:1.97001,unit:'inches'}}],[{length:{value:5,unit:'cm'}}]]){
    const changed=structuredClone(draft);changed.attributes.item_package_dimensions=value;assert.equal(pricingEvidenceCurrent(changed,rules),false);
  }
  for(const mutation of ['missing','extra','version','undefined','nonfinite'] as const){
    const report=structuredClone(result.report),d=report.pricingDecision as any;
    if(mutation==='missing')delete d.attributeInputs;if(mutation==='extra')d.attributeInputs.brand=[];if(mutation==='version')d.version=3;if(mutation==='undefined')d.attributeInputs.item_package_weight=undefined;if(mutation==='nonfinite')d.attributeInputs.item_package_weight=NaN;
    assert.throws(()=>assertPricingDecision(report,draft),mutation);
  }
  const legacy={revision:0,fields:{},notices:[],quote:null,bundleQuantity:1,pricingDecision:{version:1,status:'needs_input',code:'COST_CNY_UNCONFIRMED',quoteError:null,inputs:{costCny:null,dimensionsInches:null,weightPounds:null},evidence:{cost:'unconfirmed',dimensions:'missing',weight:'missing',packageScope:'unconfirmed',saleUnit:'confirmed',sourcePackage:{dimensionsInches:null,weightPounds:null}}}} as const;
  const bytes=JSON.stringify(legacy);assert.doesNotThrow(()=>assertPricingDecision(legacy as any,draft));assert.equal(JSON.stringify(legacy),bytes);
  assert.throws(()=>assertPricingDecision({...legacy,pricingDecision:{...legacy.pricingDecision,version:2}} as any,draft));
});

function fixture(t:test.TestContext){
  const parent=resolve('.test-data');mkdirSync(parent,{recursive:true});const directory=mkdtempSync(join(parent,'fallback-facts-'));
  const store=new WorkspaceStore(directory);let p=store.createProduct();p=store.saveProduct({...saveInput(p),title:'Plain',facts:[fact('采购币种','CNY')],variants:saveInput(p).variants.map(v=>({...v,originalSpec:'Plain',purchasePrice:'2.4'}))});
  const requests:string[]=[];const service=new AmazonService(directory,id=>store.getProduct(id),mockStorage,{fetch:async url=>{requests.push(String(url));throw new Error('No outbound request permitted');}});
  const target=service.enableDemo();const selection:SchemaSelection={targetId:target.id,productType:'FALLBACK_FIXTURE',parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'};
  service.getSchema=async input=>{const snapshot=demoSchema(service.getTarget((input as SchemaSelection).targetId),input as SchemaSelection,Date.now()),measurement={type:'object',properties:{value:{type:'number'},unit:{enum:['inches','cm']}},required:['value','unit'],additionalProperties:false};snapshot.schema={type:'object',properties:{is_value_stores_item:{type:'array',items:{type:'object',properties:{value:{type:'boolean'},marketplace_id:{type:'string'}},required:['value']}},purchasable_offer:(snapshot.schema.properties as JsonObject).purchasable_offer,brand:(snapshot.schema.properties as JsonObject).brand,item_package_weight:{type:'array',items:{type:'object',properties:{value:{type:'number'},unit:{enum:['pounds','g']},marketplace_id:{type:'string'}},required:['value','unit'],additionalProperties:false}},item_package_dimensions:{type:'array',items:{type:'object',properties:{length:measurement,width:measurement,height:measurement,marketplace_id:{type:'string'}},required:['length','width','height'],additionalProperties:false}}},additionalProperties:false};snapshot.mode=service.getTarget((input as SchemaSelection).targetId).mode;snapshot.checksum=createHash('md5').update(JSON.stringify(snapshot.schema)).digest('base64');return snapshot;};
  t.after(()=>{service.close();store.close();assert.ok(directory.startsWith(parent+'\\'));rmSync(directory,{recursive:true,force:true});});
  return {service,store,requests,selection,get product(){return store.getProduct(p.id);},create:(program:ListingProgram='haul')=>service.createDraft({...selection,listingProgram:program,productId:p.id,variantId:p.variants[0].id}),async live(){const target=await service.importCredentials({name:'Synthetic',sellerId:'SYNTHETIC_SELLER',marketplaceId:'ATVPDKIKX0DER',region:'na',locale:'en_US',clientId:'SYNTHETIC_CLIENT',clientSecret:'SYNTHETIC_SECRET',refreshToken:'SYNTHETIC_REFRESH'});selection.targetId=target.id;}};
}

test('SQLite current image facts never include private estimator defaults',async t=>{
  const f=fixture(t),draft=await f.create();assert.ok(draft.businessRules?.quote);
  const context=buildListingContext(draft,f.product,1),image=imageListingSnapshot(draft,context,[]);
  assert.throws(()=>assertImageMeasurements('5 cm, 100 g',image.context),(error:any)=>error.code==='OUTPUT_INVALID');
  assert.equal(image.context.evidence.some(f=>/5 cm|100 g|1.97 inches|0.22 pounds/.test(f.value)),false);
});

test('SQLite validate preserves legacy mixed attributes but blocks unsupported axes and brand',async t=>{
  const f=fixture(t),draft=await f.create(),attributes={...draft.attributes,brand:[{value:'Generic',marketplace_id:draft.marketplaceId}],item_package_dimensions:[{length:{value:9,unit:'inches'},width:{value:1.97,unit:'inches'},height:{value:1.97,unit:'inches'},marketplace_id:draft.marketplaceId}]};
  const saved=f.service.saveDraft({...draft,attributes}),checked=await f.service.validateDraft(saved);
  assert.equal(checked.state,'BLOCKED');assert.deepEqual(checked.attributes,attributes);
  const issues=checked.localIssues.filter(i=>i.code==='FACT_AUTHORITY_REQUIRED');assert.deepEqual(issues.flatMap(i=>i.attributeNames).sort(),['brand','item_package_dimensions']);
  assert.ok(issues.every(i=>i.source==='local'&&i.severity==='ERROR'&&!i.autoFixable));
  await assert.rejects(f.service.previewDraft(checked));assert.deepEqual(f.requests,[]);
});

for(const mode of ['demo','live'] as const)test(`SQLite ${mode} old preview submit and REUSED persist authority blocking before intent or outbound`,async t=>{
  const f=fixture(t);if(mode==='live')await f.live();let draft=await f.create();
  assert.equal(draft.attributes.brand,undefined);assert.equal(draft.attributes.item_package_dimensions,undefined);
  const attrs={...draft.attributes,brand:[{value:'Generic',marketplace_id:draft.marketplaceId}],item_package_dimensions:[{length:{value:9,unit:'inches'},width:{value:1.97,unit:'inches'},height:{value:1.97,unit:'inches'},marketplace_id:draft.marketplaceId}]};
  draft=f.service.saveDraft({...draft,attributes:attrs});draft=f.service.applyBusinessDefaults(draft);assert.deepEqual(draft.attributes,attrs);
  const p=(f.service as unknown as {persistence:AmazonPersistence}).persistence;let begun=0;const begin=p.beginWrite.bind(p);p.beginWrite=(...args)=>{begun++;return begin(...args);};
  const preview=()=>{const r=p.record(draft.id);r.draft.state='AMAZON_VALIDATED';r.draft.previewedAt=new Date().toISOString();r.preview={revision:r.draft.revision,productRevision:r.draft.productRevision,checksum:r.draft.schema.checksum,version:r.draft.schema.version,generation:p.generation(r.draft.targetId),at:r.draft.previewedAt};p.putRecord(r);return r.draft;};
  draft=preview();await assert.rejects(f.service.submitDraft(draft,true));assert.equal(begun,0);assert.deepEqual(f.requests,[]);
  let stored=p.record(draft.id);assert.equal(stored.draft.state,'BLOCKED');assert.equal(stored.preview,null);assert.equal(stored.draft.previewedAt,null);assert.deepEqual(stored.draft.attributes,attrs);
  draft=preview();const reused=await f.service.prepareDrafts({...f.selection,listingProgram:'haul',items:[{productId:f.product.id,productRevision:f.product.revision,variantId:f.product.variants[0].id,attributes:attrs}]});
  assert.equal(reused.items[0].disposition,'REUSED');assert.ok(reused.items[0].issues.some(i=>i.code==='FACT_AUTHORITY_REQUIRED'));
  stored=p.record(draft.id);assert.equal(stored.preview,null);assert.equal(stored.draft.state,'BLOCKED');assert.deepEqual(stored.draft.attributes,attrs);
  draft=f.service.saveDraft({...stored.draft,attributes:attrs});assert.deepEqual(draft.localIssues,[]);
  await assert.rejects(f.service.previewDraft(draft));assert.ok(f.service.getDraft(draft.id).localIssues.some(i=>i.code==='FACT_AUTHORITY_REQUIRED'));
  assert.equal(begun,0);assert.deepEqual(f.requests,[]);
});

test('SQLite partial factual support retains its ID and ordinary schema errors for missing siblings',async t=>{
  const f=fixture(t),length=fact('包装长度','5 cm');f.store.saveProduct({...saveInput(f.product),facts:[...f.product.facts,length]});
  const initial=await f.create(),attributes={...initial.attributes,item_package_dimensions:[{length:{value:5,unit:'cm'},marketplace_id:initial.marketplaceId}]};
  const saved=f.service.saveDraft({...initial,attributes}),checked=await f.service.validateDraft(saved);
  assert.ok(validateAttributes(checked.schema.schema,checked.attributes,checked.schema.metaSchema).some(i=>i.code==='LOCAL_required'));
  assert.ok(!checked.localIssues.some(i=>i.code==='FACT_AUTHORITY_REQUIRED'&&i.attributeNames.includes('item_package_dimensions')));
  assert.deepEqual(checked.sourceMapping!.find(m=>m.field==='item_package_dimensions')!.sourceFactIds,[length.id]);
});

test('SQLite explicit facts equal to historic defaults can complete demo preview and submit; standard keeps its policy',async t=>{
  const f=fixture(t);f.store.saveProduct({...saveInput(f.product),facts:[...f.product.facts,fact('品牌','无品牌'),fact('包装长度','5 cm'),fact('包装宽度','5 cm'),fact('包装高度','5 cm'),fact('包装重量','100 g')]});
  let draft=await f.create();draft=await f.service.previewDraft(draft);assert.equal(draft.state,'AMAZON_VALIDATED');draft=await f.service.submitDraft(draft,true);assert.equal(draft.state,'SUBMITTED');assert.deepEqual(f.requests,[]);
  const standard=fixture(t),old=await standard.create('standard'),attrs={...old.attributes,brand:[{value:'Unverified',marketplace_id:old.marketplaceId}]},checked=await standard.service.validateDraft(standard.service.saveDraft({...old,attributes:attrs}));
  assert.ok(!checked.localIssues.some(i=>i.code.startsWith('FACT_')));
});

test('SQLite UNKNOWN keeps its write lock, snapshot and non-replay precedence',async t=>{
  const f=fixture(t),draft=await f.create(),p=(f.service as unknown as {persistence:AmazonPersistence}).persistence,r=p.record(draft.id);
  r.draft.attributes.brand=[{value:'Generic',marketplace_id:draft.marketplaceId}];r.draft.state='UNKNOWN';r.unresolvedWrite=true;p.beginWrite(listingHash(draft,draft.sku),r);
  const bytes=JSON.stringify(p.record(draft.id));
  assert.throws(()=>f.service.saveDraft({...draft,attributes:r.draft.attributes}));assert.throws(()=>f.service.applyBusinessDefaults(draft));
  await assert.rejects(f.service.validateDraft(draft));await assert.rejects(f.service.previewDraft(draft));await assert.rejects(f.service.submitDraft(draft,true));
  assert.equal(JSON.stringify(p.record(draft.id)),bytes);assert.equal(p.locked(listingHash(draft,draft.sku)),true);assert.deepEqual(f.requests,[]);
});

test('direct field AI blocks stale v2 before usage reservation and outbound request',async t=>{
  const f=await aiFixture(t),p=(f.amazon as unknown as {persistence:AmazonPersistence}).persistence,record=p.record(f.draft.id);
  const resolved=run();record.draft.listingProgram='haul';record.draft.businessRules={...resolved.report,fields:{}};
  record.draft.attributes.item_package_weight=[{value:.23,unit:'pounds'}];p.putRecord(record);
  await assert.rejects(f.listing.suggest(f.reference));assert.equal(f.requests.length,0);assert.equal(f.ai.listCalls().length,0);
});

test('direct field AI rechecks v2 after its async context callback before provider dispatch',async t=>{
  const f=await aiFixture(t),p=(f.amazon as unknown as {persistence:AmazonPersistence}).persistence,record=p.record(f.draft.id);
  record.draft.listingProgram='haul';record.draft.businessRules={...run().report,fields:{}};p.putRecord(record);
  const context=(f.listing as any).current(f.reference).context;
  await assert.rejects(f.ai.listingFields(context,async()=>{const changed=p.record(f.draft.id);changed.draft.attributes.item_package_weight=null;p.putRecord(changed);}));
  assert.equal(f.requests.length,0);assert.equal(f.ai.listCalls().length,0);
});


test('missing-only preview cannot hide an unsupported present field beside an absent required field',async t=>{
  const f=fixture(t),getSchema=f.service.getSchema.bind(f.service);f.service.getSchema=async input=>{const schema=await getSchema(input);schema.schema.required=['brand'];return schema;};
  const draft=await f.create(),attributes={...draft.attributes,item_package_dimensions:[{length:{value:5,unit:'cm'},width:{value:5,unit:'cm'},height:{value:5,unit:'cm'},marketplace_id:draft.marketplaceId}]};
  const schemaIssues=validateAttributes(draft.schema.schema,attributes,draft.schema.metaSchema);
  assert.equal(isMissingOnlyPreview(draft.schema.schema,attributes,draft.schema.metaSchema,schemaIssues),true);
  const saved=f.service.saveDraft({...draft,attributes});await assert.rejects(f.service.previewDraft(saved));
  const current=f.service.getDraft(draft.id);assert.ok(current.localIssues.some(issue=>issue.code==='FACT_AUTHORITY_REQUIRED'));
  assert.equal(current.previewedAt,null);assert.deepEqual(f.requests,[]);
});

test('adopting supported AI copy preserves unsupported legacy facts and cannot clear their authority gate',async t=>{
  const f=await aiFixture(t),p=(f.amazon as unknown as {persistence:AmazonPersistence}).persistence,r=p.record(f.draft.id);
  r.draft.listingProgram='haul';r.draft.attributes.brand=[{value:'Generic',marketplace_id:r.draft.marketplaceId}];p.putRecord(r);
  const suggestion=await f.listing.suggest(f.reference),review=await f.listing.review({...f.reference,suggestionResultId:suggestion.id});
  const adopted=await f.listing.adopt({...f.reference,suggestionResultId:suggestion.id,reviewResultId:review.id,fields:['material']});
  assert.equal(adopted.state,'BLOCKED');assert.deepEqual(adopted.attributes.brand,r.draft.attributes.brand);
  assert.ok(adopted.localIssues.some(issue=>issue.code==='FACT_AUTHORITY_REQUIRED'&&issue.attributeNames.includes('brand')));
  assert.equal(adopted.fieldAdoptions?.length,1);assert.equal(f.requests.length,2);
  await assert.rejects(f.amazon.previewDraft(adopted));assert.equal(f.requests.length,2);
});
