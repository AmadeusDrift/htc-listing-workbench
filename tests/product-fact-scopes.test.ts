import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { saveInput } from './fixtures/listing-ai.ts';
import { projectSalesProduct } from '../src/main/sales-plans/records.ts';

test('scope selection is durable, CAS protected and excludes other SKU and unknown facts', t => {
  mkdirSync(resolve('.test-data'),{recursive:true}); const dir=mkdtempSync(resolve('.test-data/fact-scopes-'));
  let store=new WorkspaceStore(dir); t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  let p=store.createProduct(); const a=p.variants[0],b={...a,id:randomUUID(),sku:'OTHER'};
  const fact=(value:string,scope:string,variantId?:string)=>({id:randomUUID(),name:'材质',value,source:'import',sourceRef:'original',state:'source_confirmed',scope,...(variantId?{variantId}:{})});
  p=store.saveProduct({...saveInput(p),variants:[a,b].map(({sourceSpec,sourcePurchasePrice,...v})=>v),facts:[fact('cotton','variant',a.id),fact('steel','variant',b.id),fact('shared','common'),fact('uncertain','unknown')]});
  assert.deepEqual(projectSalesProduct(p,undefined,a.id).facts.map(f=>f.value),['cotton','shared']);
  assert.deepEqual(projectSalesProduct(p,undefined,b.id).facts.map(f=>f.value),['steel','shared']);
  const stale=saveInput(p);p=store.saveProduct({...saveInput(p),facts:p.facts.map(f=>f.value==='cotton'?{...f,scope:'common',variantId:undefined}:f)});
  assert.throws(()=>store.saveProduct(stale),/已更新/); assert.equal(p.facts[0].source,'import');
  store.close();store=new WorkspaceStore(dir);assert.deepEqual(store.getProduct(p.id).facts,p.facts);
});

import { AmazonService } from '../src/main/amazon/service.ts';
import { mockStorage } from './fixtures/listing-ai.ts';
import { buildListingContext } from '../src/main/listing-ai/context.ts';
import { imageEvidence } from '../src/main/image-workflow/image-facts.ts';
import { imageRiskSourceSnapshot } from '../src/main/ai/image-validation.ts';
import { sourceAttributes } from '../src/main/amazon/demo.ts';
import { createWorkspaceBackup,prepareWorkspaceRestore,commitWorkspaceRestore } from '../src/main/backup.ts';
import { openDatabase } from '../src/main/database.ts';
import { assertSourceAdoptionHistory } from '../src/main/products/source-adoption.ts';
import { persistImport } from '../src/main/miaoshou/persistence.ts';
import { normalizeDetail } from '../src/main/miaoshou/normalize.ts';
import { detailFixture,mappingFor } from './helpers/miaoshou-fixture.ts';
import { join } from 'node:path';

