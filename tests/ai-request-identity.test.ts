import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/main/database.ts';
import { AiService } from '../src/main/ai/service.ts';
import { fixture, holdFetch, isCode, storage } from './fixtures/ai-control.ts';
import { sameRequestBusiness, requestScope, validateRequestScope } from '../src/main/ai/request-identity.ts';
import { createWorkspaceBackup,prepareWorkspaceRestore,discardPreparedRestore,commitWorkspaceRestore } from '../src/main/backup.ts';
import { join } from 'node:path';
import { readFile,writeFile } from 'node:fs/promises';
import { localAiRequestResolved } from '../src/main/ai/request-certainty.ts';
import { ReviewedContentService } from '../src/main/content/service.ts';
import { WorkspaceStore } from '../src/main/store.ts';
import { HostingService } from '../src/main/hosting/service.ts';
import { randomUUID } from 'node:crypto';
import { fixture as listingFixture } from './fixtures/listing-ai.ts';
import { validateListingContext } from '../src/main/listing-ai/validation.ts';

for(const failure of ['network','gateway'] as const)test(`manual ${failure} UNKNOWN cannot create a new POST after key/model/revision/restart`,async t=>{
  const f=await fixture(t,{fetch:async()=>{if(failure==='network')throw Error('fixture disconnected');return Response.json({error:{message:'Upstream unavailable'}},{status:500});}});f.enable('deepseek');
  await assert.rejects(f.service.suggest(f.textInput));const original=f.service.listCalls()[0];
  const unknown=(error:any)=>error.code==='INTERRUPTED'&&error.callId===original.id;
  await assert.rejects(f.service.suggest(f.textInput),unknown);assert.equal(f.requests.length,1);
  f.service.importProfile({id:'deepseek',model:'deepseek-v4-pro',apiKey:'fixture-rotated-key'});
  await assert.rejects(f.service.suggest(f.textInput),unknown);assert.equal(f.requests.length,1);
  const db=openDatabase(f.directory);db.prepare('UPDATE products SET revision=revision+1 WHERE id=?').run(f.product.id);db.close();
  await assert.rejects(f.service.suggest({...f.textInput,productRevision:f.product.revision+1}),unknown);
  await f.service.close();let freshPosts=0;
  const reopened=new AiService(f.directory,f.store,f.hosting,storage,{fetch:async()=>{freshPosts++;throw Error('must not send');}});
  try {await assert.rejects(reopened.suggest({...f.textInput,productRevision:f.product.revision+1}),unknown);assert.equal(freshPosts,0);assert.deepEqual(reopened.listCalls()[0],original);}finally{await reopened.close();}
});

