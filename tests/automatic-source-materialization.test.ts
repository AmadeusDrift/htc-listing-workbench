import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {WorkspaceStore} from '../src/main/store.ts';
import {openDatabase} from '../src/main/database.ts';
import {persistImport,getReceipt} from '../src/main/miaoshou/persistence.ts';
import {normalizeDetail} from '../src/main/miaoshou/normalize.ts';
import {detailFixture} from './helpers/miaoshou-fixture.ts';
import {MiaoshouImageService} from '../src/main/miaoshou/images.ts';
import {AutomaticListingService,type AutomaticListingDependencies} from '../src/main/automatic-listing/service.ts';
import {defaultListingRules} from '../src/shared/listing-rules.ts';
import {confirmSourceConsistencyFixture} from './helpers/source-consistency-proof.ts';
import {saveInput} from './fixtures/listing-ai.ts';
import {sourceStamp} from '../src/main/automatic-listing/records.ts';
import {UserFacingError} from '../src/shared/errors.ts';
import {randomUUID} from 'node:crypto';
import {resolveConsistencyContext} from '../src/main/source-image-consistency/scope.ts';
import {reserveConsistencyAttempt} from '../src/main/source-image-consistency/history.ts';
import {sourceConsistencyUnknown} from '../src/main/source-image-consistency/proof.ts';
import {validateAiCall} from '../src/main/ai/validation.ts';
import {validateAiUsageRecord} from '../src/main/ai/usage.ts';
import {ImageGenerationService} from '../src/main/image-generation/service.ts';
import {mockStorage} from './fixtures/listing-ai.ts';
import {DEFAULT_OPENROUTER_IMAGE_MODEL} from '../src/shared/image-generation-contracts.ts';
import {readImageRequestIntent} from '../src/main/ai/receipts.ts';
import {AiSpendBudget} from '../src/main/ai/spend-budget.ts';

