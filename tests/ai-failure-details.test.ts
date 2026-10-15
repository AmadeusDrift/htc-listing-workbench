import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { outputRejectionDetails, groupedRecoveryExplanation, recordInvalidAiOutput } from '../src/main/ai/output-diagnostics.ts';
import { fixture,chat,candidateFor } from './fixtures/listing-ai.ts';
import { validateAiResult } from '../src/main/ai/validation.ts';
import { safeError, AiError } from '../src/main/ai/errors.ts';
import { postOpenRouter } from '../src/main/ai/adapters/openrouter-http.ts';
import { recordErrorEvidence, readErrorEvidence } from '../src/main/error-evidence.ts';
import { networkFailure } from '../src/main/ai/errors.ts';

test('listing rejection maps local reason to fixed code and bounded field path without retaining evidence text',()=>{
  assert.deepEqual(outputRejectionDetails({validationReason:'字段 color 引用不存在的来源 private-secret'}),{reason:'RESULT_EVIDENCE_REF',field:'color',jsonPath:'$.output.candidates'});
  assert.deepEqual(outputRejectionDetails({validationReason:'完整 Schema 与记录的规则指纹不一致'}),{reason:'RESULT_CONTEXT_INVALID',jsonPath:'$.listingContext.schemaSha256'});
  assert.deepEqual(outputRejectionDetails({validationReason:'arbitrary provider private-secret'}),{reason:'RESULT_VALIDATION_FAILED'});
});
test('group recovery explanations distinguish retained invalid, absent body and owner mismatch without retry permission',()=>{
  assert.match(groupedRecoveryExplanation('missing-body'),/无完整正文/);
  assert.match(groupedRecoveryExplanation('invalid-body'),/有正文但校验未通过/);
  assert.match(groupedRecoveryExplanation('owner-mismatch'),/原身份\/归属不匹配/);
  for(const state of ['missing-body','invalid-body','owner-mismatch'] as const)assert.match(groupedRecoveryExplanation(state),/未复制重发/);
});
test('network diagnostics preserve only fixed cause and stage, status and byte count',()=>{
  const error=networkFailure({cause:{code:'ECONNRESET',message:'Bearer secret https://private.test/?key=secret'}},'body',200,32);
  assert.deepEqual(error.networkDiagnostic,{cause:'CONNECTION_RESET',stage:'body',httpStatus:200,receivedBytes:32});
  assert.equal(error.certainty,undefined);
  assert.equal(JSON.stringify(error).includes('secret'),false);
  assert.equal(networkFailure({code:'untrusted-secret'},'connect').networkDiagnostic?.cause,'UNKNOWN');assert.equal(networkFailure({code:'__proto__'},'connect').networkDiagnostic?.cause,'UNKNOWN');
});

test('OpenRouter body stream error keeps bytes and HTTP status with one POST and unknown certainty',async()=>{
  let posts=0;const events:unknown[]=[];
  const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array([123]));},pull(c){c.error(Object.assign(new Error('private URL and key'),{code:'ECONNRESET'}));}});
  await assert.rejects(postOpenRouter('/api/v1/chat/completions',{model:'openai/gpt-6-luna'},{apiKey:'synthetic-only-key'},new AbortController().signal,{fetch:async()=>{posts++;return new Response(stream,{status:200});},now:()=>new Date(),nonce:()=>'',maxResponseBytes:1000,onRunEvidence:e=>events.push(e)}),(e:any)=>{
    assert.equal(e.code,'NETWORK_ERROR');assert.equal(e.certainty,'SENT_UNKNOWN');assert.equal(e.networkDiagnostic.cause,'CONNECTION_RESET');assert.equal(e.networkDiagnostic.stage,'body');assert.equal(e.networkDiagnostic.httpStatus,200);assert.equal(JSON.stringify(e).includes('private'),false);return true;
  });assert.equal(posts,1);
});
test('structured failure audit preserves sanitized network and validation metadata through reader',()=>{
  let record:any;const error=Object.assign(networkFailure({code:'ENOTFOUND'},'connect'),{validationPath:'$.listingContext',validationField:'color'});
  recordErrorEvidence(v=>record=v,error,{stage:'fields'});
  assert.deepEqual(readErrorEvidence(record)?.networkDiagnostic,{cause:'DNS',stage:'connect',receivedBytes:0});
  assert.equal(readErrorEvidence(record)?.validationPath,'$.listingContext');
  assert.equal(readErrorEvidence({...record,validationPath:'https://secret.test'}),null);
});

