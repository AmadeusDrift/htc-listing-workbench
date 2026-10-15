import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
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


import {UserFacingError} from '../src/shared/errors.ts';
import {randomUUID} from 'node:crypto';
import {resolveConsistencyContext} from '../src/main/source-image-consistency/scope.ts';
import {reserveConsistencyAttempt} from '../src/main/source-image-consistency/history.ts';
import {sourceConsistencyUnknown} from '../src/main/source-image-consistency/proof.ts';
import {validateAiCall} from '../src/main/ai/validation.ts';
import {validateAiUsageRecord} from '../src/main/ai/usage.ts';

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
    generation.saveConnection({model,enabled:true,apiKey:'synthetic-pre-image-only'});
    try{await assert.rejects(generation.generate({productId:product.id,productRevision:1,prompt:'Original manual product request',referenceAssetIds:[],size:'auto',quality:'auto',background:'auto'}));}finally{await generation.close();}
    const intents=db.prepare('SELECT record_json FROM ai_image_requests').all();assert.equal(intents.length,1);assert.equal(readImageRequestIntent(db,JSON.parse(String(intents[0].record_json)).id)!.productRevision,1);
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

import {ImageGenerationService} from '../src/main/image-generation/service.ts';
import {mockStorage} from './fixtures/listing-ai.ts';
import {DEFAULT_OPENROUTER_IMAGE_MODEL as model} from '../src/shared/image-generation-contracts.ts';
import {readImageRequestIntent} from '../src/main/ai/receipts.ts';
import {AiSpendBudget} from '../src/main/ai/spend-budget.ts';

test('materialization refuses a real pre-image manual generation UNKNOWN and keeps original hold',async t=>{
 const f=await fixture(t,false,true),row=f.task.items[1],selection={mode:'targeted' as const,selections:[{key:row.key}]};
 const history=()=>['ai_image_requests','ai_spend_reservations','automatic_listing_tasks'].map(table=>f.db.prepare(`SELECT record_json FROM ${table} ORDER BY id`).all());
 const before=history();
 assert.throws(()=>f.service.prepareStart(f.task.id,selection),/来源商品或 SKU/);
 assert.deepEqual(history(),before);assert.equal(f.service.get(f.task.id).items[1].productRevision,1);
});

test('materialization refuses UNKNOWN source observation owned by another sibling',async t=>{
 const f=await fixture(t),row=f.task.items[1],sibling=f.task.items[0],product=f.store.getProduct(row.productId),at=new Date().toISOString();
 const context=resolveConsistencyContext(f.db,f.store,f.directory,{productId:product.id,productRevision:product.revision,variantId:sibling.variantId});
 const call=validateAiCall({id:randomUUID(),providerId:'deepseek',productId:product.id,productRevision:product.revision,status:'FAILED',errorCode:'CANCELLED',requestId:null,model:'deepseek-flash',generation:1,startedAt:at,finishedAt:at,usage:{promptTokens:0,completionTokens:0,processedImages:0},sourceConsistencyContext:context});
 const usage=validateAiUsageRecord({id:call.id,providerId:call.providerId,day:at.slice(0,10),startedAt:at,finishedAt:at,state:'UNKNOWN',reservedTokens:8192,usage:call.usage});
 f.db.prepare('INSERT INTO ai_calls VALUES(?,?)').run(call.id,JSON.stringify(call));f.db.prepare('INSERT INTO ai_usage_ledger VALUES(?,?)').run(call.id,JSON.stringify(usage));reserveConsistencyAttempt(f.db,context,call);
 assert.equal(sourceConsistencyUnknown(f.db,product.id,[row.variantId]),false);assert.equal(sourceConsistencyUnknown(f.db,product.id,[sibling.variantId]),true);
 assert.throws(()=>f.service.prepareStart(f.task.id,{mode:'targeted',selections:[{key:row.key}]}),/来源商品或 SKU/);
 assert.equal(f.service.get(f.task.id).items[1].productRevision,1);
 assert.equal(String(f.db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(call.id)!.record_json),JSON.stringify(call));
 assert.equal(String(f.db.prepare('SELECT record_json FROM ai_usage_ledger WHERE id=?').get(call.id)!.record_json),JSON.stringify(usage));
});

test('materialization task write failure rolls back a successfully inserted rebase audit',async t=>{
 const f=await fixture(t),row=f.task.items[1],selection={mode:'targeted' as const,selections:[{key:row.key}]};
 f.db.exec("CREATE TRIGGER reject_materialization_save BEFORE UPDATE ON automatic_listing_tasks WHEN json_extract(NEW.record_json,'$.items[1].productRevision')=5 BEGIN SELECT RAISE(ABORT,'synthetic task save failure'); END");
 f.service.startAuthorized(f.service.prepareStart(f.task.id,selection),selection);await f.service.waitForIdle();
 const durable=JSON.parse(String(f.db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(f.task.id)!.record_json));
 assert.equal(durable.items[1].productRevision,1);assert.equal(f.service.get(f.task.id).items[1].productRevision,1);
 assert.equal(f.db.prepare("SELECT count(*) n FROM audit_events WHERE action='automatic-listing.source-materialization-rebased'").get()!.n,0);
 assert.deepEqual(f.counters(),{downloads:2,sourcePreparations:0,observations:0,draftPreparations:0});
 f.db.exec('DROP TRIGGER reject_materialization_save');
 f.service.startAuthorized(f.service.prepareStart(f.task.id,selection),selection);await f.service.waitForIdle();
 assert.equal(f.service.get(f.task.id).items[1].productRevision,5);
 assert.equal(f.db.prepare("SELECT count(*) n FROM audit_events WHERE action='automatic-listing.source-materialization-rebased'").get()!.n,1);
});