async function fixture(t:test.TestContext,confirmed=true,preImage=false){
  t.mock.method(globalThis,'fetch',()=>{throw Error('No real external requests');});
  const root=resolve('.test-data');mkdirSync(root,{recursive:true});const directory=mkdtempSync(join(root,'materialized-source-'));
  const store=new WorkspaceStore(directory),db=openDatabase(directory),at=new Date(Date.now()-10_000).toISOString();
  const raw=detailFixture();raw.data.editCommonCollectBoxDetail.skuMap.arbitraryA.price=1;
  const snapshot=normalizeDetail(raw,at),mapping={priceField:'price' as const,currency:'CNY' as const,skus:snapshot.skus.map((v,i)=>({sourceKey:v.key,dimensions:{color:i?'opaqueRed':'opaqueBlue'}}))};
  const imported=persistImport(db,store,snapshot,mapping,'a'.repeat(64),'live',at),product=store.getProduct(imported.productId),receipt=getReceipt(db,product.id)!;
  const target={id:'fixture-store',name:'Fixture store',mode:'demo',sellerId:'fixture-seller',marketplaceId:'ATVPDKIKX0DER',marketplaceName:'US',region:'na',locale:'en_US',paused:false,configured:true,credentialUpdatedAt:at,lastError:null};
  const profile={id:'alpha',name:'Alpha',generation:1,enabled:true,configured:true,host:'ftp.example.test',port:21,secure:true,remoteRoot:'/',publicBaseUrl:'https://images.example.test/'};
  const rules=defaultListingRules();rules.product.variantLimit=2;let downloads=0,sourcePreparations=0,observations=0,draftPreparations=0;
  const imageService=new MiaoshouImageService(directory,store,()=>receipt,bytes=>bytes,{download:async()=>{downloads++;const png=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(13,8);png.write('IHDR',12);png.writeUInt32BE(1000+downloads,16);png.writeUInt32BE(1000,20);return png;}});
  const dependencies={store,rules:()=>rules,sourceReceipt:()=>getReceipt(db,product.id),hosting:{getProfile:()=>profile},
    amazon:{executionTargetScope:()=>({target,generation:1}),listDrafts:()=>[],getDraft:()=>{throw Error('No existing draft');},prepareDrafts:async()=>{draftPreparations++;throw new UserFacingError('Synthetic stop at draft boundary');}},
    images:{prepareSources:async()=>{sourcePreparations++;throw Error('Original bytes must be reused');},complete:async()=>{throw Error('No generated images');},getProgress:()=>null,cancel:()=>({cancelled:true}),cancelSources:()=>({cancelled:true})},
    prepareSourceConsistency:async(input:{variantIds:string[]})=>{observations++;await confirmSourceConsistencyFixture(directory,store,product.id,input.variantIds);},
    execution:{list:()=>[],waitForIdle:async()=>{}},followup:{get:()=>null},procurement:{candidates:()=>[]},labels:{list:()=>[]}
  } as unknown as AutomaticListingDependencies;
  let service=new AutomaticListingService(directory,dependencies);
  const task=await service.create({productIds:[product.id],targetId:target.id,profileId:'alpha',productType:'BOX'});
  assert.equal(task.items.length,2);assert.equal(product.revision,1);
  if(preImage){
    const generation=new ImageGenerationService(directory,store,mockStorage,{decodePreview:bytes=>bytes,fetch:async()=>{throw Error('synthetic pre-image transport lost');}});
    generation.saveConnection({model:DEFAULT_OPENROUTER_IMAGE_MODEL,enabled:true,apiKey:'synthetic-pre-image-only'});
    try{await assert.rejects(generation.generate({productId:product.id,productRevision:1,prompt:'Original manual product request',referenceAssetIds:[],size:'auto',quality:'auto',background:'auto'}));}finally{await generation.close();}
    const intents=db.prepare('SELECT record_json FROM ai_image_requests').all();assert.equal(intents.length,1);
    const intent=readImageRequestIntent(db,JSON.parse(String(intents[0].record_json)).id)!;
    assert.equal(intent.version,2);assert.equal(intent.productRevision,1);
    assert.equal(new AiSpendBudget(db).list()[0].state,'UNKNOWN');assert.equal(db.prepare('SELECT count(*) n FROM ai_calls').get()!.n,0);
  }
  const imageIds=[...new Set(receipt.skuMappings.flatMap(v=>v.imageIds))];
  const delivered=await imageService.download({productId:product.id,revision:1,imageIds});assert.deepEqual(delivered.failures,[]);assert.equal(delivered.product.revision,5);
  if(confirmed)await confirmSourceConsistencyFixture(directory,store,product.id);
  // Reproduce the old save boundary: first SKU was updated and froze the
  // source group, while the remaining original sibling kept revision 1.
  const historical=structuredClone(task);historical.status='PAUSED';
  historical.items[0].productRevision=5;historical.items[0].sourcesPrepared=true;historical.items[0].stage='DRAFT';historical.items[0].status='FAILED';historical.items[0].error='Original draft preparation failure';
  historical.items[1].status='FAILED';historical.items[1].error='来源商品或 SKU 发生变化，请重新建立任务';
  await service.close();db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(historical),historical.id);
  service=new AutomaticListingService(directory,dependencies);
  t.after(async()=>{await service.close();await imageService.close();db.close();store.close();rmSync(directory,{recursive:true,force:true});});
  return{directory,store,db,service,task:historical,snapshot,mapping,receipt,counters:()=>({downloads,sourcePreparations,observations,draftPreparations})};
}

