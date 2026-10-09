import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { normalizeDetail } from '../src/main/miaoshou/normalize.ts';
import { detailFixture } from './helpers/miaoshou-fixture.ts';

test('source API package dimensions keep SKU provenance and do not become dimensions of a recombined bundle',async()=>{
  const module:any=await import('../src/main/image-workflow/source-measurements.ts').catch(()=>({}));
  assert.equal(typeof module.sourceImageMeasurements,'function');
  const raw=detailFixture(),p=raw.data.editCommonCollectBoxDetail;p.sourceAttrs=[];p.notes='';p.notesText='';
  const snapshot=normalizeDetail(raw,'2026-10-09T00:00:00.000Z');snapshot.skus[0].packageLength='12';snapshot.skus[0].packageWidth='8';snapshot.skus[0].packageHeight='6';
  const variantId=randomUUID(),receipt:any={mode:'live',snapshot,skuMappings:[{sourceKey:snapshot.skus[0].key,localVariantId:variantId}]};
  const draft:any={mode:'live',variantId};
  const values=module.sourceImageMeasurements(receipt,draft);assert.equal(values.length,3);assert.ok(values.every((v:any)=>v.variantId===variantId&&v.sourceSha256.length===64));
  assert.ok(values.some((v:any)=>v.value==='12 cm'));
  draft.salesPlan={recipe:{components:[{variantId,quantity:2,sourcePackPieces:1}]}};
  assert.deepEqual(module.sourceImageMeasurements(receipt,draft),[]);
  receipt.mode='demo';delete draft.salesPlan;assert.deepEqual(module.sourceImageMeasurements(receipt,draft),[]);
  receipt.mode='live';snapshot.attributes=[{name:'适用范围',value:'适用于直径 8 cm 的杯子'}];
  for(const sku of snapshot.skus){sku.packageLength=null;sku.packageWidth=null;sku.packageHeight=null;}
  assert.deepEqual(module.sourceImageMeasurements(receipt,draft),[],'Compatibility measurements must not be relabeled as product diameter');
});