test('late valid manual receipt restores locally with original frozen model, no key and unchanged paid call',async t=>{
  const held=holdFetch(),f=await fixture(t,{fetch:held.fetch});f.enable('deepseek');
  const controller=new AbortController(),pending=f.service.suggest(f.textInput,controller.signal),rejected=assert.rejects(pending,isCode('CANCELLED'));
  await held.started;controller.abort();await rejected;held.release();while(f.service.busy)await new Promise(resolve=>setTimeout(resolve,5));
  const original=f.service.listCalls()[0],date=original.startedAt.slice(0,10),before=f.service.getUsageReport({from:date,to:date});
  const purpose=f.service.getPurposeProfiles().find(profile=>profile.purposeId==='listing_generation')!;
  f.service.savePurposeProfile({purposeId:purpose.purposeId,expectedRevision:purpose.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-astra',effort:'high'}});
  f.service.disconnectConnection('deepseek');
  const result=await f.service.suggest(f.textInput);assert.equal(f.requests.length,1);assert.equal(result.callId,original.id);assert.equal(result.model,original.model);assert.ok(result.providerReceiptRecovery);
  assert.deepEqual(f.service.listCalls()[0],original);assert.deepEqual(f.service.getUsageReport({from:date,to:date}),before);
  const repeated=await f.service.suggest(f.textInput);assert.equal(repeated.id,result.id);assert.equal(f.requests.length,1);
});

test('stable request scopes ignore repair/key/model/task/revision and do not use a replacement candidate to evade UNKNOWN',()=>{
  const productId='11111111-1111-4111-8111-111111111111',variantId='22222222-2222-4222-8222-222222222222';
  const profile:any={id:'deepseek',capability:'text',model:'deepseek-flash',generation:1};
  const source:any={operation:'image-text-review',context:{listing:{variantId,sku:'SYN-1',targetId:'demo',marketplaceId:'US'},slot:{index:2}},candidate:{sha256:'a'.repeat(64)}};
  const first=requestScope(profile,{productId},source),second=requestScope({...profile,generation:9,model:'deepseek-v4-pro'},{productId},{...source,workflowId:'new',repair:{changed:true},context:{...source.context,listing:{...source.context.listing,productRevision:7}},candidate:{sha256:'b'.repeat(64)}});
  assert.equal(sameRequestBusiness(first,second),true);
  assert.equal(sameRequestBusiness(first,{...second,sku:'CHANGED-SKU'}),true);
  assert.throws(()=>validateRequestScope({...first,nonce:'renderer'}));
  let accessed=false;const malformed={...first};Object.defineProperty(malformed,'sku',{get(){accessed=true;return 'OTHER';}});assert.throws(()=>validateRequestScope(malformed));assert.equal(accessed,false);
  assert.equal(sameRequestBusiness(first,{...second,variantId:'33333333-3333-4333-8333-333333333333'}),false);
});

test('virtual sales identity is compared to virtual identity before supplier component sets',()=>{
  const productId=randomUUID(),virtual=randomUUID(),supplier=randomUUID();
  const modern:any={version:1,productId,operation:'listing-fields',variantId:virtual,variantIds:[supplier]},legacy:any={version:1,productId,operation:'listing-fields',variantId:virtual};
  assert.equal(sameRequestBusiness(modern,legacy),true);
  assert.equal(sameRequestBusiness(modern,{...legacy,variantId:randomUUID()}),false);
  const {variantId:_primary,...components}=modern;assert.equal(sameRequestBusiness(components,{...components,variantIds:[supplier,randomUUID()].sort()}),true);assert.equal(sameRequestBusiness(components,{...components,variantIds:[randomUUID()]}),false);
});

for(const raw of ['', '   '])test(`complete HTTP200 ${JSON.stringify(raw)} is received invalid while fees remain unknown`,async t=>{
  const f=await fixture(t,{fetch:async()=>new Response(raw,{status:200})});f.enable('deepseek');await assert.rejects(f.service.suggest(f.textInput),isCode('OUTPUT_INVALID'));const call=f.service.listCalls()[0],receipt:any=await f.service.readProviderReceipt(call.id),db=openDatabase(f.directory);
  try{assert.equal(receipt.body,raw);assert.equal(localAiRequestResolved(db,f.directory,call.id,call),true);}finally{db.close();}
  assert.equal(f.requests.length,1);assert.equal(f.service.getUsageSummary('deepseek').unknownCalls,1);assert.equal(f.service.listResults(f.product.id).length,0);
});

for(const echo of [false,true])test(`complete invalid UTF8 receipt ${echo?'echo omitted':'opaque'} has strict backup proof and no invented result or fee`,async t=>{
  const bytes=Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(echo?'fixture-api-key':'synthetic-wire')]),f=await fixture(t,{fetch:async()=>new Response(bytes)});f.enable('deepseek');await assert.rejects(f.service.suggest(f.textInput),isCode('OUTPUT_INVALID'));const call=f.service.listCalls()[0],receipt:any=await f.service.readProviderReceipt(call.id),db=openDatabase(f.directory);
  try{assert.equal(localAiRequestResolved(db,f.directory,call.id,call),!echo);}finally{db.close();}
  if(echo){assert.equal(receipt.body,'[omitted: credential echo]');assert.doesNotMatch(JSON.stringify(receipt),/fixture-api-key|base64/);}else{assert.deepEqual(Buffer.from(receipt.body.base64,'base64'),bytes);assert.equal(receipt.body.complete,true);await createWorkspaceBackup(f.directory,join(f.directory,'opaque.htcbackup'),'s02-synthetic-passphrase');}
  assert.equal(f.requests.length,1);assert.equal(f.service.listResults(f.product.id).length,0);assert.equal(f.service.getUsageSummary('deepseek').unknownCalls,1);
});

