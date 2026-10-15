import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {AutomaticListingService,type AutomaticListingDependencies} from '../src/main/automatic-listing/service.ts';
import {ControlledRunScopes,readControlledRunScope} from '../src/main/application/controlled-run-scope.ts';
import {openDatabase} from '../src/main/database.ts';
import {sourceStamp,validateAutomaticListingTask} from '../src/main/automatic-listing/records.ts';
import {fingerprint} from '../src/main/execution/records.ts';
import {defaultListingRules} from '../src/shared/listing-rules.ts';
import {DEFAULT_ITEM_LABEL_FORMAT} from '../src/shared/item-label-contracts.ts';
import type {ProductDetail} from '../src/shared/contracts.ts';
import {transaction} from '../src/main/application/transaction.ts';

async function fixture(t:test.TestContext,ordinaryFirst=false){
 await mkdir(resolve('.test-data'),{recursive:true});const root=await mkdtemp(resolve('.test-data/s08-task-')),db=openDatabase(root),now=new Date().toISOString(),rules=defaultListingRules(),target={id:'s08-target',name:'Synthetic',mode:'live',sellerId:'s08-seller',marketplaceId:'ATVPDKIKX0DER',marketplaceName:'US',region:'na',locale:'en_US',paused:false,configured:true,credentialUpdatedAt:now,lastError:null},profile={id:'alpha',enabled:true,configured:true,generation:1},products=[0,1,2].map(index=>({id:randomUUID(),revision:1,title:'Synthetic source',sourceUrl:'',description:'',status:'draft',origin:'manual',createdAt:now,updatedAt:now,facts:[],assets:[],variants:[{id:randomUUID(),sku:`S08-OWNER-${index}`,originalSpec:'one',normalizedSpec:'one',sourceSpec:'one',purchasePrice:'1',sourcePurchasePrice:'1',inventory:null}]} as ProductDetail));
 const makeTask=(selected:ProductDetail[])=>validateAutomaticListingTask({id:randomUUID(),revision:1,status:'CREATED',targetId:target.id,targetName:target.name,sellerId:target.sellerId,marketplaceId:target.marketplaceId,mode:'live',targetStamp:fingerprint({target,generation:1}),profileId:'alpha',profileStamp:fingerprint(profile),rulesStamp:fingerprint(rules),ruleRevision:rules.revision,productType:'BOX',locale:'en_US',labelFormat:DEFAULT_ITEM_LABEL_FORMAT,createdAt:now,updatedAt:now,error:null,items:selected.map(product=>({key:product.id+':'+product.variants[0].id,productId:product.id,productRevision:1,sourceStamp:sourceStamp(product),productTitle:product.title,variantId:product.variants[0].id,sku:product.variants[0].sku,stockSets:5,sourcesPrepared:false,status:'PENDING',stage:'SOURCES',draftId:null,executionTaskIds:[],imageStarted:false,imageAttempts:0,repairAttempts:0,repair:null,batchId:null,error:null}))});
 const task=makeTask(products.slice(0,2)),ordinary=makeTask(products.slice(2));for(const value of ordinaryFirst?[ordinary,task]:[task,ordinary])db.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(value.id,JSON.stringify(value));
 const scopes=new ControlledRunScopes(db),scope=scopes.register({taskId:task.id,expectedTaskRevision:1,targetId:target.id,sellerId:target.sellerId,marketplaceId:target.marketplaceId,items:task.items.map(row=>({itemKey:row.key,sku:row.sku,productId:row.productId,variantIds:[row.variantId],recipeKey:null,parentage:'NONE'}))}),calls:string[]=[];let callback:(product:ProductDetail)=>void|Promise<void>=()=>{};
 const dependencies={store:{getProduct:(id:string)=>structuredClone(products.find(p=>p.id===id)!)},rules:()=>rules,amazon:{executionTargetScope:()=>({target,generation:1}),listDrafts:()=>[]},hosting:{getProfile:()=>profile},images:{getProgress:()=>null,async prepareSources(input:any){const product=products.find(p=>p.id===input.productId)!;calls.push(product.id);await callback(product);return{product:structuredClone(product),missing:[{variantId:product.variants[0].id,message:'Synthetic source boundary stop'}]};},cancelSources:()=>({cancelled:true}),cancel:()=>({cancelled:true})},execution:{list:()=>[]},followup:{},procurement:{candidates:()=>[]},labels:{}} as unknown as AutomaticListingDependencies;
 let owner=new AutomaticListingService(root,dependencies);t.after(async()=>{await owner.close();db.close();await rm(root,{recursive:true,force:true});});
 return{db,root,task,ordinary,scope,scopes,calls,products,dependencies,get owner(){return owner;},set callback(value:(p:ProductDetail)=>void|Promise<void>){callback=value;},async restart(){await owner.close();owner=new AutomaticListingService(root,dependencies);}};
}

