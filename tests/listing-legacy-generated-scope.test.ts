import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './fixtures/listing-ai.ts';
import { openDatabase } from '../src/main/database.ts';
import { ListingAiService } from '../src/main/listing-ai/service.ts';

async function setup(t:any) {
  let db:ReturnType<typeof openDatabase>;t.after(()=>db?.close()); const f=await fixture(t), get=f.amazon.getDraft.bind(f.amazon);
  f.amazon.getDraft=id=>({...get(id),listingProgram:'haul'});
  db=openDatabase(f.directory);const siblingId=randomUUID();
  db.prepare('INSERT INTO variants SELECT ?,product_id,?,original_spec,normalized_spec,purchase_price,inventory,source_spec,source_purchase_price,position+1 FROM variants WHERE id=?').run(siblingId,'sibling',f.product.variants[0].id);
  const op=f.listing.beginCompletion(f.reference);
  op.scopeHash=(f.listing as any).completionScope(f.amazon.getDraft(f.draft.id),true);
  op.state='DONE';f.ai.completionJournal.save(op);
  function output(proven=true,sibling=false) {
    const id=randomUUID(),workflowId=randomUUID(),candidateId=randomUUID(),at=new Date(Date.parse(op.createdAt)+1000).toISOString(),sha=(sibling?'d':proven?'a':'c').repeat(64);
    const variantId=sibling?siblingId:f.product.variants[0].id;
    db.prepare('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,f.product.id,'generated.png','gallery','image/png',100,100,100,`assets/${id}.png`,`assets/${id}.preview.png`,sha,at);
    db.prepare('INSERT INTO variant_assets VALUES(?,?,1,?)').run(id,variantId,at);
    if(proven){db.prepare('INSERT INTO image_workflow_runs VALUES(?,?)').run(workflowId,JSON.stringify({id:workflowId,productId:f.product.id,variantId,slots:[{index:1,status:'PASSED',approvedAssetId:id,approvedSha256:sha,attempts:[{number:1,state:'PASSED',candidateId}]}]}));db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?)').run(randomUUID(),f.product.id,'image.workflow.adopted','fixture',JSON.stringify({workflowId,slot:1,attempt:1,assetId:id,candidateId}),at);}
    return id;
  }
  return {...f,op,db,output};
}
test('proven generated output resumes immutable legacy DONE scope after service restart',async t=>{
  const f=await setup(t),before=f.listing.getCompletion(f.op.id);f.output();f.output(true,true);
  for(let i=0;i<2;i++){const service=new ListingAiService(f.store,f.amazon,f.ai);assert.deepEqual(service.beginCompletion(f.reference,f.op.id),before);assert.equal((service as any).completionDraft(before).id,f.draft.id);}
  assert.equal(f.listing.completionOperations(f.draft.id).length,1);assert.equal(f.requests.length,0);
});
for(const change of ['unproven-asset','source-role','fact','review','generation','seller','sku','generated-sha','missing-audit','wrong-candidate'])test(`legacy compatibility rejects ${change}`,async t=>{
 const f=await setup(t),id=f.output();
 if(change==='unproven-asset')f.output(false);
 if(change==='source-role')f.db.prepare("UPDATE assets SET role='detail' WHERE id=?").run(f.product.assets[0].id);
 if(change==='fact')f.db.prepare("UPDATE products SET revision=revision+1 WHERE id=?").run(f.product.id);
 if(change==='generated-sha')f.db.prepare('UPDATE assets SET sha256=? WHERE id=?').run('b'.repeat(64),id);
 if(change==='missing-audit')f.db.prepare("DELETE FROM audit_events WHERE action='image.workflow.adopted'").run();
 if(change==='wrong-candidate')f.db.prepare("UPDATE audit_events SET detail_json=json_set(detail_json,'$.candidateId',?) WHERE action='image.workflow.adopted'").run(randomUUID());
 if(change==='seller'||change==='sku'){const get=f.amazon.getDraft.bind(f.amazon);f.amazon.getDraft=id=>({...get(id),[change==='seller'?'sellerId':'sku']:'changed'});}
 if(change==='generation'){const original=f.amazon.executionTargetScope.bind(f.amazon);f.amazon.executionTargetScope=id=>({...original(id),generation:original(id).generation+1});}
 const service=new ListingAiService(f.store,f.amazon,f.ai,()=>change!=='review');
 assert.throws(()=>service.beginCompletion(f.reference,f.op.id));assert.equal(service.getCompletion(f.op.id).state,'DONE');assert.equal(f.requests.length,0);
});