test('actual AiService supplier-set context cannot replace a legacy unresolved call with the same primary sales identity',async t=>{
  const f=await listingFixture(t);f.respond(()=>{throw Error('synthetic disconnected');});await assert.rejects(f.listing.suggest(f.reference));
  const original=f.ai.listCalls().find(call=>call.presentationContext?.kind==='listing')!,db=openDatabase(f.directory);
  const {requestScope:_scope,requestFingerprint:_fingerprint,...legacy}=original;db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(legacy),original.id);db.close();
  const context=f.listing.currentContext(f.amazon.getDraft(f.draft.id),f.store.getProduct(f.product.id),f.amazon.executionTargetScope(f.draft.targetId).generation);
  // This main-only context fixture models the two identity namespaces without
  // pretending the supplier ID is the legacy primary sales-variant ID.
  context.sourceProduct!.salesRecipe={recipe:{components:[{variantId:randomUUID()}]}} as any;
  validateListingContext(context);
  const outcome:any=await f.ai.listingFields(context,async()=>{}).catch(error=>error);assert.equal(f.requests.length,1,'same primary sales identity must not create a replacement provider POST');assert.equal(outcome.code,'INTERRUPTED');assert.equal(outcome.callId,original.id);
});

test('backup verifies original recovered receipt identity and rejects altered raw bytes without changing paid history',async t=>{
  const held=holdFetch(),f=await fixture(t,{fetch:held.fetch});f.enable('deepseek');
  const controller=new AbortController(),pending=f.service.suggest(f.textInput,controller.signal),rejected=assert.rejects(pending,isCode('CANCELLED'));
  await held.started;controller.abort();await rejected;held.release();while(f.service.busy)await new Promise(resolve=>setTimeout(resolve,5));
  const result=await f.service.suggest(f.textInput),original=f.service.listCalls()[0],backup=join(f.directory,'valid.htcbackup');
  await createWorkspaceBackup(f.directory,backup,'s02-synthetic-passphrase');
  const restored=await prepareWorkspaceRestore(f.directory,backup,'s02-synthetic-passphrase');
  const snapshot=openDatabase(restored.stagingDirectory);try{assert.deepEqual(JSON.parse(String(snapshot.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(original.id)!.record_json)),original);assert.equal(JSON.parse(String(snapshot.prepare('SELECT record_json FROM ai_results WHERE id=?').get(result.id)!.record_json)).providerReceiptRecovery.receiptId,result.providerReceiptRecovery!.receiptId);}finally{snapshot.close();}
  await discardPreparedRestore(f.directory,restored);assert.equal(f.requests.length,1);
  const path=join(f.directory,'ai-receipts',result.providerReceiptRecovery!.receiptId+'.json'),bytes=await readFile(path);
  await writeFile(path,Buffer.alloc(bytes.length,32));
  await assert.rejects(createWorkspaceBackup(f.directory,join(f.directory,'damaged.htcbackup'),'s02-synthetic-passphrase'));
  assert.throws(()=>f.service.getResult(result.id),isCode('INVALID_CONFIG'));assert.equal(f.requests.length,1);assert.deepEqual(f.service.listCalls()[0],original);
});

test('legacy manual unknown without exact scope never treats missing identity as permission to send',async t=>{
  const f=await fixture(t,{fetch:async()=>{throw Error('fixture disconnected');}});f.enable('deepseek');await assert.rejects(f.service.suggest(f.textInput));const original=f.service.listCalls()[0];
  const db=openDatabase(f.directory);const {requestScope:_scope,requestFingerprint:_fingerprint,...legacy}=original;db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(legacy),original.id);db.close();
  await assert.rejects(f.service.suggest(f.textInput),(error:any)=>error.code==='INTERRUPTED'&&error.callId===original.id&&/缺少完整业务身份/.test(error.message));assert.equal(f.requests.length,1);
});