test('restricted owner preserves unrelated WAITING and NEEDS_ATTENTION history without observation or shutdown writes',async t=>{
 const f=await fixture(t);await f.owner.close();
 const unrelated={...f.ordinary,status:'WAITING',items:f.ordinary.items.map(row=>({...row,status:'WAITING',stage:'READBACK',draftId:randomUUID()}))};
 f.db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(unrelated),unrelated.id);
 const before=f.db.prepare('SELECT * FROM automatic_listing_tasks WHERE id=?').get(unrelated.id),audit=f.db.prepare('SELECT * FROM audit_events ORDER BY rowid').all();
 let observations=0;const restricted=new AutomaticListingService(f.root,{...f.dependencies,canManageTask:(id:string)=>id===f.task.id,procurement:{...f.dependencies.procurement,candidates:()=>{observations++;return[];}},batch:{stop:()=>{observations++;},reconcile:async()=>{observations++;}} as any} as any);
 try {
  assert.deepEqual(restricted.get(unrelated.id),unrelated);restricted.start();await restricted.refreshWaiting();
  assert.throws(()=>restricted.prepareStart(unrelated.id),/受控/);assert.throws(()=>restricted.pause(unrelated.id),/受控/);assert.throws(()=>restricted.cancel(unrelated.id),/受控/);
  assert.equal(observations,0);assert.equal(f.calls.length,0);
 }finally{await restricted.close();}
 assert.deepEqual(f.db.prepare('SELECT * FROM automatic_listing_tasks WHERE id=?').get(unrelated.id),before);assert.deepEqual(f.db.prepare('SELECT * FROM audit_events ORDER BY rowid').all(),audit);
});

test('main-only admission fails before the original owner can enqueue, activate or alter a task',async t=>{
 const f=await fixture(t);await f.owner.close();const before=f.db.prepare('SELECT * FROM automatic_listing_tasks ORDER BY id').all(),scope=readControlledRunScope(f.db);let admissions=0;
 const owner=new AutomaticListingService(f.root,{...f.dependencies,admitTask:()=>{admissions++;throw Error('synthetic no reliable billing upper');}} as any);
 try{assert.throws(()=>owner.startAuthorized(owner.prepareStart(f.task.id)),/no reliable/);await owner.waitForIdle();assert.equal(admissions,1);assert.equal(f.calls.length,0);assert.deepEqual(f.db.prepare('SELECT * FROM automatic_listing_tasks ORDER BY id').all(),before);assert.deepEqual(readControlledRunScope(f.db),scope);}finally{await owner.close();}
});

test('actual TaskOwner advances the controlled revision atomically and schedules only the active first SKU',async t=>{
 const f=await fixture(t),observed:any[]=[];f.callback=product=>{if(product.id!==f.products[0].id)return;const scopeId=f.scopes.authorizeEffect({kind:'source',productId:product.id}),current=readControlledRunScope(f.db)!;observed.push({scopeId,scopeRevision:current.expectedTaskRevision,taskRevision:f.owner.get(f.task.id).revision});};
 f.owner.startAuthorized(f.owner.prepareStart(f.task.id));await f.owner.waitForIdle();assert.deepEqual(f.calls,[f.products[0].id]);assert.equal(observed.length,1);assert.equal(observed[0].scopeId,f.scope.id);assert.ok(observed[0].scopeRevision>1);assert.equal(observed[0].scopeRevision,observed[0].taskRevision);assert.equal(f.owner.get(f.task.id).items[1].status,'PENDING');assert.equal(readControlledRunScope(f.db)!.activeItemKey,f.task.items[0].key);
 const ordinaryBefore=f.owner.get(f.ordinary.id);f.owner.startAuthorized(f.owner.prepareStart(f.ordinary.id));await f.owner.waitForIdle();assert.deepEqual(f.calls,[f.products[0].id,f.products[2].id]);assert.equal(f.owner.get(f.task.id).items[1].status,'PENDING');assert.ok(f.owner.get(f.ordinary.id).revision>ordinaryBefore.revision);
});

