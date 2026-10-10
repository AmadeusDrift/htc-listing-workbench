import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { WorkspaceStore } from '../src/main/store.ts';
import { AmazonService } from '../src/main/amazon/service.ts';
import { demoSchema } from '../src/main/amazon/demo.ts';
import { saveInput, mockStorage, chat, candidateFor, reviewFor } from './fixtures/listing-ai.ts';
import type { AmazonDraft, JsonObject, ListingProgram, SchemaSelection } from '../src/shared/amazon-contracts.ts';
import type { AmazonPersistence } from '../src/main/amazon/persistence.ts';
import type { Fact } from '../src/shared/contracts.ts';
import { SkuNamingService } from '../src/main/sku-naming/service.ts';
import { planSalesListings } from '../src/main/sales-plans/planning.ts';
import { defaultListingRules } from '../src/shared/listing-rules.ts';
import { ListingRuleStore } from '../src/main/listing-rules.ts';
import { AiService } from '../src/main/ai/service.ts';
import { HostingService } from '../src/main/hosting/service.ts';
import { ListingAiService } from '../src/main/listing-ai/service.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore } from '../src/main/backup.ts';
import { openDatabase } from '../src/main/database.ts';
import { sourceStamp } from '../src/main/automatic-listing/records.ts';

const declarations = ['batteries_required','supplier_declared_dg_hz_regulation','required_product_compliance_certificate'] as const;
const value = (type:string, extra:JsonObject={}):JsonObject => ({type:'array',items:{type:'object',properties:{value:{type,...extra},marketplace_id:{type:'string'}},required:['value'],additionalProperties:false}});
const fact = (name:string,text:string,state:Fact['state']='source_confirmed'):Fact => ({id:randomUUID(),name,value:text,state,source:'manual',sourceRef:'Synthetic safety fixture'});
function fixture(t:test.TestContext, specs=['电池供电']) {
  const parent=resolve('.test-data');mkdirSync(parent,{recursive:true});const directory=mkdtempSync(join(parent,'variant-safety-'));
  const store=new WorkspaceStore(directory);let product=store.createProduct();
  product=store.saveProduct({...saveInput(product),title:'Synthetic product',description:'',facts:[fact('采购币种','CNY')],variants:specs.map((spec,i)=>({id:i?randomUUID():product.variants[0].id,sku:`SAFETY-${i}`,originalSpec:spec,normalizedSpec:'',purchasePrice:'2.4',inventory:null}))});
  const requests:{url:string;method:string}[]=[];
  let service:AmazonService;
  const open=()=>{
    const instance=new AmazonService(directory,id=>store.getProduct(id),mockStorage,{fetch:async(url,init)=>{
      if(String(url).includes('/auth/o2/token'))return Response.json({access_token:'SYNTHETIC_ACCESS',token_type:'bearer',expires_in:3600});
      requests.push({url:String(url),method:init?.method??'GET'});
      const parsed=new URL(String(url));return Response.json({sku:decodeURIComponent(parsed.pathname.split('/').at(-1)!),status:parsed.searchParams.has('mode')?'VALID':'ACCEPTED',submissionId:'SYNTHETIC_SUBMISSION',issues:[]});
    }});
    instance.getSchema=async input=>{
      const selected=input as SchemaSelection,target=instance.getTarget(selected.targetId),snapshot=demoSchema(target,selected,Date.now());
      const measurement={type:'object',properties:{value:{type:'number'},unit:{enum:['inches']}},required:['value','unit'],additionalProperties:false};
      const properties:JsonObject={is_value_stores_item:value('boolean'),batteries_required:value('boolean'),supplier_declared_dg_hz_regulation:value('string'),required_product_compliance_certificate:value('string'),
        item_package_dimensions:{type:'array',items:{type:'object',properties:{length:measurement,width:measurement,height:measurement,marketplace_id:{type:'string'}},required:['length','width','height'],additionalProperties:false}},
        item_package_weight:{type:'array',items:{type:'object',properties:{value:{type:'number'},unit:{enum:['pounds']},marketplace_id:{type:'string'}},required:['value','unit'],additionalProperties:false}}};
      if(selected.parentageLevel!=='PARENT')properties.purchasable_offer=(snapshot.schema.properties as JsonObject).purchasable_offer;
      snapshot.mode=target.mode;snapshot.schema={type:'object',properties,additionalProperties:false};snapshot.checksum=createHash('md5').update(JSON.stringify(snapshot.schema)).digest('base64');return snapshot;
    };
    return instance;
  };
  service=open();let target=service.enableDemo();
  const selection:SchemaSelection={targetId:target.id,productType:'SAFETY_FIXTURE',parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'};
  t.after(()=>{service.close();store.close();assert.ok(directory.startsWith(parent+'\\'));rmSync(directory,{recursive:true,force:true});});
  return {directory,store,requests,get target(){return target;},selection,get product(){return store.getProduct(product.id);},get service(){return service;},
    create:(program:ListingProgram='haul',index=0)=>service.createDraft({...selection,listingProgram:program,productId:product.id,variantId:product.variants[index].id}),
    async live(){target=await service.importCredentials({name:'U8',sellerId:'SYNTHETIC_SELLER',marketplaceId:'ATVPDKIKX0DER',region:'na',locale:'en_US',clientId:'SYNTHETIC_CLIENT',clientSecret:'SYNTHETIC_SECRET',refreshToken:'SYNTHETIC_REFRESH'});selection.targetId=target.id;},
    reopen(){service.close();service=open();return service;}};
}
const persistence=(service:AmazonService)=>(service as unknown as {persistence:AmazonPersistence}).persistence;
const entry=(draft:AmazonDraft,field:string)=>(draft.attributes[field] as JsonObject[]|undefined)?.[0]?.value;
const safetyIssues=(draft:AmazonDraft)=>draft.localIssues.filter(issue=>issue.code==='DECLARATION_SOURCE_CONFLICT');
function unsafeAttributes(draft:AmazonDraft):JsonObject {
  return {...draft.attributes,...Object.fromEntries(declarations.map((field,i)=>[field,[{value:i===0?false:i===1?'not_applicable':'Not Applicable',marketplace_id:draft.marketplaceId}]]))};
}
function legacyDraft(f:ReturnType<typeof fixture>,draft:AmazonDraft,preview=false):AmazonDraft {
  const p=persistence(f.service),record=p.record(draft.id);record.draft.attributes=unsafeAttributes(draft);
  for(const field of declarations)record.draft.businessRules!.fields[field]={value:structuredClone(record.draft.attributes[field]),reason:'Synthetic historical ordinary default'};
  if(preview){record.draft.state='AMAZON_VALIDATED';record.draft.previewedAt=new Date().toISOString();record.preview={revision:draft.revision,productRevision:draft.productRevision,checksum:draft.schema.checksum,version:draft.schema.version,generation:p.generation(draft.targetId),at:record.draft.previewedAt};}
  p.putRecord(record);return f.service.getDraft(draft.id);
}

test('SQLite Haul createDraft uses selected original safety text just as the identical product title',async t=>{
  const selected=fixture(t),before=JSON.stringify(selected.product);
  const draft=await selected.create();
  const title=fixture(t,['']);title.store.saveProduct({...saveInput(title.product),title:'电池供电'});
  const titleDraft=await title.create();
  for(const field of declarations){assert.equal(titleDraft.attributes[field],undefined);assert.equal(draft.attributes[field],undefined,`${field} must not default against selected raw evidence`);}
  assert.equal(JSON.stringify(selected.product),before);
});

test('source, current original and normalized selected text remain independent safety inputs',async t=>{
  for(const mode of ['source','original','normalized'] as const){
    const f=fixture(t,[mode==='source'?'电池供电':'Plain']);
    f.store.saveProduct({...saveInput(f.product),variants:saveInput(f.product).variants.map(v=>({...v,originalSpec:mode==='original'?'电池供电':'Manual',normalizedSpec:mode==='normalized'?'电池供电':'Manual'}))});
    const draft=await f.create();for(const field of declarations)assert.equal(draft.attributes[field],undefined,mode+': '+field);
  }
});

test('ordinary unknown and unselected sibling risk preserve the existing default policy',async t=>{
  for(const text of ['Plain','供电方式未知']){
    const f=fixture(t,[text,'电池供电']),draft=await f.create();
    assert.equal(entry(draft,'batteries_required'),false);assert.equal(entry(draft,'supplier_declared_dg_hz_regulation'),'not_applicable');
    assert.deepEqual(safetyIssues(await f.service.validateDraft(draft)),[]);
  }
});

test('selected chemical risk suppresses only chemical defaults; existing English risk vocabulary is unchanged',async t=>{
  for(const [text,battery,hazmat] of [['清洁剂',false,undefined],['electric',undefined,'not_applicable'],['rechargeable',undefined,'not_applicable'],['batteries',undefined,'not_applicable']] as const){
    const f=fixture(t,[text]),draft=await f.create();assert.equal(entry(draft,'batteries_required'),battery,text);assert.equal(entry(draft,'supplier_declared_dg_hz_regulation'),hazmat,text);
  }
});

test('every selected mixed recipe component contributes original text even when normalized summaries omit it',async t=>{
  for(const riskIndex of [0,1]){
    const f=fixture(t,[`颜色: 红色 / ${riskIndex===0?'电池供电':'Plain'}`,`颜色: 蓝色 / ${riskIndex===1?'电池供电':'Plain'}`]),naming=new SkuNamingService(f.directory);
    try{
      const product=f.store.saveProduct({...saveInput(f.product),variants:saveInput(f.product).variants.map((v,i)=>({...v,normalizedSpec:`颜色: ${i?'蓝色':'红色'} / 尺寸: 小号`,purchasePrice:'0.1'}))});
      const before=JSON.stringify(product),plans=planSalesListings(product,null,f.target,defaultListingRules(),naming).map(p=>({...p,familyResolved:true}));
      const mixed=plans.find(p=>p.recipe.components.length===2)!;assert.ok(mixed);assert.ok(!mixed.recipe.specification.includes('电池'));
      const result=await f.service.prepareDrafts({...f.selection,listingProgram:'haul',items:[{productId:product.id,productRevision:product.revision,variantId:product.variants[0].id,attributes:{}}]},[mixed]);
      assert.equal(result.items[0].disposition,'CREATED',result.items[0].error??'');
      for(const field of declarations)assert.equal(result.items[0].draft!.attributes[field],undefined,`${riskIndex}: ${field}`);
      const existing=legacyDraft(f,result.items[0].draft!);
      assert.equal(safetyIssues(await f.service.validateDraft(existing)).length,3);
      const plain=plans.find(p=>p.recipe.components.length===1&&p.recipe.components[0].variantId===product.variants[1-riskIndex].id)!;
      const other=await f.service.prepareDrafts({...f.selection,listingProgram:'haul',items:[{productId:product.id,productRevision:product.revision,variantId:plain.recipe.components[0].variantId,attributes:{}}]},[plain]);
      assert.equal(entry(other.items[0].draft!,'batteries_required'),false);
      assert.equal(JSON.stringify(f.product),before);assert.deepEqual(result.items[0].draft!.salesPlan,mixed);
    }finally{naming.close();}
  }
});

test('parent declarations check selected scope before the parent early return',async t=>{
  const f=fixture(t);f.selection.parentageLevel='PARENT';const draft=await f.create();
  for(const field of declarations)assert.equal(draft.attributes[field],undefined);assert.equal(draft.attributes.purchasable_offer,undefined);
});

test('parent sales projection retains risk from its non-anchor recipe component',async t=>{
  const f=fixture(t,['颜色: 红色 / Plain','颜色: 蓝色 / 电池供电']),naming=new SkuNamingService(f.directory),schema=f.service.getSchema.bind(f.service);
  f.service.getSchema=async input=>{
    const snapshot=await schema(input);
    Object.assign(snapshot.schema.properties!,{parentage_level:value('string'),
      variation_theme:{type:'array',items:{type:'object',properties:{name:{enum:['COLOR']},marketplace_id:{type:'string'}},required:['name']}},
      child_parent_sku_relationship:{type:'array',items:{type:'object',properties:{child_relationship_type:{const:'variation'},marketplace_id:{type:'string'}},required:['child_relationship_type']}}});
    snapshot.checksum=createHash('md5').update(JSON.stringify(snapshot.schema)).digest('base64');return snapshot;
  };
  try{
    const product=f.store.saveProduct({...saveInput(f.product),variants:saveInput(f.product).variants.map((v,i)=>({...v,normalizedSpec:`颜色: ${i?'蓝色':'红色'} / 尺寸: 小号`,purchasePrice:'0.1'}))});
    const mixed=planSalesListings(product,null,f.target,defaultListingRules(),naming).find(p=>p.recipe.components.length===2)!;
    const plan={...mixed,parentage:'PARENT' as const,sku:mixed.baseSku,parentSku:null,namingChildKey:null,variationTheme:'COLOR',familyResolved:true};
    const before=JSON.stringify(product),result=await f.service.prepareDrafts({...f.selection,parentageLevel:'PARENT',listingProgram:'haul',items:[{productId:product.id,productRevision:product.revision,variantId:product.variants[0].id,attributes:{}}]},[plan]);
    assert.equal(result.items[0].disposition,'CREATED',result.items[0].error??'');const draft=result.items[0].draft!;
    for(const field of declarations)assert.equal(draft.attributes[field],undefined);assert.equal(draft.attributes.purchasable_offer,undefined);
    const checked=await f.service.validateDraft(legacyDraft(f,draft));assert.equal(safetyIssues(checked).length,3);assert.equal(checked.state,'BLOCKED');
    assert.equal(JSON.stringify(f.product),before);assert.deepEqual(checked.salesPlan,plan);
  }finally{naming.close();}
});

test('legacy business values survive but structured compliance errors block current authorization',async t=>{
  const f=fixture(t),draft=legacyDraft(f,await f.create()),before=JSON.stringify(draft.attributes),report=JSON.stringify(draft.businessRules);
  const checked=await f.service.validateDraft(draft);assert.equal(checked.state,'BLOCKED');assert.equal(safetyIssues(checked).length,3);
  assert.ok(safetyIssues(checked).every(i=>i.category==='compliance'&&i.severity==='ERROR'&&!i.autoFixable));
  assert.equal(JSON.stringify(checked.attributes),before);assert.equal(JSON.stringify(checked.businessRules),report);
  const saved=f.service.saveDraft({...checked,attributes:checked.attributes});assert.deepEqual(saved.localIssues,[]);
  await assert.rejects(f.service.previewDraft(saved),/本地校验/);assert.equal(f.service.getDraft(draft.id).state,'BLOCKED');assert.equal(f.requests.length,0);
});

test('source and human confirmed false cannot bypass selected risk, including with ordinary defaults disabled',async t=>{
  for(const state of ['source_confirmed','human_confirmed'] as const){
    const f=fixture(t);f.store.saveProduct({...saveInput(f.product),facts:[...f.product.facts,fact('是否需要电池','否',state)]});
    const rules=new ListingRuleStore(f.directory);try{const current=rules.get();current.product.ordinaryDeclarations=false;rules.save(current);}finally{rules.close();}
    const before=JSON.stringify(f.product),draft=await f.create(),checked=await f.service.validateDraft(draft);
    assert.equal(entry(checked,'batteries_required'),false);assert.equal(safetyIssues(checked).length,1);assert.equal(checked.state,'BLOCKED');assert.equal(JSON.stringify(f.product),before);
  }
});

test('standard draft authorization remains outside the Haul default boundary',async t=>{
  const f=fixture(t),draft=await f.create('standard');const saved=f.service.saveDraft({...draft,attributes:unsafeAttributes(draft)});
  assert.equal((await f.service.validateDraft(saved)).state,'LOCAL_VALIDATED');assert.deepEqual(safetyIssues(f.service.getDraft(draft.id)),[]);
});

test('REUSED prepares recompute structured errors instead of trusting saved issues',async t=>{
  const f=fixture(t),draft=await f.create();const attrs=unsafeAttributes(draft),saved=f.service.saveDraft({...draft,attributes:attrs});
  const historical=legacyDraft(f,saved,true),report=JSON.stringify(historical.businessRules);
  const result=await f.service.prepareDrafts({...f.selection,listingProgram:'haul',items:[{productId:f.product.id,productRevision:f.product.revision,variantId:f.product.variants[0].id,attributes:attrs}]});
  assert.equal(result.items[0].disposition,'REUSED',result.items[0].error??'');assert.equal(result.items[0].draft!.id,saved.id);
  assert.equal(result.items[0].issues.filter(i=>i.code==='DECLARATION_SOURCE_CONFLICT').length,3);
  assert.equal(result.items[0].draft!.state,'BLOCKED');assert.equal(safetyIssues(result.items[0].draft!).length,3);assert.equal(safetyIssues(f.service.getDraft(saved.id)).length,3);
  assert.equal(persistence(f.service).record(saved.id).preview,null);assert.equal(result.items[0].draft!.previewedAt,null);assert.equal(JSON.stringify(result.items[0].draft!.businessRules),report);
});

test('valid old preview plus unchanged refreshed defaults cannot reach write intent or mock transport',async t=>{
  const f=fixture(t);await f.live();let draft=legacyDraft(f,await f.create(),true);
  draft=f.service.applyBusinessDefaults(draft);const attrs=JSON.stringify(draft.attributes),report=JSON.stringify(draft.businessRules),p=persistence(f.service),begin=p.beginWrite.bind(p);let writes=0;
  t.mock.method(p,'beginWrite',(...args:Parameters<AmazonPersistence['beginWrite']>)=>{writes++;return begin(...args);});
  await assert.rejects(f.service.submitDraft(draft,true),/本地校验/);
  assert.equal(writes,0);assert.equal(f.requests.length,0);assert.equal(p.db.prepare('SELECT * FROM amazon_write_locks').all().length,0);
  const saved=f.service.getDraft(draft.id);assert.notEqual(saved.state,'UNKNOWN');assert.equal(JSON.stringify(saved.attributes),attrs);assert.equal(JSON.stringify(saved.businessRules),report);
  assert.equal(saved.state,'BLOCKED');assert.equal(safetyIssues(saved).length,3);assert.equal(saved.previewedAt,null);assert.equal(p.record(draft.id).preview,null);
});

test('ordinary Haul positive control validates, previews and submits through the mock provider',async t=>{
  const f=fixture(t,['Plain']);await f.live();const draft=await f.create();assert.equal((await f.service.validateDraft(draft)).state,'LOCAL_VALIDATED');
  const preview=await f.service.previewDraft(draft);assert.equal(preview.state,'AMAZON_VALIDATED');const submitted=await f.service.submitDraft(preview,true);
  assert.equal(submitted.state,'SUBMITTED');assert.equal(f.requests.length,2);
});

test('missing-only preview cannot defer a declaration conflict to the provider',async t=>{
  const f=fixture(t);await f.live();const schema=f.service.getSchema.bind(f.service);
  f.service.getSchema=async input=>{const snapshot=await schema(input);snapshot.schema.required=['required_product_compliance_certificate'];return snapshot;};
  let draft=legacyDraft(f,await f.create());const attributes={...draft.attributes};delete attributes.required_product_compliance_certificate;
  draft=f.service.saveDraft({...draft,attributes});await assert.rejects(f.service.previewDraft(draft),/本地校验/);
  const current=f.service.getDraft(draft.id);assert.ok(current.localIssues.some(i=>i.code==='LOCAL_required'));assert.equal(safetyIssues(current).length,2);assert.equal(f.requests.length,0);
});

test('a confirmed no-battery declaration does not become its own contradictory risk cue',async t=>{
  for(const state of ['source_confirmed','human_confirmed'] as const){
    const f=fixture(t,['Plain']);f.store.saveProduct({...saveInput(f.product),facts:[...f.product.facts,fact('是否需要电池','否',state),fact('危险品法规','not_applicable',state),fact('产品合规证书','Not Applicable',state)]});
    const draft=await f.create(),checked=await f.service.validateDraft(draft);
    assert.equal(checked.state,'LOCAL_VALIDATED');assert.equal(entry(checked,'batteries_required'),false);assert.deepEqual(safetyIssues(checked),[]);
  }
});

test('conflicting declaration evidence cannot downgrade current safety authorization',async t=>{
  const f=fixture(t,['Plain']);f.store.saveProduct({...saveInput(f.product),facts:[...f.product.facts,fact('是否需要电池','否','conflicting')]});
  const draft=legacyDraft(f,await f.create()),before=JSON.stringify(f.product),checked=await f.service.validateDraft(draft);
  assert.equal(checked.state,'BLOCKED');assert.equal(safetyIssues(checked).length,3);assert.equal(JSON.stringify(f.product),before);assert.deepEqual(checked.attributes,draft.attributes);
});

test('reopen and encrypted backup retain source bytes, old exchanges, paid mock records and adopted context hashes',async t=>{
  const f=fixture(t);f.store.saveProduct({...saveInput(f.product),facts:[...f.product.facts,fact('材质','Silicone'),fact('颜色','Blue')]});
  const getSchema=f.service.getSchema.bind(f.service);f.service.getSchema=async input=>{
    const schema=await getSchema(input);(schema.schema.properties as JsonObject).material=value('string');
    schema.checksum=createHash('md5').update(JSON.stringify(schema.schema)).digest('base64');return schema;
  };
  let draft=legacyDraft(f,await f.create(),true);const attributes={...draft.attributes};delete attributes.material;
  draft=f.service.saveDraft({...draft,attributes});
  const hosting=new HostingService(f.directory,f.store,mockStorage);let calls=0;
  const ai=new AiService(f.directory,f.store,hosting,mockStorage,{fetch:async(_url,options)=>{
    calls++;const payload=JSON.parse(JSON.parse(String(options?.body)).messages[1].content);return chat(payload.candidate?reviewFor(payload):candidateFor(payload));
  }});
  try{
    ai.saveConnection({id:'deepseek',apiKey:'synthetic-safety-key'});ai.saveFunctionSettings({id:'deepseek',model:'deepseek-flash',enabled:true});ai.saveFunctionSettings({id:'deepseek-review',model:'deepseek-v4-pro',enabled:true});
    const listing=new ListingAiService(f.store,f.service,ai),reference={draftId:draft.id,draftRevision:draft.revision};
    const suggestion=await listing.suggest(reference),review=await listing.review({...reference,suggestionResultId:suggestion.id});
    draft=await listing.adopt({...reference,suggestionResultId:suggestion.id,reviewResultId:review.id,fields:['material']});assert.equal(calls,2);
    const p=persistence(f.service),record=p.record(draft.id);
    record.exchanges=[{id:randomUUID(),at:'2026-01-01T00:00:00.000Z',operation:'preview',revision:1,request:{attributes:unsafeAttributes(draft)},response:{status:'VALID'},status:200,requestId:'SYNTHETIC_OLD_PREVIEW',schemaChecksum:draft.schema.checksum,schemaVersion:draft.schema.version}];
    p.putRecord(record);
    const sourceBytes=JSON.stringify(f.product),stamp=sourceStamp(f.product),history=JSON.stringify(draft.fieldAdoptions),report=JSON.stringify(draft.businessRules),attrs=JSON.stringify(draft.attributes),exchanges=JSON.stringify(record.exchanges);
    const paidRows=(db:ReturnType<typeof openDatabase>)=>JSON.stringify(['ai_calls','ai_results','ai_usage_ledger'].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()));
    const paid=paidRows(p.db),contextHashes=draft.fieldAdoptions!.map(a=>a.contextSha256);
    f.reopen();assert.equal(safetyIssues(f.service.getDraft(draft.id)).length,3);
    const refreshed=await f.service.validateDraft(f.service.getDraft(draft.id));assert.equal(refreshed.state,'BLOCKED');assert.equal(JSON.stringify(refreshed.fieldAdoptions),history);
    const file=join(f.directory,'safety.htcbackup');await createWorkspaceBackup(f.directory,file,'synthetic safety backup passphrase');
    const restored=await prepareWorkspaceRestore(f.directory,file,'synthetic safety backup passphrase'),store=new WorkspaceStore(restored.stagingDirectory),amazon=new AmazonService(restored.stagingDirectory,id=>store.getProduct(id),mockStorage,{fetch:async()=>{throw new Error('Restored history must not send');}});
    const db=openDatabase(restored.stagingDirectory);
    try{
      const restoredDraft=amazon.getDraft(draft.id);assert.equal(paidRows(db),paid);assert.equal(JSON.stringify(store.getProduct(f.product.id)),sourceBytes);assert.equal(sourceStamp(store.getProduct(f.product.id)),stamp);
      assert.equal(JSON.stringify(restoredDraft.fieldAdoptions),history);assert.deepEqual(restoredDraft.fieldAdoptions!.map(a=>a.contextSha256),contextHashes);assert.equal(JSON.stringify(restoredDraft.businessRules),report);assert.equal(JSON.stringify(restoredDraft.attributes),attrs);
      assert.equal(JSON.stringify(persistence(amazon).record(draft.id).exchanges),exchanges);
      const saved=amazon.saveDraft({...restoredDraft,attributes:restoredDraft.attributes});assert.equal(saved.localIssues.length,0);
      const validated=await amazon.validateDraft(saved);assert.equal(validated.state,'BLOCKED');assert.equal(safetyIssues(validated).length,3);assert.equal(JSON.stringify(validated.fieldAdoptions),history);assert.equal(paidRows(db),paid);assert.equal(calls,2);
    }finally{db.close();amazon.close();store.close();}
  }finally{await ai.close();await hosting.close();}
});