test('one bounded failure record keeps allowed group and frozen fingerprint without complete context or free text',t=>{
  const directory=mkdtempSync(join(tmpdir(),'htc-diagnostic-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  recordInvalidAiOutput(directory,{call:{id:'11111111-1111-4111-8111-111111111111',productId:'22222222-2222-4222-8222-222222222222',productRevision:1,providerId:'openrouter',model:'openai/gpt-6-luna'} as any,operation:'amazon-fields',createdAt:'2026-10-15T01:00:00.000Z',rejectionStage:'result-record-validation',rejectionReason:'RESULT_FIELD_SCOPE',diagnosticDetails:{reason:'RESULT_FIELD_SCOPE',field:'color',jsonPath:'$.output'},allowedFields:['item_name','https://private.test'],contextSha256:'a'.repeat(64),groupOperationId:'33333333-3333-4333-8333-333333333333',output:{kind:'amazon-fields'}});
  const files=readdirSync(join(directory,'ai-diagnostics'));assert.equal(files.length,1);
  const record=JSON.parse(readFileSync(join(directory,'ai-diagnostics',files[0]),'utf8'));
  assert.deepEqual(record.allowedFields,['item_name']);assert.equal(record.contextSha256,'a'.repeat(64));assert.equal(record.groupOperationId,'33333333-3333-4333-8333-333333333333');assert.deepEqual(record.diagnosticDetails,{reason:'RESULT_FIELD_SCOPE',field:'color',jsonPath:'$.output'});assert.equal(JSON.stringify(record).includes('private'),false);
});

test('actual stored listing context rejection preserves local validationReason as OUTPUT_INVALID',async t=>{
  const f=await fixture(t),result=await f.listing.suggest(f.reference),raw=structuredClone(result);
  raw.listingContext!.schemaSha256='0'.repeat(64);
  assert.throws(()=>validateAiResult(raw),(e:any)=>{
    assert.ok(e instanceof AiError);assert.equal(safeError(e).code,'OUTPUT_INVALID');assert.equal(e.validationReason,'完整 Schema 与记录的规则指纹不一致');assert.deepEqual(outputRejectionDetails(e),{reason:'RESULT_CONTEXT_INVALID',jsonPath:'$.listingContext.schemaSha256'});return true;
  });assert.equal(f.requests.length,1);
});
test('group scope rejection records exact allowed fields and original context fingerprint with no resend',async t=>{
  const f=await fixture(t);f.ai.saveConnection({id:'openrouter',apiKey:'scope-group-fixture-key'});f.ai.setEnabled({id:'openrouter',enabled:true});
  const p=f.ai.getPurposeProfiles().find(p=>p.purposeId==='listing_title')!;f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-astra',effort:'high'}});
  f.respond(payload=>{const output=candidateFor(payload);output.missing.push({field:'outside_group_field',reason:'synthetic scope mismatch'});return chat(output);});
  await assert.rejects(f.listing.suggest(f.reference),(e:any)=>e.code==='OUTPUT_INVALID'&&e.diagnosticReason==='RESULT_FIELD_SCOPE'&&e.validationField==='outside_group_field');
  const files=readdirSync(join(f.directory,'ai-diagnostics'));assert.equal(files.length,1);const record=JSON.parse(readFileSync(join(f.directory,'ai-diagnostics',files[0]),'utf8'));
  assert.equal(record.rejectionStage,'result-record-validation');assert.equal(record.rejectionReason,'RESULT_FIELD_SCOPE');assert.equal(record.diagnosticDetails.field,'outside_group_field');assert.ok(record.allowedFields.length);assert.match(record.contextSha256,/^[a-f0-9]{64}$/);assert.ok(record.groupOperationId);
  await assert.rejects(f.listing.suggest(f.reference),/有正文但校验未通过/);assert.equal(f.requests.length,1);
});