for(const action of ['pause','cancel'] as const)test(`actual TaskOwner ${action} immediately revokes an in-flight controlled context and restart never reactivates it`,{timeout:10_000},async t=>{
 const f=await fixture(t);let release!:()=>void,started!:()=>void,initial:unknown,revoked=false;const start=new Promise<void>(done=>started=done),hold=new Promise<void>(done=>release=done);f.callback=async product=>{try{assert.equal(f.scopes.authorizeEffect({kind:'source',productId:product.id}),f.scope.id);}catch(error){initial=error;}started();await hold;if(initial)throw initial;assert.throws(()=>f.scopes.authorizeEffect({kind:'source',productId:product.id}),(e:any)=>e.diagnosticReason==='CONTROLLED_RUN_SCOPE_BLOCKED');revoked=true;};
 try{f.owner.startAuthorized(f.owner.prepareStart(f.task.id));await start;const before=readControlledRunScope(f.db)!;f.owner[action](f.task.id);assert.equal(readControlledRunScope(f.db)!.status,'PAUSED');assert.ok(readControlledRunScope(f.db)!.authorityEpoch>before.authorityEpoch);}finally{release();await f.owner.waitForIdle();}assert.equal(initial,undefined);assert.equal(revoked,true);assert.deepEqual(f.calls,[f.products[0].id]);await f.restart();await f.owner.waitForIdle();assert.equal(readControlledRunScope(f.db)!.status,'PAUSED');assert.deepEqual(f.calls,[f.products[0].id]);
});

test('owner CAS uses the borrowed physical transaction for consecutive progress writes and rolls back with the original task',async t=>{
 const f=await fixture(t),other=openDatabase(f.root),task={...f.task,status:'RUNNING'};try{f.db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(task),task.id);const run=f.scopes.activate(f.scope.id),before=readControlledRunScope(f.db)!,epoch=before.authorityEpoch;
 assert.throws(()=>f.scopes.advanceTaskInTransaction(other,{...task,revision:2},1));
 assert.throws(()=>transaction(other,()=>{const next={...task,revision:2};f.scopes.advanceTaskInTransaction(other,next,1);other.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(next),task.id);throw Error('original owner failed');}),/original owner failed/);assert.deepEqual(readControlledRunScope(f.db),before);assert.equal(JSON.parse(String(f.db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(task.id)!.record_json)).revision,1);
 transaction(other,()=>{for(const revision of [2,3]){const next={...task,revision};f.scopes.advanceTaskInTransaction(other,next,revision-1);other.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(next),task.id);}});
 assert.equal(readControlledRunScope(f.db)!.expectedTaskRevision,3);assert.equal(readControlledRunScope(f.db)!.authorityEpoch,epoch);assert.equal(run(()=>f.scopes.authorizeEffect({kind:'classification',productId:task.items[0].productId})),f.scope.id);
 }finally{other.close();}
});

test('an activation abandoned by its original owner transaction cannot revive after a fresh authorization',async t=>{
 const f=await fixture(t);f.db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify({...f.task,status:'RUNNING'}),f.task.id);let abandoned!:ReturnType<ControlledRunScopes['activate']>;
 assert.throws(()=>transaction(f.db,()=>{abandoned=f.scopes.activate(f.scope.id);throw Error('abandoned owner transaction');}),/abandoned owner/);const fresh=new ControlledRunScopes(f.db).activate(f.scope.id),effect={kind:'classification' as const,productId:f.task.items[0].productId};assert.equal(fresh(()=>f.scopes.authorizeEffect(effect)),f.scope.id);assert.throws(()=>abandoned(()=>f.scopes.authorizeEffect(effect)),(e:any)=>e.diagnosticReason==='CONTROLLED_RUN_SCOPE_BLOCKED');
});

