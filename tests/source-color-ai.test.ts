import { pricingAttributeInputs } from '../src/main/amazon/pricing-inputs.ts';
import { confirmSourceConsistencyFixture } from './helpers/source-consistency-proof.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { WorkspaceStore } from '../src/main/store.ts';
import { importImageFiles } from '../src/main/assets.ts';
import { HostingService } from '../src/main/hosting/service.ts';
import { AiService } from '../src/main/ai/service.ts';
import { AmazonService } from '../src/main/amazon/service.ts';
// Keep the historical paid color resolver and its replay guards under the v3 contract.
import { LegacyListingAiService as ListingAiService } from './helpers/legacy-listing-context.ts';
import { AiError } from '../src/main/ai/errors.ts';
import { validateAiCall, validateAiResult } from '../src/main/ai/validation.ts';
import { openDatabase } from '../src/main/database.ts';
import { listingFingerprint } from '../src/main/listing-ai/validation.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import { chat, mockStorage, saveInput } from './fixtures/listing-ai.ts';
import { assertSourceColorOutput, validateSourceColorContext, validateSourceColorOutput } from '../src/main/ai/source-color-validation.ts';
import { SOURCE_COLOR_VALUES } from '../src/shared/source-color-contracts.ts';
import { applyBusinessRules } from '../src/main/amazon/business-rules.ts';
import { realAmazonSchema } from './fixtures/amazon/schema-fixture.ts';
import { ListingRuleStore } from '../src/main/listing-rules.ts';
import type { AmazonPersistence } from '../src/main/amazon/persistence.ts';

