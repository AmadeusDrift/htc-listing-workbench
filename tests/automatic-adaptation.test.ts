import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,saveInput} from './fixtures/listing-ai.ts';
import {openDatabase} from '../src/main/database.ts';
import {imageApprovalDraftSnapshot} from '../src/main/image-workflow/approval-reuse.ts';
import {inspectImageAdaptation,saveImageAdaptation,currentImageAdaptation} from '../src/main/image-workflow/adaptation.ts';
import {buildListingContext} from '../src/main/listing-ai/context.ts';
import type {ImageWorkflowRun} from '../src/shared/image-workflow-contracts.ts';
import {randomUUID} from 'node:crypto';

test('W2 Amazon local adaptation preserves manual attributes and responses and rolls back atomically',async t=>{
 const f=await fixture(t),db=openDatabase(f.directory);
 try{
  const persistence=(f.amazon as any).persistence,record=persistence.record(f.draft.id);record.draft.attributes.custom_manual=[{value:'retain me'}];record.previewResponse={raw:'historic preview'};record.submitResponse={raw:'historic rejected submit'};persistence.putRecord(record);
  const before=f.amazon.getDraft(f.draft.id),source=f.store.saveProduct({...saveInput(f.store.getProductSnapshot(f.product.id)),title:'Current source'}),baseline=JSON.stringify(persistence.record(f.draft.id));
  f.store.getProduct=()=>{throw Error('mutating source getter forbidden');};
  const preview=f.amazon.previewTaskAdaptation(f.draft.id,source);
  assert.equal(preview.productRevision,source.revision);assert.deepEqual(preview.attributes.custom_manual,[{value:'retain me'}]);assert.equal(JSON.stringify(persistence.record(f.draft.id)),baseline);
  db.exec('BEGIN IMMEDIATE');f.amazon.applyTaskAdaptation(f.draft.id,source,undefined,db);db.exec('ROLLBACK');assert.equal(JSON.stringify(persistence.record(f.draft.id)),baseline);
  db.exec('BEGIN IMMEDIATE');const updated=f.amazon.applyTaskAdaptation(f.draft.id,source,undefined,db);db.exec('COMMIT');
  assert.equal(updated.id,before.id);assert.equal(updated.sku,before.sku);assert.equal(updated.revision,before.revision+1);assert.deepEqual(persistence.record(f.draft.id).previewResponse,{raw:'historic preview'});assert.deepEqual(persistence.record(f.draft.id).submitResponse,{raw:'historic rejected submit'});assert.equal(f.requests.length,0);
 }finally{db.close();}
});

test('W2 seven approved images get exact dependency proof for cost-only source change, changed material is not authorized',async t=>{
 const f=await fixture(t),db=openDatabase(f.directory);
 try{
  const before=f.amazon.getDraft(f.draft.id),source=f.store.getProductSnapshot(f.product.id),context=buildListingContext(before,source,0),asset=(f.store as any).getAssetRecord(source.assets[0].id);
  const run={id:randomUUID(),productId:source.id,productRevision:source.revision,variantId:before.variantId,draftId:before.id,sku:before.sku,status:'COMPLETED',stage:'complete',approvedAssetId:randomUUID(),approvedSha256:'a'.repeat(64),imageContext:{listing:context},referenceAssets:[{id:asset.id,sha256:asset.sha256}],slots:Array.from({length:7},()=>({status:'PASSED',approvedAssetId:randomUUID(),approvedSha256:'a'.repeat(64)}))} as unknown as ImageWorkflowRun;
  const current=structuredClone(source);current.revision++;current.variants[0].purchasePrice='2.5';const after={...before,productRevision:current.revision,revision:before.revision+1};
  assert.equal(inspectImageAdaptation(run,before,after,current).compatible,true);const frozen=JSON.stringify(run);
  db.exec('BEGIN IMMEDIATE');saveImageAdaptation(db,run,before,after,current);db.exec('COMMIT');assert.equal(currentImageAdaptation(db,run,after,current),true);assert.equal(JSON.stringify(run),frozen);
  const changed=structuredClone(current);changed.facts[0].value='Hard plastic';assert.equal(inspectImageAdaptation(run,before,after,changed).compatible,false);assert.equal(currentImageAdaptation(db,run,after,changed),false);
  const edited={...after,attributes:{...after.attributes,color:[{value:'Red'}]}};assert.notEqual(imageApprovalDraftSnapshot(after),imageApprovalDraftSnapshot(edited));assert.equal(currentImageAdaptation(db,run,edited,current),false);
 }finally{db.close();}
});
