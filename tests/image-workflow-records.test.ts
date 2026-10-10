import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ProductDetail, Asset } from '../src/shared/contracts.ts';
import { selectImageReferences, validateImageWorkflowRun } from '../src/main/image-workflow/records.ts';

const id = randomUUID, a = id(), b = id();
const image = (variantIds: string[], role: Asset['role'] = 'gallery'): Asset => ({ id: id(), fileName: 'source.png', role, mimeType: 'image/png', width: 512, height: 512, byteSize: 100, previewUrl: '', variantIds, createdAt: '2026-10-08T00:00:00.000Z' });
const product = (assets: Asset[], variants = [a,b]) => ({ id: id(), revision: 1, variants: variants.map(id => ({ id })), assets }) as ProductDetail;
test('reference selection prioritizes selected SKU and excludes other SKU, unbound ambiguity and generated outputs', () => {
  const own = image([a]), other = image([b], 'main'), common = image([a,b]), unbound = image([]), generated = image([a]);
  const refs = selectImageReferences(product([other,common,unbound,own,generated]), a, new Set([generated.id]), () => true);
  assert.deepEqual(refs.map(r => r.id), [own.id, common.id]);
});
test('single-SKU images are automatically usable but explicit unconfirmed bindings are excluded', () => {
  const unbound = image([], 'main'), pending = image([a]);
  assert.deepEqual(selectImageReferences(product([pending,unbound], [a]), a, new Set(), () => false,true).map(r => r.id), [unbound.id]);
  assert.throws(() => selectImageReferences(product([image([b])]), a, new Set(), () => true), /参考图/);
});
test('unbound reference selection requires explicit current source authorization',()=>{
  assert.throws(()=>selectImageReferences(product([image([])],[a]),a,new Set(),()=>false));
});
test('mixed sales references cover every component before spending the remaining reference budget', () => {
  const variants = Array.from({length:5}, id), assets = variants.flatMap(variant => [image([variant], 'main'), image([variant])]);
  const refs = selectImageReferences(product(assets,variants), variants[0], new Set(), () => true, false, variants);
  for (const variant of variants) assert.ok(refs.some(ref=>ref.variantIds.includes(variant)));
  assert.ok(refs.length <= 10);
  assert.throws(()=>selectImageReferences(product(assets,variants),variants[0],new Set(),(_asset,variant)=>variant!==variants[4],false,variants),/参考图/);
});
test('persisted workflow cannot claim completion without exact image and review provenance', () => {
  const now = new Date().toISOString();
  const run = { id: id(), draftId: id(), productId: id(), productRevision: 1, variantId: a, sku: 'SKU-A', status: 'RUNNING', stage: 'content', attempt: 0, maxAttempts: 2,
    contextSha256: null, draftSha256: null, referenceAssets: [], planResultIds: [], candidateIds: [], ocrResultIds: [], reviewResultIds: [], approvedAssetId: null, approvedSha256: null, createdAt: now, updatedAt: now, error: null };
  assert.equal(validateImageWorkflowRun(run).status, 'RUNNING');
  assert.throws(() => validateImageWorkflowRun({ ...run, status: 'COMPLETED', stage: 'complete' }));
  assert.throws(() => validateImageWorkflowRun({ ...run, attempt: 3 }));
  assert.throws(() => validateImageWorkflowRun({ ...run, token: 'secret' }));
});

test('single-image record markers preserve explicit historical literals and reject unknown versions',()=>{
  const now=new Date().toISOString(),run={id:id(),draftId:id(),productId:id(),productRevision:1,variantId:a,sku:'SKU-A',status:'RUNNING',stage:'content',attempt:0,maxAttempts:1,contextSha256:null,draftSha256:null,referenceAssets:[],planResultIds:[],candidateIds:[],ocrResultIds:[],reviewResultIds:[],approvedAssetId:null,approvedSha256:null,createdAt:now,updatedAt:now,error:null};
  assert.deepEqual(validateImageWorkflowRun(run),run);
  for(const version of ['listing-evidence/v1','listing-evidence/v2','listing-evidence/v3'])assert.deepEqual(validateImageWorkflowRun({...run,listingEvidenceContractVersion:version}),{...run,listingEvidenceContractVersion:version});
  assert.throws(()=>validateImageWorkflowRun({...run,listingEvidenceContractVersion:'listing-evidence/v999'}));
});