test('a real pre-image generation intent and UNKNOWN spend prevent materialization rebasing with zero call rows',async t=>{
  const f=await fixture(t,false,true),row=f.task.items[1],selection={mode:'targeted' as const,selections:[{key:row.key}]};
  const history=()=>['ai_image_requests','ai_spend_reservations','ai_calls','automatic_listing_tasks'].map(table=>f.db.prepare(`SELECT record_json FROM ${table} ORDER BY id`).all());
  const before=history();
  assert.throws(()=>f.service.prepareStart(f.task.id,selection),/来源商品或 SKU/);
  assert.deepEqual(history(),before);assert.equal(f.service.get(f.task.id).items[1].productRevision,1);
  assert.equal(new AiSpendBudget(f.db).list()[0].state,'UNKNOWN');assert.deepEqual(f.counters(),{downloads:2,sourcePreparations:0,observations:0,draftPreparations:0});
});

for(const confirmed of [true,false])test(`explicit continue rebases original source-only sibling and reuses delivered bytes; observation already confirmed=${confirmed}`,async t=>{
  const f=await fixture(t,confirmed),row=f.task.items[1],selection={mode:'targeted' as const,selections:[{key:row.key}]};
  const before=f.service.get(f.task.id).items[0],stamp=sourceStamp(f.store.getProduct(f.task.items[0].productId));
  const approved=f.service.prepareStart(f.task.id,selection);
  assert.equal(approved.items[1].productRevision,1,'read-only admission cannot mutate the original row');
  f.service.startAuthorized(approved,selection);await f.service.waitForIdle();
  const saved=f.service.get(f.task.id),after=saved.items[1];
  assert.equal(after.key,row.key);assert.equal(after.sku,row.sku);assert.equal(after.productRevision,5);assert.equal(after.sourcesPrepared,true);assert.equal(after.stage,'DRAFT');
  assert.match(after.error!,/Synthetic stop at draft boundary/);assert.deepEqual(saved.items[0],before);
  assert.equal(sourceStamp(f.store.getProduct(row.productId)),stamp);assert.equal(f.store.getProduct(row.productId).revision,5);
  assert.deepEqual(f.counters(),{downloads:2,sourcePreparations:0,observations:confirmed?0:1,draftPreparations:1});
  const audit=f.db.prepare("SELECT detail_json FROM audit_events WHERE action='automatic-listing.source-materialization-rebased'").all();
  assert.equal(audit.length,1);assert.deepEqual(JSON.parse(String(audit[0].detail_json)),{version:1,taskId:f.task.id,itemKey:row.key,fromRevision:1,toRevision:5,sourceStamp:row.sourceStamp});
});

test('an original unknown source request and its reserved usage survive historical continuation without a replacement call',async t=>{
  const f=await fixture(t),row=f.task.items[1],product=f.store.getProduct(row.productId),at=new Date().toISOString();
  const context=resolveConsistencyContext(f.db,f.store,f.directory,{productId:product.id,productRevision:product.revision,variantId:row.variantId});
  const call=validateAiCall({id:randomUUID(),providerId:'deepseek',productId:product.id,productRevision:product.revision,status:'FAILED',errorCode:'CANCELLED',requestId:null,model:'deepseek-flash',generation:1,startedAt:at,finishedAt:at,usage:{promptTokens:0,completionTokens:0,processedImages:0},sourceConsistencyContext:context});
  const usage=validateAiUsageRecord({id:call.id,providerId:call.providerId,day:at.slice(0,10),startedAt:at,finishedAt:at,state:'UNKNOWN',reservedTokens:8192,usage:call.usage});
  f.db.prepare('INSERT INTO ai_calls VALUES(?,?)').run(call.id,JSON.stringify(call));f.db.prepare('INSERT INTO ai_usage_ledger VALUES(?,?)').run(call.id,JSON.stringify(usage));reserveConsistencyAttempt(f.db,context,call);
  const history=()=>['ai_calls','ai_usage_ledger','source_consistency_attempts','automatic_listing_tasks'].map(table=>f.db.prepare(`SELECT record_json FROM ${table} ORDER BY id`).all());
  const before=history();assert.equal(sourceConsistencyUnknown(f.db,product.id,[row.variantId]),true);
  assert.throws(()=>f.service.prepareStart(f.task.id,{mode:'targeted',selections:[{key:row.key}]}),/来源商品或 SKU/);
  assert.deepEqual(history(),before);assert.equal(sourceConsistencyUnknown(f.db,product.id,[row.variantId]),true);assert.deepEqual(f.counters(),{downloads:2,sourcePreparations:0,observations:0,draftPreparations:0});
});