test('real listing, full Schema payload and image consumers isolate contradictory variants and invalidate stale drafts',async t=>{
  t.mock.method(globalThis,'fetch',()=>{throw Error('No external requests');});
  mkdirSync(resolve('.test-data'),{recursive:true});const dir=mkdtempSync(resolve('.test-data/scope-consumers-'));
  const store=new WorkspaceStore(dir),amazon=new AmazonService(dir,id=>store.getProduct(id),mockStorage);
  t.after(()=>{amazon.close();store.close();rmSync(dir,{recursive:true,force:true});});
  let p=store.createProduct();const a=p.variants[0],b={...a,id:randomUUID(),sku:'OTHER'};
  const fact=(name:string,value:string,scope:string,variantId?:string)=>({id:randomUUID(),name,value,source:'import',sourceRef:'original',state:'source_confirmed',scope,...(variantId?{variantId}:{})});
  p=store.saveProduct({...saveInput(p),variants:[a,b].map(({sourceSpec,sourcePurchasePrice,...v})=>v),facts:[fact('材质','Cotton','variant',a.id),fact('材质','Steel','variant',b.id),fact('护理说明','Wash gently','common'),fact('香味','Unknown perfume','unknown')]});
  const target=amazon.enableDemo();
  for(const [id,value,other] of [[a.id,'Cotton','Steel'],[b.id,'Steel','Cotton']]){
    const draft=await amazon.createDraft({productId:p.id,variantId:id,targetId:target.id,productType:'HTC_DEMO_STORAGE_BAG',parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'});
    const context=buildListingContext(draft,p,1);
    assert.ok(context.evidence.some(e=>e.value===value));assert.ok(context.evidence.some(e=>e.value==='Wash gently'));
    assert.ok(!JSON.stringify(context).includes(other));assert.ok(!JSON.stringify(context).includes('Unknown perfume'));
    assert.ok(!JSON.stringify(imageEvidence({listing:context} as any)).includes(other));
    assert.ok(!JSON.stringify(imageRiskSourceSnapshot(p,id)).includes(other));
    assert.ok(!JSON.stringify(sourceAttributes(p,p.variants.find(v=>v.id===id)!,draft.schema,target)).includes(other));
    if(id===a.id){
      const current=store.saveProduct({...saveInput(p),facts:p.facts.map(f=>f.value==='Cotton'?{...f,scope:'unknown',variantId:undefined}:f)});
      assert.throws(()=>buildListingContext(draft,current,1),/已变化/);
      p=current;
    }
  }
});

test('source remains immutable and pending after manual scope confirmation; backup preserves bindings',async t=>{
  t.mock.method(globalThis,'fetch',()=>{throw Error('No external requests');});
  mkdirSync(resolve('.test-data'),{recursive:true});const dir=mkdtempSync(resolve('.test-data/scope-backup-'));
  const store=new WorkspaceStore(dir),db=openDatabase(dir);t.after(()=>{db.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const source=normalizeDetail(detailFixture(),'2026-10-13T00:00:00.000Z','demo',v=>v);
  const receive=(s=source)=>persistImport(db,store,s,mappingFor(s),'a'.repeat(64),'demo','2026-10-13T01:00:00.000Z');
  const receipt=receive();let p=store.getProduct(receipt.productId);assert.ok(p.facts.length);assert.ok(p.facts.every(f=>f.scope==='unknown'));
  const before=String(db.prepare('SELECT record_json FROM miaoshou_receipts').get()!.record_json);
  p=store.saveProduct({...saveInput(p),facts:p.facts.map((f,i)=>({...f,scope:i?'common':'variant',...(i?{}:{variantId:p.variants[0].id})}))});
  receive({...source,title:'New supplier title'});
  assert.equal(store.getProduct(p.id).title,p.title);assert.equal(String(db.prepare('SELECT record_json FROM miaoshou_receipts').get()!.record_json),before);
  assertSourceAdoptionHistory(db);
  const backup=join(dir,'scope.htcbackup'),restoredPath=join(dir,'restored');await createWorkspaceBackup(dir,backup,'scope-passphrase');
  const prepared=await prepareWorkspaceRestore(restoredPath,backup,'scope-passphrase');await commitWorkspaceRestore(restoredPath,prepared);
  const restored=new WorkspaceStore(restoredPath);try{assert.deepEqual(restored.getProduct(p.id).facts,p.facts);}finally{restored.close();}
});

import { miaoshouMeasurementsForVariant } from '../src/main/miaoshou/measurements.ts';
import { currentSourceImageMeasurements } from '../src/main/image-workflow/source-measurements.ts';

test('receipt measurement paths cannot rebroadcast unknown or other SKU facts through raw attributes and prose',t=>{
  mkdirSync(resolve('.test-data'),{recursive:true});const dir=mkdtempSync(resolve('.test-data/scope-measurements-'));
  const store=new WorkspaceStore(dir),db=openDatabase(dir);t.after(()=>{db.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const source={...normalizeDetail(detailFixture(),'2026-10-13T00:00:00.000Z','demo',v=>v),attributes:[{name:'产品长度',value:'11 cm'},{name:'产品宽度',value:'22 cm'},{name:'产品高度',value:'33 cm'}],description:'产品长度：99 cm'};
  const receipt=persistImport(db,store,source,mappingFor(source),'a'.repeat(64),'demo','2026-10-13T01:00:00.000Z');let p=store.getProduct(receipt.productId);
  assert.ok(p.variants.length>=2);const [a,b]=p.variants;
  assert.equal(miaoshouMeasurementsForVariant(db,p.id,a.id,'demo').item,undefined);
  p=store.saveProduct({...saveInput(p),facts:p.facts.map((f,i)=>i===0?{...f,scope:'variant',variantId:a.id}:i===1?{...f,scope:'common'}:f)});
  assert.equal(miaoshouMeasurementsForVariant(db,p.id,a.id,'demo').item?.length?.value,4.33);
  assert.equal(miaoshouMeasurementsForVariant(db,p.id,b.id,'demo').item?.length,undefined);
  assert.equal(miaoshouMeasurementsForVariant(db,p.id,b.id,'demo').item?.width?.value,8.66);
  const image=currentSourceImageMeasurements(db,{productId:p.id,variantId:b.id,mode:'demo'} as any);
  assert.ok(image.some(m=>m.value==='22 cm'));assert.ok(!image.some(m=>/11|33|99/.test(m.value)));
  assert.throws(()=>store.saveProduct({...saveInput(p),facts:p.facts.map((f,i)=>i?f:{...f,variantId:randomUUID()})}),/不属于/);
  assert.throws(()=>store.saveProduct({...saveInput(p),variants:saveInput(p).variants.filter(v=>v.id!==a.id)}),/不属于|移除/);
  assert.deepEqual(store.getProduct(p.id),p);
  const omitted=store.saveProduct({...saveInput(p),facts:p.facts.map(({scope,variantId,...f})=>f)});
  assert.deepEqual(omitted.facts,p.facts);assertSourceAdoptionHistory(db);
});

import { productSourceQuantity } from '../src/shared/source-quantity.ts';
import { previewSalesRecipes } from '../src/main/sales-plans/planning.ts';
import { defaultListingRules } from '../src/shared/listing-rules.ts';

test('sales consumers resolve packaging quantity and procurement currency per variant',t=>{
  mkdirSync(resolve('.test-data'),{recursive:true});const dir=mkdtempSync(resolve('.test-data/scope-sales-'));
  const store=new WorkspaceStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  let p=store.createProduct();const a={...p.variants[0],purchasePrice:'2'},b={...a,id:randomUUID(),sku:'SECOND'};
  const fact=(name:string,value:string,variantId:string)=>({id:randomUUID(),name,value,source:'manual',sourceRef:'confirmed',state:'human_confirmed',scope:'variant',variantId});
  p=store.saveProduct({...saveInput(p),variants:[a,b].map(({sourceSpec,sourcePurchasePrice,...v})=>v),facts:[fact('采购币种','CNY',a.id),fact('采购币种','USD',b.id),fact('包装数量','2',a.id),fact('包装数量','3',b.id),{...fact('包装数量','99',a.id),scope:'unknown',variantId:undefined}]});
  assert.equal(productSourceQuantity(p,p.variants[0]).piecesPerPack,2);assert.equal(productSourceQuantity(p,p.variants[1]).piecesPerPack,3);
  const recipes=previewSalesRecipes(p,null,defaultListingRules());
  assert.ok(recipes.some(r=>r.components.length===1&&r.components[0].variantId===a.id&&r.totalCostCny!==null));
  assert.ok(recipes.filter(r=>r.components.some(c=>c.variantId===b.id)).every(r=>r.totalCostCny===null));
});

import { productFactEvidence } from '../src/shared/fact-scopes.ts';
test('product-level classification distinguishes common, variant and unknown facts without changing legacy payload',()=>{
  const fact=(scope?:'common'|'variant'|'unknown')=>({id:randomUUID(),name:'材质',value:scope??'legacy',source:'import' as const,sourceRef:'source',state:'source_confirmed' as const,...(scope?{scope}:{}),...(scope==='variant'?{variantId:randomUUID()}:{})});
  const legacy=fact();assert.deepEqual(productFactEvidence({facts:[legacy]}),{facts:[{name:'材质',value:'legacy'}]});
  const result=productFactEvidence({facts:[fact('common'),fact('variant'),fact('unknown')]});
  assert.deepEqual(result.facts,[{name:'材质',value:'common'}]);assert.equal(result.variantFacts?.length,1);assert.equal(result.unknownFacts?.length,1);
  assert.match(result.factScopeNote!,/not authoritative/);
});

import { fixture as aiControlFixture, json as aiJson } from './fixtures/ai-control.ts';
test('real category request labels product-level, variant and unknown applicability without broadcasting scoped facts',async t=>{
  const f=await aiControlFixture(t,{fetch:async()=>aiJson({id:'scope-category',choices:[{finish_reason:'stop',message:{content:JSON.stringify({kind:'category-decision',phase:'keywords',keywords:['cloth'],productType:null,reason:'Product classification',ambiguous:false})}}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})});
  f.enable('deepseek');const base=f.product,variantId=base.variants[0].id;
  const p=f.store.saveProduct({...saveInput(base),facts:[{...base.facts[0],scope:'common'}, {...base.facts[0],id:randomUUID(),value:'Variant-only material',scope:'variant',variantId},{...base.facts[0],id:randomUUID(),value:'Uncertain material',scope:'unknown'}]});
  await f.service.decideCategory({productId:p.id,productRevision:p.revision,phase:'keywords',candidates:[]});
  const body=JSON.parse(String(f.requests[0].options?.body)),payload=JSON.parse(body.messages[1].content.find((p:any)=>p.type==='text').text);
  assert.deepEqual(payload.facts,[{name:'Material',value:'Cotton'}]);assert.equal(payload.variantFacts[0].variantId,variantId);assert.equal(payload.unknownFacts[0].scope,'unknown');
});

import { exportProductData,parseImport } from '../src/main/import-export.ts';
test('portable product export preserves scope and remaps variant binding by stable SKU',()=>{
  const a={id:randomUUID(),sku:'A',originalSpec:'',normalizedSpec:'',purchasePrice:'',inventory:null,sourceSpec:'',sourcePurchasePrice:''};
  const product={id:randomUUID(),title:'Export',sourceUrl:'',description:'',status:'draft',origin:'manual',revision:1,createdAt:'',updatedAt:'',assets:[],variants:[a],facts:[{id:randomUUID(),name:'Material',value:'Cotton',source:'import',sourceRef:'original',state:'source_confirmed',scope:'variant',variantId:a.id},{id:randomUUID(),name:'Scent',value:'Unknown',source:'import',sourceRef:'original',state:'source_confirmed',scope:'unknown'}]} as any;
  const portable=exportProductData(product) as any;assert.equal(portable.version,2);
  const restored=parseImport(JSON.stringify(portable),'json')[0];assert.equal(restored.facts[0].variantId,restored.variants[0].id);assert.notEqual(restored.variants[0].id,a.id);assert.equal(restored.facts[1].scope,'unknown');
});
