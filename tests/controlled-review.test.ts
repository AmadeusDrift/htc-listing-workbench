import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {openDatabase} from '../src/main/database.ts';
import {ControlledRunScopes,readControlledRunScope,pauseControlledRunScopes,retainControlledRunHistory} from '../src/main/application/controlled-run-scope.ts';
import {transaction} from '../src/main/application/transaction.ts';
const hash='a'.repeat(64);
test('main-only reviewed candidate CAS retains the original fixed roster and a restore cannot erase its newest attestation',()=>{
 mkdirSync(resolve('.test-data'),{recursive:true});const dir=mkdtempSync(resolve('.test-data/s08-review-')),db=openDatabase(dir),scopes=new ControlledRunScopes(db),items=[0,1].map(i=>({itemKey:'item'+i,sku:'S08-'+i,productId:randomUUID(),variantIds:[randomUUID()],recipeKey:null,parentage:'NONE' as const})),task={id:randomUUID(),revision:1,status:'PAUSED',mode:'live',targetId:'target',sellerId:'seller',marketplaceId:'US',items:items.map(i=>({key:i.itemKey,sku:i.sku,productId:i.productId,variantId:i.variantIds[0]}))};db.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(task.id,JSON.stringify(task));const scope=scopes.register({taskId:task.id,expectedTaskRevision:1,targetId:'target',sellerId:'seller',marketplaceId:'US',items}),review={version:1,sessionId:randomUUID(),digest:hash,initialTaskRevision:1,sourceStamps:items.map(i=>({itemKey:i.itemKey,stamp:hash})),candidate:{sourceCommit:'b'.repeat(40),sourceDigest:hash,executableSha256:hash,packageManifestSha256:hash},secondReleased:false};
 const bind=(scopes as any).bindReviewInTransaction;assert.equal(typeof bind,'function');
 transaction(db,()=>bind.call(scopes,db,review,{digest:null,epoch:0,taskRevision:1}));const first=readControlledRunScope(db)! as any;assert.deepEqual(first.review,review);assert.equal(first.activeItemKey,items[0].itemKey);assert.throws(()=>transaction(db,()=>bind.call(scopes,db,{...review,digest:'c'.repeat(64)},{digest:null,epoch:0,taskRevision:1})));
 const next={...review,digest:'c'.repeat(64),candidate:{...review.candidate,sourceCommit:'d'.repeat(40)}};transaction(db,()=>bind.call(scopes,db,next,{digest:hash,epoch:first.authorityEpoch,taskRevision:1}));assert.equal((readControlledRunScope(db)! as any).review.digest,next.digest);assert.equal(readControlledRunScope(db)!.items.length,2);
 for(const changed of [{...next,sessionId:randomUUID()},{...next,sourceStamps:[]},{...next,initialTaskRevision:2}])assert.throws(()=>transaction(db,()=>bind.call(scopes,db,changed,{digest:next.digest,epoch:readControlledRunScope(db)!.authorityEpoch,taskRevision:1})));
 const snapshot=openDatabase(mkdtempSync(resolve('.test-data/s08-review-old-')));snapshot.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(task.id,JSON.stringify(task));snapshot.prepare('INSERT INTO controlled_run_scopes VALUES(?,?)').run(scope.id,JSON.stringify(first));transaction(snapshot,()=>retainControlledRunHistory(db,snapshot));assert.equal((readControlledRunScope(snapshot)! as any).review.digest,next.digest);assert.equal(readControlledRunScope(snapshot)!.status,'PAUSED');snapshot.close();pauseControlledRunScopes(db);db.close();
});