test('all controlled effect contexts reject changed identities, a missing authority and a missing registered scope',async t=>{
 const f=await fixture(t);f.db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify({...f.task,status:'RUNNING'}),f.task.id);const run=f.scopes.activate(f.scope.id),item=f.task.items[0],effect={kind:'source' as const,taskId:f.task.id,itemKey:item.key,productId:item.productId,sku:item.sku,targetId:f.task.targetId,sellerId:f.task.sellerId,marketplaceId:f.task.marketplaceId,variantIds:[item.variantId],recipeKey:null,parentage:'NONE'};
 assert.throws(()=>f.scopes.authorizeEffect(effect));assert.equal(f.scopes.authorizeEffect({kind:'ai',productId:f.products[2].id}),null);
 for(const kind of ['source','schema','classification','planning','ai','image','hosting','platform-write','platform-read','lwa','task-stage'] as const)assert.equal(run(()=>f.scopes.authorizeEffect({...effect,kind})),f.scope.id);
 for(const wrong of [{taskId:randomUUID()},{itemKey:f.task.items[1].key},{productId:f.products[1].id},{sku:'OTHER-SKU'},{targetId:'other-target'},{sellerId:'other-seller'},{marketplaceId:'JP'},{variantIds:[randomUUID()]},{recipeKey:'changed-recipe'},{parentage:'CHILD'},{parentage:'PARENT'}])assert.throws(()=>run(()=>f.scopes.authorizeEffect({...effect,...wrong})),(e:any)=>e.diagnosticReason==='CONTROLLED_RUN_SCOPE_BLOCKED');
 f.db.prepare('DELETE FROM controlled_run_scopes WHERE id=?').run(f.scope.id);assert.throws(()=>run(()=>f.scopes.authorizeEffect(effect)),(e:any)=>e.diagnosticReason==='CONTROLLED_RUN_SCOPE_BLOCKED');let calls=0;assert.throws(()=>f.scopes.runTask(f.task.id,item.key,item.productId,run,()=>{calls++;}),(e:any)=>e.diagnosticReason==='CONTROLLED_RUN_SCOPE_BLOCKED');assert.equal(calls,0);
});

test('controlled owner CAS refuses roster, SKU, recipe, family, target and stale revision changes without persisting any change',async t=>{
 const f=await fixture(t),before=readControlledRunScope(f.db),original=String(f.db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(f.task.id)!.record_json);
 const mutations=[(n:any)=>n.sellerId='other-seller',(n:any)=>n.targetId='other-target',(n:any)=>n.marketplaceId='JP',(n:any)=>n.items.push({...n.items[0],key:randomUUID(),sku:'THIRD'}),(n:any)=>n.items[0].sku='CHANGED',(n:any)=>n.items[0].salesPlan={parentage:'NONE',recipe:{key:'changed',components:[{variantId:n.items[0].variantId,quantity:5}]}},(n:any)=>n.items[0].salesPlan={parentage:'CHILD'},(n:any)=>n.items[0].variantId=randomUUID(),(n:any)=>n.revision=3];
 for(const mutate of mutations){const next=structuredClone({...f.task,revision:2});mutate(next);assert.throws(()=>transaction(f.db,()=>{f.scopes.advanceTaskInTransaction(f.db,next,1);f.db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(next),next.id);}), (e:any)=>e.diagnosticReason==='CONTROLLED_RUN_SCOPE_BLOCKED');assert.deepEqual(readControlledRunScope(f.db),before);assert.equal(String(f.db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(f.task.id)!.record_json),original);}
});

test('explicit UI selection cannot release the second controlled SKU or enlarge the first admission',async t=>{
 const f=await fixture(t),before=f.owner.get(f.task.id),scopeBefore=readControlledRunScope(f.db);for(const keys of [[f.task.items[1].key],f.task.items.map(row=>row.key)])assert.throws(()=>f.owner.startAuthorized(f.owner.prepareStart(f.task.id),{mode:'targeted',selections:keys.map(key=>({key}))}),(e:any)=>e.diagnosticReason==='CONTROLLED_RUN_SCOPE_BLOCKED');assert.deepEqual(f.owner.get(f.task.id),before);assert.deepEqual(readControlledRunScope(f.db),scopeBefore);assert.deepEqual(f.calls,[]);
});

