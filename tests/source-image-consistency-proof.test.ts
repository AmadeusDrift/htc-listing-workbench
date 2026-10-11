import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { consistencyFixture } from './helpers/source-consistency.ts';
import { readConsistencyView,saveConsistencyDecision,assertProductConsistency,SourceConsistencyError } from '../src/main/source-image-consistency/proof.ts';
import { saveInput } from './fixtures/listing-ai.ts';
import { reserveConsistencyAttempt } from '../src/main/source-image-consistency/history.ts';

test('read-only proof is pending and blocks manual originals until explicit scoped human decision',async t=>{
  const f=consistencyFixture(t),context=f.context(),view=readConsistencyView(f.db,context);
  assert.equal(view.status,'PENDING');assert.throws(()=>assertProductConsistency(f.db,f.store.getProduct(f.p.id),[context.variantId]),SourceConsistencyError);
  const decision=await saveConsistencyDecision(f.db,f.store,f.directory,{...context,fingerprint:view.fingerprint,decision:'CONFIRMED',reason:'Viewed this exact image and current raw Blue round specification'} as never).catch(()=>null);
  assert.equal(decision,null,'renderer cannot send a full context or trusted output');
  await saveConsistencyDecision(f.db,f.store,f.directory,{productId:context.productId,productRevision:context.productRevision,variantId:context.variantId,fingerprint:view.fingerprint,decision:'CONFIRMED',reason:'Viewed exact image and Blue round specification'});
  assert.equal(readConsistencyView(f.db,f.context()).status,'MANUAL');assertProductConsistency(f.db,f.store.getProduct(f.p.id),[context.variantId]);
  assert.equal(f.db.prepare('SELECT count(*) n FROM ai_calls').get()!.n,0);
});
test('human decision rechecks after await and invalidates after spec or unbind/rebind; cosmetic scope is reusable',async t=>{
  const f=consistencyFixture(t),context=f.context(),view=readConsistencyView(f.db,context),input={productId:context.productId,productRevision:context.productRevision,variantId:context.variantId,fingerprint:view.fingerprint,decision:'CONFIRMED' as const,reason:'Compared image and raw spec'};
  await assert.rejects(saveConsistencyDecision(f.db,f.store,f.directory,input,async()=>{const p=f.store.getProduct(f.p.id);f.store.saveProduct({...saveInput(p),title:'new cosmetic title'});}));
  const current=f.context();await saveConsistencyDecision(f.db,f.store,f.directory,{...input,productRevision:current.productRevision});
  let p=f.store.getProduct(f.p.id);p=f.store.updateAsset({productId:p.id,revision:p.revision,assetId:p.assets[0].id,role:'main',variantIds:[]});p=f.store.updateAsset({productId:p.id,revision:p.revision,assetId:p.assets[0].id,role:'main',variantIds:[p.variants[0].id]});
  assert.equal(readConsistencyView(f.db,f.context()).status,'PENDING');await assert.rejects(saveConsistencyDecision(f.db,f.store,f.directory,{...input,productRevision:p.revision}));
});
test('human visual confirmation cannot authorize random fulfillment or clear a sent unknown liability',async t=>{
  const f=consistencyFixture(t);let context=f.context();reserveConsistencyAttempt(f.db,context,{id:randomUUID(),startedAt:new Date().toISOString()});
  assert.equal(readConsistencyView(f.db,context).status,'UNKNOWN');
  const decide=()=>saveConsistencyDecision(f.db,f.store,f.directory,{productId:context.productId,productRevision:context.productRevision,variantId:context.variantId,fingerprint:readConsistencyView(f.db,context).fingerprint,decision:'CONFIRMED',reason:'Looks similar'});
  await assert.rejects(decide());let p=f.store.getProduct(f.p.id);f.store.saveProduct({...saveInput(p),variants:saveInput(p).variants.map(v=>({...v,originalSpec:'Blue random'}))});context=f.context();await assert.rejects(decide());
});

for(const corrupt of [false,true])test(`legacy single-SKU unbound original distinguishes missing association from corrupt bytes (${corrupt})`,async t=>{
  const {persistSourceImageFixture}=await import('./helpers/source-image-receipt.ts');
  const {writeFileSync}=await import('node:fs');const {resolve}=await import('node:path');
  const f=consistencyFixture(t);let p=f.store.getProduct(f.p.id);
  p=f.store.updateAsset({productId:p.id,revision:p.revision,assetId:p.assets[0].id,role:'main',variantIds:[]});
  persistSourceImageFixture(f.directory,{productId:p.id,snapshot:{images:[{id:'blue',url:'https://images.example.com/blue.png',role:'main'}]},skuMappings:[{sourceKey:'Blue',localVariantId:p.variants[0].id,imageIds:['blue']}]} as any);
  if(corrupt)writeFileSync(resolve(f.directory,f.store.getAssetRecord(p.assets[0].id)!.originalPath),Buffer.alloc(33));
  assert.throws(()=>assertProductConsistency(f.db,p,[p.variants[0].id]),(error:any)=>{
    assert.ok(error instanceof SourceConsistencyError);
    assert.equal(error.code,corrupt?'SOURCE_CONSISTENCY_IDENTITY_INVALID':'SOURCE_CONSISTENCY_BINDING_REQUIRED');
    assert.equal(error.kind,corrupt?'SYSTEM_REPAIR':'NEEDS_INPUT');return true;
  });
  assert.equal(f.db.prepare('SELECT count(*) n FROM ai_calls').get()!.n,0);
  if(!corrupt){
    p=f.store.updateAsset({productId:p.id,revision:p.revision,assetId:p.assets[0].id,role:'main',variantIds:[p.variants[0].id]});
    assert.throws(()=>assertProductConsistency(f.db,p,[p.variants[0].id]),(error:any)=>error.code==='SOURCE_CONSISTENCY_NEEDS_INPUT','binding still requires a separate visual consistency proof');
  }
});
