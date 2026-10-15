import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/listing-ai.ts';
import {parseFullGeneration,retainValidNativeCandidates} from '../src/main/listing-ai/full-schema.ts';
import {listingFingerprint} from '../src/main/json-fingerprint.ts';
import {validateStoredAiResult} from '../src/main/ai/validation.ts';

test('published local recovery text-citation rejection remains readable with exact output and raw hashes',async t=>{
 const f=await fixture(t),context=f.listing.currentContext(f.draft,f.product,f.amazon.executionTargetScope(f.draft.targetId).generation);
 const raw={kind:'amazon-fields',contract:'listing-full-schema/v1',candidates:[{field:'color',nativeValue:[{value:'Blue'}],evidenceIds:[f.product.assets[0].id],transformation:'infer',inferenceReason:'Visible bound source color'}],missing:[]};
 const old=retainValidNativeCandidates(parseFullGeneration(raw,context,'text-evidence/v1',true),context,true),now=new Date().toISOString();
 assert.match(old.missing.find(m=>m.field==='color')!.reason,/待补资料/);
 const result={id:randomUUID(),callId:randomUUID(),providerId:'deepseek',productId:f.product.id,productRevision:f.product.revision,variantId:context.variantId,assetId:null,assetSha256:null,sourceResultIds:[],model:'deepseek-flash',createdAt:now,reviewState:'unreviewed',output:old,listingContext:context,sourceSha256:listingFingerprint(context),listingEvidenceContractVersion:'listing-evidence/v4',localRecovery:{parserVersion:'full-schema-recovery/v1',operationId:randomUUID(),contextSha256:listingFingerprint(context),rawSha256:listingFingerprint(raw),rawOutput:raw,recoveredAt:now}};
 const literal=JSON.stringify(result);assert.deepEqual(validateStoredAiResult(result),result);assert.equal(JSON.stringify(result),literal);
 const mutations:((r:typeof result)=>void)[]=[r=>{r.output.missing[0].reason+=' changed';},r=>{r.localRecovery.rawOutput.candidates=[];},r=>{r.localRecovery.contextSha256='0'.repeat(64);},r=>{r.localRecovery.parserVersion='full-schema-recovery/v2';},r=>{r.localRecovery.parserVersion='full-schema-recovery/v3';},r=>{r.localRecovery.parserVersion='full-schema-recovery/v999';}];
 for(const mutate of mutations){const bad=structuredClone(result);mutate(bad);assert.throws(()=>validateStoredAiResult(bad));}
 const current=structuredClone(result);current.localRecovery.parserVersion='full-schema-recovery/v3';current.output=retainValidNativeCandidates(parseFullGeneration(raw,context),context);assert.deepEqual(validateStoredAiResult(current),current);
 const oldV2=structuredClone(result);oldV2.localRecovery.parserVersion='full-schema-recovery/v2';oldV2.localRecovery.rawOutput.candidates[0].evidenceIds=[randomUUID()];oldV2.localRecovery.rawSha256=listingFingerprint(oldV2.localRecovery.rawOutput);oldV2.output=retainValidNativeCandidates(parseFullGeneration(oldV2.localRecovery.rawOutput,context,'selected-image/v2',true),context,true);assert.deepEqual(validateStoredAiResult(oldV2),oldV2);
 const forgedV3=structuredClone(oldV2);forgedV3.localRecovery.parserVersion='full-schema-recovery/v3';assert.throws(()=>validateStoredAiResult(forgedV3));
 assert.equal(f.requests.length,0);
});
