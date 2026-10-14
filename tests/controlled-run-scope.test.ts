import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {transaction} from '../src/main/application/transaction.ts';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {WorkspaceStore} from '../src/main/store.ts';
import {openDatabase} from '../src/main/database.ts';
import {validateAutomaticListingTask,sourceStamp} from '../src/main/automatic-listing/records.ts';
import {DEFAULT_ITEM_LABEL_FORMAT} from '../src/shared/item-label-contracts.ts';
import {createWorkspaceBackup,prepareWorkspaceRestore,commitWorkspaceRestore} from '../src/main/backup.ts';
import {ControlledRunScopes,readControlledRunScope,retainControlledRunHistory,initializeControlledRunScopes} from '../src/main/application/controlled-run-scope.ts';
import {currentWorkBatch,addWorkBatchProducts,bindWorkBatchTask} from '../src/main/automatic-listing/work-batches.ts';

test('controlled authority cannot fall through to ordinary unlimited execution or grow its original roster',async()=>{
 const mod=await import('../src/main/application/controlled-run-scope.ts').catch(()=>null);assert.ok(mod?.ControlledRunScopes,'missing durable controlled scope owner');
 const db=new DatabaseSync(':memory:');try{transaction(db,()=>mod.initializeControlledRunScopes(db));db.exec('CREATE TABLE automatic_listing_tasks(id TEXT PRIMARY KEY,record_json TEXT);CREATE TABLE listing_drafts(id TEXT PRIMARY KEY,record_json TEXT)');
 const taskId=randomUUID(),productId=randomUUID(),variantId=randomUUID(),row={key:`${productId}:${variantId}`,sku:'S08-ONE',productId,variantId};
 const task={id:taskId,revision:1,status:'RUNNING',targetId:'s08-target',sellerId:'s08-seller',marketplaceId:'US',mode:'live',items:[row]};db.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(taskId,JSON.stringify(task));
 const scopes=new mod.ControlledRunScopes(db),scope=scopes.register({taskId,expectedTaskRevision:1,targetId:task.targetId,sellerId:task.sellerId,marketplaceId:'US',items:[{itemKey:row.key,sku:row.sku,productId,variantIds:[variantId],recipeKey:null,parentage:'NONE'}]});
 const draftId=randomUUID();db.prepare('INSERT INTO listing_drafts VALUES(?,?)').run(draftId,JSON.stringify({draft:{id:draftId,productId,variantId,sku:row.sku,targetId:task.targetId,sellerId:task.sellerId,marketplaceId:'US',mode:'live',schema:{parentageLevel:'NONE'}}}));
 const effect={version:1 as const,operation:'image-generation' as const,productId,variantIds:[variantId],sku:row.sku,targetId:task.targetId,marketplaceId:'US',draftId};
 assert.throws(()=>scopes.authorizeImage(effect));assert.equal(scopes.authorizeImage({...effect,productId:randomUUID()}),null);
 const run=scopes.activate(scope.id);run(()=>{assert.equal(scopes.authorizeImage(effect),scope.id);assert.throws(()=>scopes.authorizeImage({...effect,sku:'S08-OTHER'}));assert.throws(()=>scopes.authorizeImage({...effect,marketplaceId:'JP'}));});
 assert.throws(()=>scopes.register({...scope,items:[...scope.items,{...scope.items[0],sku:'S08-TWO'}]}));
 db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify({...task,revision:2}),taskId);run(()=>assert.throws(()=>scopes.authorizeImage(effect)));
 }finally{db.close();}
});
test('restoring an actual encrypted older backup retains the same finite scope and revokes its active dispatch grant',async()=>{
 await mkdir(resolve('.test-data'),{recursive:true});const root=await mkdtemp(resolve('.test-data/b8-')),store=new WorkspaceStore(root),product=store.createProduct(),db=openDatabase(root);let closed=false;
 try{const at=new Date().toISOString(),variant=product.variants[0],task=validateAutomaticListingTask({id:randomUUID(),revision:1,status:'RUNNING',targetId:'s08-target',targetName:'Synthetic scope target',sellerId:'s08-seller',marketplaceId:'US',mode:'live',targetStamp:'a'.repeat(64),profileId:'s08-host',profileStamp:'b'.repeat(64),rulesStamp:'c'.repeat(64),ruleRevision:1,productType:'AUTO',locale:'en_US',labelFormat:DEFAULT_ITEM_LABEL_FORMAT,createdAt:at,updatedAt:at,error:null,items:[{key:`${product.id}:${variant.id}`,productId:product.id,productRevision:product.revision,sourceStamp:sourceStamp(product),productTitle:product.title||'Synthetic scope product',variantId:variant.id,sku:'S08-RESTORE',stockSets:5,sourcesPrepared:false,status:'PENDING',stage:'SOURCES',draftId:null,executionTaskIds:[],imageStarted:false,imageAttempts:0,repairAttempts:0,repair:null,batchId:null,error:null}]});db.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(task.id,JSON.stringify(task));
 const batch=currentWorkBatch(db);addWorkBatchProducts(db,batch.id,[product.id]);bindWorkBatchTask(db,batch.id,task.id);
 const scopes=new ControlledRunScopes(db),scope=scopes.register({taskId:task.id,expectedTaskRevision:1,targetId:task.targetId,sellerId:task.sellerId,marketplaceId:task.marketplaceId,items:[{itemKey:task.items[0].key,sku:task.items[0].sku,productId:product.id,variantIds:[variant.id],recipeKey:null,parentage:'NONE'}]}),backup=join(root,'scope.htcbackup');await createWorkspaceBackup(root,backup,'s08-synthetic-scope-passphrase');scopes.activate(scope.id);assert.equal(readControlledRunScope(db)!.status,'ACTIVE');
 const prepared=await prepareWorkspaceRestore(root,backup,'s08-synthetic-scope-passphrase'),staged=openDatabase(prepared.stagingDirectory);try{assert.equal(readControlledRunScope(staged)!.status,'PAUSED');assert.deepEqual(readControlledRunScope(staged)!.items,scope.items);}finally{staged.close();}db.close();store.close();closed=true;await commitWorkspaceRestore(root,prepared);const restored=openDatabase(root);try{const state=readControlledRunScope(restored)!;assert.equal(state.id,scope.id);assert.equal(state.workspaceId,scope.workspaceId);assert.equal(state.status,'PAUSED');assert.deepEqual(state.items,scope.items);assert.throws(()=>new ControlledRunScopes(restored).activate(scope.id));}finally{restored.close();}
 }finally{if(!closed){db.close();store.close();}await rm(root,{recursive:true,force:true});}
});
test('a two SKU roster activates only its first item and cannot reuse its authority in a copied workspace',()=>{
 const db=new DatabaseSync(':memory:'),copy=new DatabaseSync(':memory:');try{for(const target of [db,copy]){transaction(target,()=>initializeControlledRunScopes(target));target.exec('CREATE TABLE automatic_listing_tasks(id TEXT PRIMARY KEY,record_json TEXT);CREATE TABLE listing_drafts(id TEXT PRIMARY KEY,record_json TEXT)');}
 const items=[0,1].map(index=>({itemKey:randomUUID(),sku:`S08-${index}`,productId:randomUUID(),variantIds:[randomUUID()],recipeKey:null,parentage:'NONE' as const})),task={id:randomUUID(),revision:1,status:'RUNNING',targetId:'s08-target',sellerId:'s08-seller',marketplaceId:'US',mode:'live',items:items.map(i=>({key:i.itemKey,sku:i.sku,productId:i.productId,variantId:i.variantIds[0]}))};for(const target of [db,copy])target.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(task.id,JSON.stringify(task));
 const scopes=new ControlledRunScopes(db),scope=scopes.register({taskId:task.id,expectedTaskRevision:1,targetId:task.targetId,sellerId:task.sellerId,marketplaceId:'US',items}),run=scopes.activate(scope.id),effects=items.map(i=>{const draftId=randomUUID();db.prepare('INSERT INTO listing_drafts VALUES(?,?)').run(draftId,JSON.stringify({draft:{id:draftId,productId:i.productId,variantId:i.variantIds[0],sku:i.sku,targetId:task.targetId,sellerId:task.sellerId,marketplaceId:'US',mode:'live',schema:{parentageLevel:'NONE'}}}));return{version:1 as const,operation:'image-generation' as const,productId:i.productId,variantIds:i.variantIds,sku:i.sku,targetId:task.targetId,marketplaceId:'US',draftId};});
 run(()=>{assert.equal(scopes.authorizeImage(effects[0]),scope.id);assert.throws(()=>scopes.authorizeImage(effects[1]));});copy.prepare('INSERT INTO controlled_run_scopes SELECT ?,?').run(scope.id,JSON.stringify(readControlledRunScope(db)));assert.throws(()=>new ControlledRunScopes(copy).activate(scope.id));transaction(copy,()=>retainControlledRunHistory(db,copy));assert.equal(readControlledRunScope(copy)!.status,'PAUSED');
 }finally{copy.close();db.close();}
});