test('a failed materialization audit rolls back row rebasing and explicit retry retains the original SKU',async t=>{
  const f=await fixture(t),row=f.task.items[1],selection={mode:'targeted' as const,selections:[{key:row.key}]};
  f.db.exec("CREATE TRIGGER reject_materialization_audit BEFORE INSERT ON audit_events WHEN NEW.action='automatic-listing.source-materialization-rebased' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  f.service.startAuthorized(f.service.prepareStart(f.task.id,selection),selection);await f.service.waitForIdle();
  assert.equal(f.service.get(f.task.id).items[1].productRevision,1);assert.equal(f.db.prepare("SELECT 1 FROM audit_events WHERE action='automatic-listing.source-materialization-rebased'").get(),undefined);
  assert.deepEqual(f.counters(),{downloads:2,sourcePreparations:0,observations:0,draftPreparations:0});
  f.db.exec('DROP TRIGGER reject_materialization_audit');
  f.service.startAuthorized(f.service.prepareStart(f.task.id,selection),selection);await f.service.waitForIdle();
  const resumed=f.service.get(f.task.id).items[1];assert.equal(resumed.sku,row.sku);assert.equal(resumed.key,row.key);assert.equal(resumed.productRevision,5);assert.equal(resumed.stage,'DRAFT');
});

for(const change of ['fact','binding','bytes','missing-audit','pending-source','original-unknown','extra-revision'] as const)test(`source-only historical continuation refuses ${change} and retains original identity`,async t=>{
  const f=await fixture(t),row=f.task.items[1],product=f.store.getProduct(row.productId);
  if(change==='fact')f.store.saveProduct({...saveInput(product),title:'Different source facts'});
  if(change==='binding'){const a=product.assets.find(a=>a.variantIds.includes(row.variantId))!;f.store.updateAsset({productId:product.id,revision:product.revision,assetId:a.id,role:a.role,variantIds:[]});}
  if(change==='bytes'){const a=product.assets[0],path=join(f.directory,'assets',a.id+'.png'),bytes=readFileSync(path);bytes[32]=8;writeFileSync(path,bytes);}
  if(change==='missing-audit')f.db.prepare("DELETE FROM audit_events WHERE product_id=? AND action='assets.imported'").run(product.id);
  if(change==='pending-source')persistImport(f.db,f.store,{...f.snapshot,title:'Incoming source version'},f.mapping,'a'.repeat(64),'live',new Date().toISOString());
  if(change==='extra-revision')f.db.prepare('UPDATE products SET revision=revision+1 WHERE id=?').run(product.id);
  if(change==='original-unknown'){
    const saved=(f.service as any).tasks.get(f.task.id),item=saved.items[1];item.outcome={version:1,kind:'UNKNOWN',code:'SOURCE_CONSISTENCY_SENT_UNKNOWN',message:'Original unknown request',classifiedAt:new Date().toISOString(),scope:{mode:saved.mode,sellerId:saved.sellerId,marketplaceId:saved.marketplaceId,productId:item.productId,recipeKey:item.variantId,recipeStamp:'a'.repeat(64),sourceStamp:item.sourceStamp,rulesStamp:saved.rulesStamp,ruleRevision:saved.ruleRevision},draftId:null,draftRevision:null};
  }
  assert.throws(()=>f.service.prepareStart(f.task.id,{mode:'targeted',selections:[{key:row.key}]}),/来源商品或 SKU/);
  assert.equal(f.service.get(f.task.id).items[1].productRevision,1);assert.deepEqual(f.counters(),{downloads:2,sourcePreparations:0,observations:0,draftPreparations:0});
});