// A complete PNG with real pixels and CRCs, not only an IHDR header.
function sourcePng(): Buffer {
  const crc = (data:Buffer) => { let value=0xffffffff; for(const byte of data){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0; };
  const chunk=(name:string, data:Buffer)=>{const type=Buffer.from(name),size=Buffer.alloc(4),checksum=Buffer.alloc(4);size.writeUInt32BE(data.length);checksum.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([size,type,data,checksum]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(32,0);header.writeUInt32BE(32,4);header[8]=8;header[9]=2;
  const pixels=Buffer.alloc(32*(1+32*3),190);for(let y=0;y<32;y++)pixels[y*97]=0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
const code=(expected:string)=>(error:unknown)=>error instanceof AiError&&error.code===expected;
async function fixture(t:test.TestContext) {
  mkdirSync(resolve('.test-data'),{recursive:true});const directory=mkdtempSync(resolve('.test-data/source-color-'));
  const store=new WorkspaceStore(directory);let product=store.createProduct();
  product=store.saveProduct({...saveInput(product),title:'Unverified brand title',variants:saveInput(product).variants.map(v=>({...v,originalSpec:'颜色分类: 602Q',normalizedSpec:''}))});
  const bytes=sourcePng(),path=join(directory,'source.png');writeFileSync(path,bytes);
  product=await importImageFiles(store,directory,{productId:product.id,revision:product.revision},[path],b=>b);
  product=store.updateAsset({productId:product.id,revision:product.revision,assetId:product.assets[0].id,role:'main',variantIds:[product.variants[0].id]});
  await confirmSourceConsistencyFixture(directory,store,product.id);
  const hosting=new HostingService(directory,store,mockStorage),requests:any[]=[];
  let respond=(payload:any,_options?:RequestInit):Response|Promise<Response>=>chat({kind:'source-color',verdict:'DETERMINED',colors:['Silver'],reason:'The product body has a silver appearance; packaging colors excluded.',referenceAssetIds:payload.referenceImages.map((image:any)=>image.assetId)});
  const ai=new AiService(directory,store,hosting,mockStorage,{fetch:async(_url,options)=>{const body=JSON.parse(String(options?.body));requests.push(body);const content=body.messages[1].content;return respond(JSON.parse(typeof content==='string'?content:content[0].text),options);}});
  ai.saveConnection({id:'deepseek',apiKey:'source-color-test-key'});ai.saveFunctionSettings({id:'deepseek',model:'deepseek-v4-pro',enabled:true});
  t.after(async()=>{await ai.close();await hosting.close();store.close();const target=resolve(directory);assert.ok(target.startsWith(resolve('.test-data')+'\\')||target.startsWith(resolve('.test-data')+'/'));rmSync(target,{recursive:true,force:true});});
  const input={productId:product.id,productRevision:product.revision,variantId:product.variants[0].id};
  return{directory,store,product,ai,requests,bytes,input,context:()=> (ai as any).sourceColorContext(input),observe:(context:any,callback=()=>{},signal?:AbortSignal)=>(ai as any).observeSourceColor(context,callback,signal),respond:(fn:typeof respond)=>{respond=fn;}};
}

test('source-color observes original pixels with SKU provenance, usage accounting and no fact writes',async t=>{
  const f=await fixture(t),context=f.context();let callbacks=0;
  assert.equal(context.sourceSpec,'颜色分类: 602Q');assert.equal(context.policyVersion,'source-color/v1');
  const before=f.store.getProduct(f.product.id),result=await f.observe(context,()=>{callbacks++;});
  assert.equal(result.output.kind,'source-color');assert.deepEqual(result.output.colors,['Silver']);
  assert.equal(f.requests[0].model,'deepseek-flash');
  assert.equal(f.requests[0].messages[1].content[1].image_url.url,`data:image/png;base64,${f.bytes.toString('base64')}`);
  assert.deepEqual(result.sourceColorContext,context);assert.equal(result.sourceSha256,listingFingerprint(context));
  assert.equal(result.sourceColorRequestBytes,Buffer.byteLength(JSON.stringify(f.requests[0])));
  assert.equal(result.assetId,null);assert.equal(result.assetSha256,null);assert.deepEqual(result.sourceResultIds,[]);
  assert.deepEqual(validateAiResult(result),result);assert.ok(callbacks>=3);
  assert.equal(f.ai.listCalls()[0].status,'SUCCEEDED');assert.equal(f.ai.getUsageSummary('deepseek').reportedTokens,150);
  assert.deepEqual(f.ai.listCalls()[0].sourceColorContext,context);
  assert.deepEqual(f.store.getProduct(f.product.id),before);
});

test('pricing changes after a paid color request preserve the received result and cache but stop the next new request',async t=>{
  const f=await fixture(t),amazon=new AmazonService(f.directory,id=>f.store.getProduct(id),mockStorage),target=amazon.enableDemo(),rules=new ListingRuleStore(f.directory);
  try {
  const draft=await amazon.createDraft({targetId:target.id,productId:f.product.id,variantId:f.product.variants[0].id,productType:'HTC_DEMO_STORAGE_BAG',parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'});
  const p=(amazon as unknown as {persistence:AmazonPersistence}).persistence,record=p.record(draft.id);
  const result=applyBusinessRules({product:f.product,variant:f.product.variants[0],target,schema:realAmazonSchema(),attributes:{},measurements:{},costCny:2.4,now:new Date()},rules.get());
  record.draft.listingProgram='haul';record.draft.attributes={...record.draft.attributes,...result.attributes};record.draft.businessRules={...result.report,fields:{}};if(record.draft.businessRules.pricingDecision?.version===2)record.draft.businessRules.pricingDecision.attributeInputs=pricingAttributeInputs(record.draft.attributes);p.putRecord(record);
  const listing=new ListingAiService(f.store,amazon,f.ai),reference={draftId:draft.id,draftRevision:draft.revision};
  f.respond(async payload=>{await Promise.resolve();const changed=rules.get();changed.pricing.inboundCost++;rules.save(changed);return chat({kind:'source-color',verdict:'DETERMINED',colors:['Silver'],reason:'Observed silver surface.',referenceAssetIds:payload.referenceImages.map((r:any)=>r.assetId)});});
  const prepared=await listing.prepareSourceColors(reference);assert.equal(prepared.aiCalls,1);assert.equal(f.ai.listCalls()[0].status,'SUCCEEDED');assert.equal(f.ai.listResults(f.product.id).length,1);
  assert.equal((await listing.prepareSourceColors(reference)).aiCalls,0);assert.equal(f.requests.length,1);
  await assert.rejects(listing.suggest(reference));assert.equal(f.requests.length,1);assert.equal(f.ai.listCalls().length,1);
  } finally { amazon.close();rules.close(); }
});

test('uncertain observations are preserved without determined colors',async t=>{
  const f=await fixture(t);f.respond(p=>chat({kind:'source-color',verdict:'UNCERTAIN',colors:[],reason:'Lighting obscures the surface color.',referenceAssetIds:p.referenceImages.map((r:any)=>r.assetId)}));
  const result=await f.observe(f.context());assert.equal(result.output.verdict,'UNCERTAIN');assert.deepEqual(result.output.colors,[]);
});

test('invalid model colors fail closed and retain raw local rejection diagnostics',async t=>{
  const f=await fixture(t),context=f.context();f.respond(p=>chat({kind:'source-color',verdict:'DETERMINED',colors:['Stainless Steel'],reason:'Metal means silver.',referenceAssetIds:p.referenceImages.map((r:any)=>r.assetId)}));
  await assert.rejects(f.observe(context),code('OUTPUT_INVALID'));assert.equal(f.ai.listResults(f.product.id).length,0);
  assert.equal(f.ai.listCalls()[0].errorCode,'OUTPUT_INVALID');
  assert.deepEqual(f.ai.listCalls()[0].sourceColorContext,context);
  const files=readdirSync(join(f.directory,'ai-diagnostics'));const diagnostic=JSON.parse(readFileSync(join(f.directory,'ai-diagnostics',files[0]),'utf8'));
  assert.equal(diagnostic.operation,'source-color');assert.deepEqual(diagnostic.output.colors,['Stainless Steel']);
});

test('source-color rejects stale revision, spec, variant and image hash before network',async t=>{
  const f=await fixture(t),context=f.context();
  for(const bad of [{...context,productRevision:context.productRevision+1},{...context,variantId:randomUUID()},{...context,sourceSpec:'颜色分类: 602E'},{...context,referenceAssets:[{...context.referenceAssets[0],sha256:'0'.repeat(64)}]}])await assert.rejects(f.observe(bad),code('SOURCE_CHANGED'));
  assert.equal(f.requests.length,0);assert.equal(f.ai.listCalls().length,0);
});

test('source-color rejects withdrawn SKU binding and workflow-generated images',async t=>{
  const f=await fixture(t),context=f.context(),db=openDatabase(f.directory);
  try{
    db.prepare('UPDATE variant_assets SET confirmed=0 WHERE asset_id=?').run(context.referenceAssets[0].assetId);
    await assert.rejects(f.observe(context),code('SOURCE_CHANGED'));
    db.prepare('UPDATE variant_assets SET confirmed=1 WHERE asset_id=?').run(context.referenceAssets[0].assetId);
    db.prepare('INSERT INTO image_workflow_runs(id,record_json) VALUES(?,?)').run(randomUUID(),JSON.stringify({productId:f.product.id,slots:[{approvedAssetId:context.referenceAssets[0].assetId}]}));
    await assert.rejects(f.observe(context),code('SOURCE_CHANGED'));
  }finally{db.close();}
  assert.equal(f.requests.length,0);
});

test('source-color freshness reads actual bytes without any network and rejects replaced files',async t=>{
  const f=await fixture(t),context=f.context();await (f.ai as any).assertSourceColorFresh(context);
  const asset=f.store.getAssetRecord(context.referenceAssets[0].assetId)!;writeFileSync(join(f.directory,asset.originalPath),Buffer.from('changed pixels'));
  await assert.rejects((f.ai as any).assertSourceColorFresh(context),code('SOURCE_CHANGED'));
  await assert.rejects(f.observe(context),code('SOURCE_CHANGED'));assert.equal(f.requests.length,0);
});

test('source-color callback freshness after response blocks stale successful evidence',async t=>{
  const f=await fixture(t),context=f.context();let networkFinished=false;
  f.respond(p=>{networkFinished=true;return chat({kind:'source-color',verdict:'DETERMINED',colors:['Silver'],reason:'Visible product color.',referenceAssetIds:p.referenceImages.map((r:any)=>r.assetId)});});
  await assert.rejects(f.observe(context,()=>{if(networkFinished)throw new AiError('SOURCE_CHANGED');}),code('SOURCE_CHANGED'));
  assert.equal(f.ai.listResults(f.product.id).length,0);assert.equal(f.ai.listCalls()[0].status,'FAILED');
});

test('source-color enforces quota and keeps an unknown network reservation',async t=>{
  const f=await fixture(t),context=f.context();f.ai.setUsagePolicy({providerId:'deepseek',dailyCallLimit:0,dailyTokenLimit:null});
  await assert.rejects(f.observe(context),code('QUOTA_EXCEEDED'));assert.equal(f.requests.length,0);
  f.ai.setUsagePolicy({providerId:'deepseek',dailyCallLimit:null,dailyTokenLimit:null});f.respond(()=>{throw new Error('fixture offline');});
  await assert.rejects(f.observe(context),code('NETWORK_ERROR'));assert.equal(f.ai.listResults(f.product.id).length,0);
  assert.equal(f.ai.getUsageSummary('deepseek').unknownCalls,1);assert.ok(f.ai.getUsageSummary('deepseek').reservedTokens>4096);
});

test('source-color cancelled during a provider response cannot persist evidence',async t=>{
  const f=await fixture(t),context=f.context(),controller=new AbortController();
  f.respond(p=>{controller.abort();return chat({kind:'source-color',verdict:'DETERMINED',colors:['Silver'],reason:'Visible product color.',referenceAssetIds:p.referenceImages.map((r:any)=>r.assetId)});});
  await assert.rejects(f.observe(context,()=>{},controller.signal),code('CANCELLED'));assert.equal(f.ai.listResults(f.product.id).length,0);assert.equal(f.ai.listCalls()[0].status,'FAILED');
  assert.deepEqual(f.ai.listCalls()[0].sourceColorContext,context);
});

test('source-color persisted context and output survive backup and reject forged provenance',async t=>{
  const f=await fixture(t),result=await f.observe(f.context()),file=join(f.directory,'colors.htcbackup'),target=join(f.directory,'restored');
  for(const bad of [{...result,sourceColorContext:{...result.sourceColorContext,variantId:randomUUID()}},{...result,sourceSha256:'0'.repeat(64)},{...result,sourceColorRequestBytes:0},{...result,sourceResultIds:[randomUUID()]}])assert.throws(()=>validateAiResult(bad));
  await createWorkspaceBackup(f.directory,file,'source color backup passphrase');await commitWorkspaceRestore(target,await prepareWorkspaceRestore(target,file,'source color backup passphrase'));
  const db=openDatabase(target);try{assert.deepEqual(validateAiResult(JSON.parse(String(db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(result.id)!.record_json))),result);}finally{db.close();}
});

test('source-color contract accepts only finite exact colors and complete ordered source coverage',()=>{
  const refs=[randomUUID(),randomUUID()],context=validateSourceColorContext({policyVersion:'source-color/v1',productId:randomUUID(),productRevision:1,variantId:randomUUID(),sourceSpec:'颜色分类: 602E',referenceAssets:refs.map(assetId=>({assetId,sha256:'a'.repeat(64)}))});
  const output={kind:'source-color',verdict:'DETERMINED',colors:['Silver','Pink','Blue'],reason:'Product decoration is visible.',referenceAssetIds:refs};
  assert.deepEqual(validateSourceColorOutput(output),output);assertSourceColorOutput(validateSourceColorOutput(output),context);
  for(const colors of SOURCE_COLOR_VALUES)assert.doesNotThrow(()=>validateSourceColorOutput({...output,colors:[colors]}));
  for(const mutation of [{colors:[]},{colors:['Silver','Silver']},{colors:['silver']},{colors:['Multicolor','Red']},{verdict:'UNCERTAIN',colors:['Blue']},{verdict:'CONFLICTING',colors:['Blue']},{verdict:['DETERMINED']},{value:'Silver'},{referenceAssetIds:[refs[0],refs[0]]},{referenceAssetIds:[]}])assert.throws(()=>validateSourceColorOutput({...output,...mutation}),code('OUTPUT_INVALID'));
  for(const referenceAssetIds of [[refs[1],refs[0]],[refs[0]],[randomUUID(),refs[1]]])assert.throws(()=>assertSourceColorOutput(validateSourceColorOutput({...output,referenceAssetIds}),context),code('OUTPUT_INVALID'));
  for(const mutation of [{referenceAssets:[]},{referenceAssets:[context.referenceAssets[0],context.referenceAssets[0]]},{policyVersion:'source-color/v0'},{sourceSpec:' 602E '}])assert.throws(()=>validateSourceColorContext({...context,...mutation}),code('INVALID_INPUT'));
});

test('source-color can use an unbound image only for a provably single SKU',async t=>{
  const f=await fixture(t),old=f.store.getProduct(f.product.id);
  let product=f.store.updateAsset({productId:old.id,revision:old.revision,assetId:old.assets[0].id,role:'main',variantIds:[]});
  const input={...f.input,productRevision:product.revision},context=(f.ai as any).sourceColorContext(input);
  assert.equal((await f.observe(context)).output.verdict,'DETERMINED');
  product=f.store.saveProduct({...saveInput(product),variants:[...saveInput(product).variants,{id:randomUUID(),sku:'SECOND-SKU',originalSpec:'颜色分类: 602E',normalizedSpec:'',purchasePrice:'',inventory:null}]});
  assert.throws(()=>(f.ai as any).sourceColorContext({...input,productRevision:product.revision}));
});

test('source-color history rejects a failed call even when the observation JSON is well formed',async t=>{
  const f=await fixture(t),result=await f.observe(f.context()),db=openDatabase(f.directory);
  try{const call=f.ai.getCall(result.callId)!;db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify({...call,status:'FAILED',errorCode:'SOURCE_CHANGED'}),call.id);}finally{db.close();}
  await assert.rejects(createWorkspaceBackup(f.directory,join(f.directory,'forged.htcbackup'),'source color backup passphrase'));
});

test('source-color history rejects a forged source hash even when context hash is recomputed',async t=>{
  const f=await fixture(t),result=await f.observe(f.context()),forged=structuredClone(result);
  forged.sourceColorContext.referenceAssets[0].sha256='f'.repeat(64);forged.sourceSha256=listingFingerprint(forged.sourceColorContext);
  const db=openDatabase(f.directory);try{db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify(forged),result.id);}finally{db.close();}
  await assert.rejects(createWorkspaceBackup(f.directory,join(f.directory,'forged-hash.htcbackup'),'source color backup passphrase'));
});

test('source-color post-network pixel changes reject the response without persisting evidence',async t=>{
  const f=await fixture(t),context=f.context();
  f.respond(p=>{const asset=f.store.getAssetRecord(context.referenceAssets[0].assetId)!;writeFileSync(join(f.directory,asset.originalPath),Buffer.from('changed while request was pending'));return chat({kind:'source-color',verdict:'DETERMINED',colors:['Silver'],reason:'Visible product color.',referenceAssetIds:p.referenceImages.map((r:any)=>r.assetId)});});
  await assert.rejects(f.observe(context),code('SOURCE_CHANGED'));assert.equal(f.requests.length,1);assert.equal(f.ai.listResults(f.product.id).length,0);assert.equal(f.ai.listCalls()[0].status,'FAILED');
});

test('source-color backup retains historical context after text edits but rejects changed original pixels',async t=>{
  const f=await fixture(t),context=f.context(),result=await f.observe(context),product=f.store.getProduct(f.product.id);
  const changed=f.store.saveProduct({...saveInput(product),variants:saveInput(product).variants.map(v=>({...v,normalizedSpec:'  602Q corrected source text  '}))});
  assert.equal((f.ai as any).sourceColorContext({...f.input,productRevision:changed.revision}).sourceSpec,'602Q corrected source text');
  await assert.rejects((f.ai as any).assertSourceColorFresh(context),code('SOURCE_CHANGED'));
  await createWorkspaceBackup(f.directory,join(f.directory,'historical.htcbackup'),'source color backup passphrase');
  assert.equal(f.ai.getResult(result.id)!.sourceColorContext!.sourceSpec,'颜色分类: 602Q');
  const asset=f.store.getAssetRecord(context.referenceAssets[0].assetId)!;writeFileSync(join(f.directory,asset.originalPath),Buffer.from('replaced original'));
  await assert.rejects(createWorkspaceBackup(f.directory,join(f.directory,'changed-pixels.htcbackup'),'source color backup passphrase'));
});

test('failed source-color attempt context survives backup and restore without becoming evidence',async t=>{
  const f=await fixture(t),context=f.context();f.respond(()=>{throw new Error('fixture offline');});
  await assert.rejects(f.observe(context),code('NETWORK_ERROR'));const call=f.ai.listCalls()[0];
  assert.deepEqual(validateAiCall(call).sourceColorContext,context);assert.equal(f.ai.listResults(f.product.id).length,0);
  const file=join(f.directory,'failed-attempt.htcbackup'),target=join(f.directory,'failed-restored');
  await createWorkspaceBackup(f.directory,file,'source color backup passphrase');await commitWorkspaceRestore(target,await prepareWorkspaceRestore(target,file,'source color backup passphrase'));
  const db=openDatabase(target);try{assert.deepEqual(validateAiCall(JSON.parse(String(db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(call.id)!.record_json))),call);}finally{db.close();}
});

test('backup accepts real downstream color evidence and rejects a missing observation record',async t=>{
  const f=await fixture(t),observation=await f.observe(f.context());
  const amazon=new AmazonService(f.directory,id=>f.store.getProduct(id),mockStorage);
  try{
    const target=amazon.enableDemo(),draft=await amazon.createDraft({productId:f.product.id,variantId:f.product.variants[0].id,targetId:target.id,productType:'HTC_DEMO_STORAGE_BAG',parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'});
    const listing=new ListingAiService(f.store,amazon,f.ai),context=listing.currentContext(draft,f.store.getProduct(f.product.id),amazon.executionTargetScope(target.id).generation);
    assert.equal(context.evidence.find(e=>e.source==='source_image')?.imageObservation?.resultId,observation.id);
    f.respond(p=>chat({kind:'amazon-fields',candidates:[{field:'color',items:[{value:'Silver',evidenceIds:[p.evidence.find((e:any)=>e.source==='source_image').id],transformation:'copy'}]}],missing:p.fields.filter((field:any)=>field.name!=='color').map((field:any)=>({field:field.name,reason:'No additional verified details.'}))}));
    const result=await f.ai.listingFields(context,async()=>{});assert.deepEqual(result.listingContext,context);
    await createWorkspaceBackup(f.directory,join(f.directory,'downstream.htcbackup'),'source color backup passphrase');
    const db=openDatabase(f.directory);try{db.prepare('DELETE FROM ai_results WHERE id=?').run(observation.id);}finally{db.close();}
    await assert.rejects(createWorkspaceBackup(f.directory,join(f.directory,'missing-observation.htcbackup'),'source color backup passphrase'),/来源颜色/);
  }finally{amazon.close();}
});
