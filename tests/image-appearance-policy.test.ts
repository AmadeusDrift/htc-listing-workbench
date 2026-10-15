import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {reviewProductAppearance} from '../src/main/ai/appearance-adapter.ts';
import {runAppearanceReview} from '../src/main/image-workflow/appearance-review.ts';
import type {AiResult} from '../src/shared/ai-contracts.ts';
import type {ProductImageContext} from '../src/shared/image-ai-contracts.ts';
import type {AppearanceReviewOutput} from '../src/shared/appearance-review-contracts.ts';
import {chat} from './fixtures/listing-ai.ts';

function fixture(){
 const bytes=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);bytes.writeUInt32BE(256,16);bytes.writeUInt32BE(256,20);
 const ref=randomUUID(),sha256=createHash('sha256').update(bytes).digest('hex'),candidate={id:randomUUID(),sha256,width:256,height:256};
 const context={listing:{variantId:randomUUID(),sku:'SYNTHETIC-50',evidence:[{id:'quantity',value:'50',meaning:'sale_quantity',source:'human_confirmed'}],sourceProduct:{selectedSku:{specification:'Blue bags, 50 pieces'},salesRecipe:{quantity:50}}},purpose:'main',referenceAssets:[{assetId:ref,sha256}],slot:{index:1}} as unknown as ProductImageContext;
 const plan={id:randomUUID(),output:{kind:'image-plan',prompt:'A representative single blue bag in use.',textMode:'none',expectedText:[]}} as unknown as AiResult;
 const images=[ref,candidate.id].map(assetId=>({assetId,sha256,mimeType:'image/png',width:256,height:256,bytes}));
 return {ref,candidate,context,plan,images};
}

async function review(f:ReturnType<typeof fixture>,verdict:AppearanceReviewOutput['verdict']='PASS',aspect='count',reason='Representative single bag; no complete-pack quantity claim.'){
 let request:any;
 const output={verdict,checks:[{aspect,expected:'Selected blue bag, 50 per sale pack',observed:'One representative blue bag',reason,referenceAssetIds:[f.ref]}]};
 const result=await reviewProductAppearance(f.context,f.plan,f.candidate,f.images,undefined,'openai/gpt-6-luna',{apiKey:'offline-appearance-only'},new AbortController().signal,{gateway:'openrouter',effectiveEffort:'medium',now:()=>new Date(),nonce:randomUUID,maxResponseBytes:100000,fetch:async(_url,options)=>{request=JSON.parse(String(options?.body));return chat(output);}},{policyVersion:'appearance-review/v2'});
 return {request,result};
}

test('P01 appearance prompt permits representative single-item scenes without whole-pack proof',async()=>{
 const f=fixture(),{request,result}=await review(f),system=request.messages[0].content;
 assert.match(system,/representative single-item/i);
 assert.match(system,/not.*(?:prove|proof).*entire pack/i);
 assert.match(system,/explicit quantity claim/i);
 assert.match(system,/10-pack.*50-pack/i);
 assert.match(system,/never count reference photographs as units/i);
 assert.equal(result.output.verdict,'PASS');assert.equal(request.model,'openai/gpt-6-luna');assert.deepEqual(request.reasoning,{effort:'medium'});
 const parts=request.messages[1].content,payload=JSON.parse(parts[0].text);
 assert.deepEqual(payload.candidate,f.candidate);assert.deepEqual(payload.salesRecipe,f.context.listing.sourceProduct!.salesRecipe);
 assert.equal(parts.length,3);assert.equal(parts.at(-1).image_url.url,`data:image/png;base64,${f.images.at(-1)!.bytes.toString('base64')}`);
});

test('P01 harmless small protrusions are informational while wrong identity/color/critical structure remain blocking',async()=>{
 const {request}=await review(fixture(),'PASS','shape','A small nonfunctional edge protrusion, with unchanged identity, function and sale contents.');
 const system=request.messages[0].content;
 assert.match(system,/small nonfunctional protrusion/i);assert.match(system,/informational/i);assert.match(system,/keep PASS/i);
 assert.match(system,/wrong (?:product|model)/i);assert.match(system,/selected color/i);assert.match(system,/critical parts/i);assert.match(system,/functional construction/i);
 assert.match(system,/MISMATCH requires a clear specific contradiction/i);
});

for(const [verdict,aspect,reason] of [
 ['PASS','count','One representative bag in a usage scene does not claim a complete sale pack.'],
 ['PASS','shape','Small decorative edge tab does not change identity, function or sale contents.'],
 ['MISMATCH','count','The image explicitly labels a complete 10-pack but the selected sale pack is 50.'],
 ['MISMATCH','identity','The reference is a bag but the candidate is a bottle.'],
 ['MISMATCH','color','The selected bag is blue but the candidate product is red.'],
 ['MISMATCH','shape','A required closure mechanism is missing, changing the functional construction.'],
 ['UNCERTAIN','identity','The product is obscured; its identity cannot be compared.'],
] as const)test(`P01 structured ${verdict} evidence remains unchanged: ${reason}`,async()=>{
 const f=fixture(),{result}=await review(f,verdict,aspect,reason);
 assert.equal(result.output.verdict,verdict);assert.equal(result.output.checks[0].reason,reason);assert.deepEqual(result.output.candidate,f.candidate);assert.equal(result.output.planResultId,f.plan.id);
 const saved={id:randomUUID(),output:result.output} as AiResult,attempt:any={};let sends=0;
 assert.equal(await runAppearanceReview({enabled:true,attempt,candidate:f.candidate,planResultId:f.plan.id,getSnapshot:()=>({upgrade:null}) as any,save:()=>{},findResult:()=>saved,send:async()=>{sends++;return saved;}}),verdict);
 assert.equal(sends,1);assert.equal(attempt.appearanceReview.state,'DONE');
});