test('SHUTDOWN drains late receipt and usage before closing SQLite, with zero automatic result adoption',async t=>{
  const held=holdFetch(),f=await fixture(t,{fetch:held.fetch});f.enable('deepseek');
  const pending=f.service.suggest(f.textInput),rejected=assert.rejects(pending,(error:any)=>error.code==='CANCELLED'&&error.abortSource==='SHUTDOWN');await held.started;
  const closing=f.service.close();await rejected;held.release();await closing;
  const reopened=new AiService(f.directory,f.store,f.hosting,storage,{fetch:async()=>{throw Error('unexpected POST');}});
  try{const calls=reopened.listCalls();assert.equal(calls.length,1);assert.equal(calls[0].errorCode,'CANCELLED');assert.equal(calls[0].usage.promptTokens,23);assert.ok(await reopened.readProviderReceipt(calls[0].id));assert.equal(reopened.listResults(f.product.id).length,0);assert.equal(f.requests.length,1);}finally{await reopened.close();}
});

for(const status of [401,402,403,429])for(const [body,expected] of [[{},true],['Unauthorized',true],['',false]] as const)test(`complete ${status} ${JSON.stringify(body)} has evidence-based certainty without declaring zero fees`,async t=>{
  const f=await fixture(t,{fetch:async()=>body===''?new Response('',{status}):Response.json(body,{status})});f.enable('deepseek');await assert.rejects(f.service.suggest(f.textInput));const call=f.service.listCalls()[0],db=openDatabase(f.directory);
  try{assert.equal(localAiRequestResolved(db,f.directory,call.id,call),expected);}finally{db.close();}
  assert.equal(f.requests.length,1);assert.equal(f.service.getUsageSummary('deepseek').unknownCalls,1);
});

test('recovered manual text can be explicitly reviewed, adopted and backed up without rewriting its paid generation',async t=>{
  const held=holdFetch(),f=await fixture(t,{fetch:held.fetch});f.enable('deepseek');f.enable('deepseek-review');
  const controller=new AbortController(),pending=f.service.suggest(f.textInput,controller.signal),rejected=assert.rejects(pending,isCode('CANCELLED'));await held.started;controller.abort();await rejected;held.release();while(f.service.busy)await new Promise(resolve=>setTimeout(resolve,5));
  const original=f.service.listCalls()[0],generation=await f.service.suggest(f.textInput);assert.equal(f.requests.length,1);
  const review=await f.service.review({productId:f.product.id,productRevision:f.product.revision,suggestionResultId:generation.id});
  const content=new ReviewedContentService(f.directory,f.store,f.service);
  try{await content.adopt({productId:f.product.id,productRevision:f.product.revision,reviewResultId:review.id});assert.equal(f.requests.length,2);assert.deepEqual(f.service.listCalls().find(call=>call.id===original.id),original);await createWorkspaceBackup(f.directory,join(f.directory,'adopted-recovery.htcbackup'),'s02-synthetic-passphrase');}finally{content.close();}
});

test('restoring a backup from before a manual UNKNOWN retains whole call scope and rejects all replacement sends',async t=>{
  const f=await fixture(t,{fetch:async()=>{throw Error('fixture disconnected');}});f.enable('deepseek');const backup=join(f.directory,'before-manual-call.htcbackup');await createWorkspaceBackup(f.directory,backup,'s02-synthetic-passphrase');
  await assert.rejects(f.service.suggest(f.textInput));const original=f.service.listCalls()[0],db=openDatabase(f.directory),raw=String(db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(original.id)!.record_json);db.close();
  const prepared=await prepareWorkspaceRestore(f.directory,backup,'s02-synthetic-passphrase'),snapshot=openDatabase(prepared.stagingDirectory);
  try{assert.equal(snapshot.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(original.id)?.record_json,raw);}finally{snapshot.close();}
  await f.service.close();await f.hosting.close();f.closeStore();await commitWorkspaceRestore(f.directory,prepared);
  const store=new WorkspaceStore(f.directory),hosting=new HostingService(f.directory,store,storage);let posts=0;const ai=new AiService(f.directory,store,hosting,storage,{fetch:async()=>{posts++;throw Error('must not send');}});
  try{ai.importProfile({id:'deepseek',model:'deepseek-v4-pro',apiKey:'synthetic-restored-key'});ai.setEnabled({id:'deepseek',enabled:true});await assert.rejects(ai.suggest(f.textInput),(error:any)=>error.code==='INTERRUPTED'&&error.callId===original.id);assert.equal(posts,0);assert.deepEqual(ai.listCalls().find(call=>call.id===original.id),original);}finally{await ai.close();await hosting.close();store.close();}
});
