// These assertions capture baseline defects. They are NOT desired post-fix contracts.
// Run explicitly with the S00 launcher; downstream fixes replace these with their acceptance tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { postOpenRouter } from '../../../src/main/ai/adapters/openrouter-http.ts';
import { AiError } from '../../../src/main/ai/errors.ts';
import { fixture, json } from '../ai-control.ts';
import { normalizeSourceObservations } from '../../../src/main/source-image-consistency/comparison.ts';
import { sourceQuantity } from '../../../src/shared/source-quantity.ts';
import { buildSalesRecipes } from '../../../src/main/sales-plans/recipes.ts';
import { defaultListingRules } from '../../../src/shared/listing-rules.ts';
import type { ProductDetail } from '../../../src/shared/contracts.ts';
import { reviewFixture } from './review-fixture.ts';
import { allowedAsset, wrongAssetOutput, mixedKit, judgeNull, slowBody } from './samples.ts';

test('R1 baseline: early headers and 31s body are truncated at 30s and misclassified CANCELLED', async t => {
  let posts=0, receipts=0;
  const timers: ReturnType<typeof setTimeout>[]=[];
  const server=createServer((request,response)=>{
    assert.equal(request.method,'POST'); posts++;
    response.writeHead(200,{'content-type':'application/json'}); response.flushHeaders();
    timers.push(setTimeout(()=>response.end(JSON.stringify(slowBody.body)),slowBody.delayMs));
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{timers.forEach(clearTimeout);server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));});
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const started=Date.now();
  await assert.rejects(postOpenRouter('/api/v1/chat/completions',{model:'synthetic'},{apiKey:'fixture-only'},AbortSignal.timeout(slowBody.outerTimeoutMs),{
    fetch:(_url,init)=>fetch(`http://127.0.0.1:${address.port}`,init), now:()=>new Date(),nonce:()=>'',maxResponseBytes:10000,
    onProviderReceipt:()=>{receipts++;},
  }), (error:unknown)=>error instanceof AiError&&error.code==='CANCELLED');
  assert.equal(posts,1); assert.equal(receipts,0); assert.ok(Date.now()-started>=29_000);
  console.log(JSON.stringify({fixture:'slow-body',posts,receipts,elapsedMs:Date.now()-started,baselineError:'CANCELLED'}));
});

test('R2 baseline: complete judge/null receipt blocks explicit continuation with zero additional requests',async t=>{
  const f=await fixture(t,{fetch:async()=>json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(judgeNull)}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})});
  f.service.saveConnection({id:'openrouter',apiKey:'synthetic-category-key'});f.service.setEnabled({id:'openrouter-review',enabled:true});
  const input={productId:f.product.id,productRevision:f.product.revision,phase:'judge' as const,candidates:[{name:'STORAGE_BOX',displayName:'Storage box'}]};
  await assert.rejects(f.service.decideCategory(input),(error:unknown)=>error instanceof AiError&&error.diagnosticReason==='CATEGORY_SELECTION_MISSING');
  const call=f.service.listCalls()[0];assert.ok(call.providerReceiptId);
  await assert.rejects(f.service.decideCategory(input),/类目历史请求/);
  assert.equal(f.requests.length,1);assert.equal(f.service.listResults(f.product.id).length,0);
  console.log(JSON.stringify({fixture:'judge-null',requests:f.requests.length,receipts:1,adopted:0}));
});

test('V07 baseline protection: one-character wrong asset UUID is rejected without approximate adoption',()=>{
  assert.throws(()=>normalizeSourceObservations(wrongAssetOutput,{claims:[],referenceAssets:[{assetId:allowedAsset}]} as never));
  console.log(JSON.stringify({fixture:'wrong-asset',requests:0,adopted:0}));
});

test('R3 baseline: accessory count divides an 8.2 CNY kit into a fictitious 1.64 CNY mixed ten-piece recipe',()=>{
  const product:ProductDetail={id:randomUUID(),title:'普通过滤支架',description:'',sourceUrl:'',origin:'manual',status:'draft',revision:1,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',assets:[],facts:[],variants:mixedKit.colors.map((color,i)=>({id:randomUUID(),sku:`synthetic-${i}`,originalSpec:`颜色: ${color} / ${mixedKit.spec}`,sourceSpec:`颜色: ${color} / ${mixedKit.spec}`,normalizedSpec:'',purchasePrice:String(mixedKit.quotedCny),sourcePurchasePrice:String(mixedKit.quotedCny),inventory:null}))};
  assert.equal(sourceQuantity(mixedKit.spec).piecesPerQuote,50);
  const recipe=buildSalesRecipes(product,null,defaultListingRules()).find(r=>r.components.length>1)!;
  assert.equal(recipe.totalPieces,10);assert.equal(recipe.totalCostCny,1.64);assert.deepEqual(recipe.components.map(c=>c.quantity),[5,5]);
  console.log(JSON.stringify({fixture:'mixed-kit',requests:0,totalPieces:recipe.totalPieces,totalCostCny:recipe.totalCostCny}));
});

for(const stage of ['risk','ocr','text'] as const) test(`R4 baseline: ${stage} review interruption is redispatched after reopening workflow`,async t=>{
  const f=await reviewFixture(t);
  const name=stage==='risk'?'reviewGeneratedImageRisk':stage==='ocr'?'recognizeGeneratedImage':'reviewGeneratedImage';
  let requests=0;
  f.ai[name]=async()=>{requests++;throw new AiError('NETWORK_ERROR');};
  const first=await f.run();assert.equal(requests,1,JSON.stringify({error:first.workflow.error,calls:f.calls}));
  const attempt=first.workflow.slots![0].attempts[0];assert.ok(attempt.candidateId);
  assert.equal(stage==='risk'?attempt.ipReviewResultId:stage==='ocr'?attempt.ocrResultId:attempt.reviewResultId,null);
  await f.service.close();const reopened=f.reopen();
  try {
    const second=await reopened.complete({draftId:f.draft.id,draftRevision:f.amazon.getDraft(f.draft.id).revision});
    assert.equal(requests,2);assert.equal(second.workflow.slots![0].attempts[0].candidateId,attempt.candidateId);
  } finally { await reopened.close(); }
  console.log(JSON.stringify({fixture:'review-interruption',stage,requests,generations:f.calls.filter(c=>c==='generate').length,persistedReviewId:false}));
});
