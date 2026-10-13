import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {transaction} from '../src/main/application/transaction.ts';
import {registerGeneratedAsset} from '../src/main/assets/commands.ts';
import {confirmAssetBinding} from '../src/main/products/asset-bindings.ts';
import {linkLegacyPreparation} from '../src/main/image-workflow/completion-link.ts';

test('M09 and M02 commands join caller transaction and reject mismatched product',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec('CREATE TABLE assets(id TEXT PRIMARY KEY,product_id TEXT,file_name,role,mime,width,height,bytes,original,preview,hash,at); CREATE TABLE variants(id TEXT PRIMARY KEY,product_id TEXT); CREATE TABLE variant_assets(asset_id,variant_id,confirmed,updated_at,UNIQUE(asset_id,variant_id));');
 db.exec("INSERT INTO variants VALUES('v','p'),('other','q')");
 const asset={id:'a',productId:'p',fileName:'generated.png',width:1,height:1,byteSize:1,sha256:'hash',at:'now'};
 assert.throws(()=>registerGeneratedAsset(db,asset),/事务/);
 assert.throws(()=>transaction(db,()=>{registerGeneratedAsset(db,asset);confirmAssetBinding(db,{productId:'p',assetId:'a',variantId:'other',at:'now'});}),/当前商品/);
 assert.equal(db.prepare('SELECT count(*) n FROM assets').get()!.n,0);
 assert.throws(()=>transaction(db,()=>{registerGeneratedAsset(db,asset);confirmAssetBinding(db,{productId:'p',assetId:'a',variantId:'v',at:'now'});throw Error('workflow save failed');}),/workflow/);
 assert.equal(db.prepare('SELECT count(*) n FROM variant_assets').get()!.n,0);
 transaction(db,()=>{registerGeneratedAsset(db,asset);confirmAssetBinding(db,{productId:'p',assetId:'a',variantId:'v',at:'now'});assert.equal(db.isTransaction,true);});
 assert.equal(db.prepare('SELECT count(*) n FROM variant_assets').get()!.n,1);
});
test('M08 completion link is CAS guarded, transactional and preserves unrelated history',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE image_workflow_runs(id TEXT PRIMARY KEY,record_json TEXT)');
 const raw=JSON.stringify({draftId:'draft',contentPreparation:{state:'STARTED'},unknown:{keep:true},attempts:[1,2]});
 db.prepare('INSERT INTO image_workflow_runs VALUES(?,?)').run('run',raw);
 const input={id:'run',draftId:'draft',operationId:'op',expectedJson:raw};
 assert.throws(()=>linkLegacyPreparation(db,input),/事务/);
 assert.throws(()=>transaction(db,()=>linkLegacyPreparation(db,{...input,expectedJson:raw+' '})),/已变化/);
 assert.throws(()=>transaction(db,()=>{linkLegacyPreparation(db,input);throw Error('journal failure');}),/journal/);
 assert.equal(db.prepare('SELECT record_json FROM image_workflow_runs').get()!.record_json,raw);
 transaction(db,()=>linkLegacyPreparation(db,input));
 const next=JSON.parse(String(db.prepare('SELECT record_json FROM image_workflow_runs').get()!.record_json));
 assert.deepEqual(next,{...JSON.parse(raw),contentPreparation:{state:'STARTED',operationId:'op'}});
 assert.throws(()=>transaction(db,()=>linkLegacyPreparation(db,input)),/已变化/);
});
