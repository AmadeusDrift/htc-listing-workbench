import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AmazonPersistence } from '../src/main/amazon/persistence.ts';
test('retention preserves expired UNKNOWN draft, exchange and call evidence',async t=>{
 await mkdir(resolve('.test-data'),{recursive:true});const root=await mkdtemp(resolve('.test-data/retention-reference-'));
 const store=new AmazonPersistence(root);t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});const db=store.db;
 db.prepare("INSERT INTO products(id,title,status,origin,created_at,updated_at) VALUES('p','synthetic','draft','manual','2020-01-01','2020-01-01')").run();
 db.prepare("INSERT INTO listing_drafts(id,product_id,request_json,schema_checksum,validation_json,state,created_at) VALUES('d','p','{}','s','{}','UNKNOWN','2020-01-01')").run();
 db.prepare("INSERT INTO amazon_write_locks(listing_hash,draft_id,state,created_at) VALUES('h','d','UNKNOWN','2020-01-01')").run();
 db.prepare("INSERT INTO amazon_exchanges(id,draft_id,created_at,exchange_json) VALUES('e','d','2020-01-01','{}')").run();
 db.prepare("INSERT INTO amazon_calls(id,target_id,created_at,event_json) VALUES('c','t','2020-01-01','{}')").run();
 store.cleanup(Date.parse('2026-10-13'));
 assert.equal(db.prepare("SELECT COUNT(*) n FROM listing_drafts WHERE id='d'").get()!.n,1);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM amazon_exchanges WHERE id='e'").get()!.n,1);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM amazon_calls WHERE id='c'").get()!.n,1);
});




import { ReferenceRetention } from '../src/main/reference-retention.ts';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
test('cleanup apply rechecks new authoritative references after preview and leaves unspecified retention disabled',async t=>{
 await mkdir(resolve('.test-data'),{recursive:true});const root=await mkdtemp(resolve('.test-data/retention-reference-'));const store=new AmazonPersistence(root);t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 const id=randomUUID(),path='assets/'+id+'.png';await mkdir(join(root,'assets'));await writeFile(join(root,path),'synthetic orphan');
 const retention=new ReferenceRetention(store.db,root);const automatic=await retention.preview({mode:'automatic'});assert.equal(automatic.candidates.length,0);assert.equal(automatic.automaticEnabled,false);
 const plan=await retention.preview({mode:'manual'});assert.equal(plan.candidates.length,1);
 store.db.prepare("INSERT INTO amazon_settings(key,value_json) VALUES('historical_unknown_evidence',?)").run(JSON.stringify({assetId:id,state:'UNKNOWN'}));
 const result=await retention.apply({planId:plan.planId,revision:plan.revision});assert.equal(result.removed,0);assert.equal(result.protected,1);assert.equal(await readFile(join(root,path),'utf8'),'synthetic orphan');
 await assert.rejects(retention.apply({planId:plan.planId,revision:plan.revision}),/预览/);
});
test('manual orphan cleanup only removes unchanged unreferenced controlled assets',async t=>{
 await mkdir(resolve('.test-data'),{recursive:true});const root=await mkdtemp(resolve('.test-data/retention-reference-'));const store=new AmazonPersistence(root);t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});await mkdir(join(root,'assets'));
 const path='assets/'+randomUUID()+'.png';await writeFile(join(root,path),'orphan');const service=new ReferenceRetention(store.db,root),plan=await service.preview({mode:'manual'});assert.equal(plan.candidates.length,1);
 await writeFile(join(root,path),'changed');assert.equal((await service.apply({planId:plan.planId,revision:plan.revision})).removed,0);
 const next=await service.preview({mode:'manual'});assert.equal((await service.apply({planId:next.planId,revision:next.revision})).removed,1);
});
import { AutomaticListingService } from '../src/main/automatic-listing/service.ts';
import { FollowupService } from '../src/main/followup/service.ts';
import { ItemLabelService } from '../src/main/item-labels/service.ts';
test('maintenance leases preserve disabled schedulers and release once without granting work',()=>{
 const automatic=Object.assign(Object.create(AutomaticListingService.prototype),{schedulingSuspended:true,timer:null,ensureOpen:()=>{},start:()=>{throw Error('must not start');}});
 const releaseAutomatic=automatic.holdForMaintenance();releaseAutomatic();releaseAutomatic();assert.equal(automatic.schedulingSuspended,true);assert.equal(automatic.timer,null);
 let arms=0;const followup=Object.assign(Object.create(FollowupService.prototype),{paused:true,started:false,ensureOpen:()=>{},cancelTimer:()=>{},arm:()=>{arms++;},start:()=>{throw Error('must not start');}});
 const releaseFollowup=followup.holdForMaintenance();assert.equal(followup.paused,true);releaseFollowup();releaseFollowup();assert.equal(followup.paused,true);assert.equal(followup.started,false);assert.equal(arms,1);
 const labels=Object.assign(Object.create(ItemLabelService.prototype),{started:false,timer:null,arm:()=>{arms++;},resume:()=>{throw Error('must not resume');}});const releaseLabels=labels.holdForMaintenance();releaseLabels();releaseLabels();assert.equal(labels.started,false);assert.equal(arms,2);
});