for(const action of ['pause','cancel'] as const)test(`actual TaskOwner ${action} revokes the original capability even if its task write fails`,{timeout:10_000},async t=>{
 const f=await fixture(t);let release!:()=>void,started!:()=>void,accepted=false,rejected=false,workerError:unknown,afterFailure:any;const began=new Promise<void>(done=>started=done),hold=new Promise<void>(done=>release=done);
 f.callback=async product=>{assert.equal(f.scopes.authorizeEffect({kind:'source',productId:product.id}),f.scope.id);started();await hold;try{f.scopes.authorizeEffect({kind:'source',productId:product.id});accepted=true;}catch(error){rejected=(error as any).diagnosticReason==='CONTROLLED_RUN_SCOPE_BLOCKED';}};
 let before:any;try{f.owner.startAuthorized(f.owner.prepareStart(f.task.id));await began;before={task:f.owner.get(f.task.id),scope:readControlledRunScope(f.db)};f.db.exec("CREATE TRIGGER s08_task_write_fail BEFORE UPDATE ON automatic_listing_tasks BEGIN SELECT RAISE(ABORT,'synthetic task persistence failure');END;");assert.throws(()=>f.owner[action](f.task.id),/synthetic task persistence failure/);afterFailure={task:f.owner.get(f.task.id),scope:readControlledRunScope(f.db),stored:JSON.parse(String(f.db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(f.task.id)!.record_json))};}finally{f.db.exec('DROP TRIGGER IF EXISTS s08_task_write_fail');release();try{await f.owner.waitForIdle();}catch(error){workerError=error;}}
 assert.equal(accepted,false);assert.equal(rejected,true);assert.equal(workerError,undefined);assert.equal(afterFailure.task.status,action==='pause'?'PAUSED':'CANCELLED');assert.equal(afterFailure.task.revision,before.task.revision);assert.equal(afterFailure.task.updatedAt,before.task.updatedAt);assert.equal(afterFailure.stored.status,'RUNNING');assert.equal(afterFailure.scope.status,'ACTIVE');assert.equal(f.owner.get(f.task.id).status,action==='pause'?'PAUSED':'CANCELLED');assert.equal(f.owner.get(f.task.id).items[1].status,'PENDING');
 if(action==='pause'){let freshAccepted=false;f.callback=product=>{freshAccepted=f.scopes.authorizeEffect({kind:'source',productId:product.id})===f.scope.id;};f.owner.startAuthorized(f.owner.prepareStart(f.task.id));const fresh=readControlledRunScope(f.db)!;assert.notEqual(fresh.authorityNonce,before.scope.authorityNonce);await f.owner.waitForIdle();assert.equal(freshAccepted,true);assert.equal(f.owner.get(f.task.id).items[1].status,'PENDING');}
});

test('close revokes every controlled capability before an earlier ordinary task can fail persistence',{timeout:10_000},async t=>{
 const f=await fixture(t,true);let release!:()=>void,started!:()=>void,accepted=false,rejected=false;const began=new Promise<void>(done=>started=done),hold=new Promise<void>(done=>release=done);f.callback=async product=>{assert.equal(product.id,f.products[0].id);assert.equal(f.scopes.authorizeEffect({kind:'source',productId:product.id}),f.scope.id);started();await hold;try{f.scopes.authorizeEffect({kind:'source',productId:product.id});accepted=true;}catch(error){rejected=(error as any).diagnosticReason==='CONTROLLED_RUN_SCOPE_BLOCKED';}};
 try{f.owner.startAuthorized(f.owner.prepareStart(f.task.id));await began;f.owner.startAuthorized(f.owner.prepareStart(f.ordinary.id));assert.equal(f.owner.get(f.ordinary.id).status,'QUEUED');f.db.exec(`CREATE TRIGGER s08_close_write_fail BEFORE UPDATE ON automatic_listing_tasks WHEN OLD.id='${f.ordinary.id}' BEGIN SELECT RAISE(ABORT,'synthetic ordinary close persistence failure');END;`);assert.throws(()=>f.owner.close(),/synthetic ordinary close persistence failure/);}finally{f.db.exec('DROP TRIGGER IF EXISTS s08_close_write_fail');release();await f.owner.waitForIdle();}assert.equal(accepted,false);assert.equal(rejected,true);assert.deepEqual(f.calls,[f.products[0].id]);
});
