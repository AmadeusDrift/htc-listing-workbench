import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, chat } from './fixtures/listing-ai.ts';
import { AiError } from '../src/main/ai/errors.ts';
import { requestDeepSeekJson } from '../src/main/ai/adapters.ts';

const invalidOutput = { kind:'amazon-fields', candidates:[], missing:[], unexpected:'Unapproved response for offline diagnosis' };
const outputInvalid = (error: unknown) => error instanceof AiError && error.code === 'OUTPUT_INVALID';
const diagnosticFiles = (directory: string) => existsSync(join(directory,'ai-diagnostics'))
  ? readdirSync(join(directory,'ai-diagnostics')).filter(name=>name.endsWith('.json')).sort() : [];
const diagnostics = (directory: string) => diagnosticFiles(directory).map(name=>JSON.parse(readFileSync(join(directory,'ai-diagnostics',name),'utf8')));

test('a paid-boundary service output failure retains only its unapproved reply and fixed rejection metadata', async t => {
  const f=await fixture(t); f.respond(()=>chat(invalidOutput));
  await assert.rejects(f.listing.suggest(f.reference),outputInvalid);
  const calls=f.ai.listCalls(),saved=diagnostics(f.directory);
  assert.equal(saved.length,1,'the rejected provider JSON must remain available without another POST');
  assert.equal(saved[0].callId,calls[0].id); assert.equal(saved[0].operation,'amazon-fields');
  assert.equal(saved[0].productId,f.product.id); assert.equal(saved[0].productRevision,f.product.revision);
  assert.equal(saved[0].model,calls[0].model); assert.equal(saved[0].createdAt,calls[0].finishedAt);
  assert.equal(saved[0].approved,false); assert.equal(saved[0].errorCode,'OUTPUT_INVALID');
  assert.equal(saved[0].rejectionStage,'operation-output-validation'); assert.deepEqual(saved[0].output,invalidOutput);
  assert.equal(f.ai.listResults(f.product.id).length,0); assert.equal(f.requests.length,1);
  assert.equal(calls[0].status,'FAILED'); assert.equal(calls[0].errorCode,'OUTPUT_INVALID');
  assert.equal(f.ai.getUsageSummary('deepseek').reportedTokens,150);
  const serialized=JSON.stringify(saved);
  for(const forbidden of ['fixture-shared-listing-key','UNVERIFIED TITLE','PRIVATE_BRAND','schemaSha256','listingContext','requestHeaders']) assert.equal(serialized.includes(forbidden),false,forbidden);
});

test('credential echoes are rejected before diagnostic capture while their reported usage still settles', async t => {
  const f=await fixture(t); f.respond(()=>chat({...invalidOutput,unexpected:'fixture-shared-listing-key'}));
  await assert.rejects(f.listing.suggest(f.reference),outputInvalid);
  assert.deepEqual(diagnosticFiles(f.directory),[]); assert.equal(f.ai.listResults(f.product.id).length,0);
  assert.equal(f.requests.length,1); assert.equal(f.ai.getUsageSummary('deepseek').reportedTokens,150);
});

test('JSON-escaped credential echoes cannot bypass the diagnostic secret gate', async t => {
  const f=await fixture(t),key='offline-key-with-"quote-and-\\slash';
  f.ai.saveConnection({id:'deepseek',apiKey:key}); f.respond(()=>chat({...invalidOutput,unexpected:key}));
  await assert.rejects(f.listing.suggest(f.reference),outputInvalid);
  assert.deepEqual(diagnosticFiles(f.directory),[]); assert.equal(f.requests.length,1);
  assert.equal(f.ai.getUsageSummary('deepseek').reportedTokens,150);
});

test('successful replies create no failure diagnostic and never trigger a duplicate request', async t => {
  const f=await fixture(t),result=await f.listing.suggest(f.reference);
  assert.equal(result.output.kind,'amazon-fields'); assert.deepEqual(diagnosticFiles(f.directory),[]);
  assert.equal(f.ai.listResults(f.product.id).length,1); assert.equal(f.requests.length,1);
});

test('diagnostic I/O failure cannot replace OUTPUT_INVALID or prevent usage settlement', async t => {
  const f=await fixture(t); writeFileSync(join(f.directory,'ai-diagnostics'),'blocked directory'); f.respond(()=>chat(invalidOutput));
  await assert.rejects(f.listing.suggest(f.reference),outputInvalid);
  assert.equal(f.ai.listCalls()[0].errorCode,'OUTPUT_INVALID'); assert.equal(f.requests.length,1);
  assert.equal(f.ai.getUsageSummary('deepseek').reportedTokens,150); assert.equal(f.ai.getUsageSummary('deepseek').pendingCalls,0);
  assert.equal(readFileSync(join(f.directory,'ai-diagnostics'),'utf8'),'blocked directory');
});

test('a diagnostic directory junction cannot redirect failure output into another folder', async t => {
  const f=await fixture(t),target=join(f.directory,'elsewhere'); mkdirSync(target);
  symlinkSync(target,join(f.directory,'ai-diagnostics'),'junction'); f.respond(()=>chat(invalidOutput));
  await assert.rejects(f.listing.suggest(f.reference),outputInvalid);
  assert.deepEqual(readdirSync(target),[]); assert.equal(f.ai.getUsageSummary('deepseek').reportedTokens,150);
});

test('diagnostics remove echoed credential fields, headers and embedded image bytes', async t => {
  const f=await fixture(t),pixels='iVBORw0KGgo'+ 'A'.repeat(500);
  f.respond(()=>chat({...invalidOutput,credentials:{apiKey:'unrelated-key'},requestHeaders:{authorization:'Bearer unrelated-token'},b64_json:pixels,preview:`data:image/png;base64,${pixels}`,caption:`Keep this note, but omit data:image/png;base64,${pixels}`}));
  await assert.rejects(f.listing.suggest(f.reference),outputInvalid);
  const saved=diagnostics(f.directory); assert.equal(saved.length,1);
  const json=JSON.stringify(saved);
  for(const forbidden of ['unrelated-key','unrelated-token',pixels,'data:image/png;base64']) assert.equal(json.includes(forbidden),false,forbidden.slice(0,40));
  assert.match(json,/Keep this note/); assert.equal(saved[0].approved,false);
});

test('short encoded images are removed even when placed in arbitrary JSON values or keys', async t => {
  const f=await fixture(t),bytes=Buffer.alloc(33); Buffer.from('89504e470d0a1a0a','hex').copy(bytes);
  const pixels=bytes.toString('base64'); f.respond(()=>chat({...invalidOutput,note:pixels,[`data:image/png;base64,${pixels}`]:'not a permissible diagnostic key'}));
  await assert.rejects(f.listing.suggest(f.reference),outputInvalid);
  const saved=diagnostics(f.directory); assert.equal(saved.length,1); assert.equal(JSON.stringify(saved).includes(pixels),false);
});

test('a multibyte response larger than 200 KB keeps bounded metadata instead of an oversized raw output', async t => {
  const f=await fixture(t); f.respond(()=>chat({...invalidOutput,unexpected:'测'.repeat(75000)}));
  await assert.rejects(f.listing.suggest(f.reference),outputInvalid);
  const files=diagnosticFiles(f.directory); assert.equal(files.length,1);
  assert.ok(statSync(join(f.directory,'ai-diagnostics',files[0])).size<=200000);
  const saved=diagnostics(f.directory)[0]; assert.equal(saved.output,null); assert.equal(saved.outputOmitted,'size_limit');
  assert.ok(saved.outputByteLength>200000); assert.equal(f.requests.length,1);
});

test('failure diagnostics retain at most fifty files and leave unrelated local files untouched', async t => {
  const f=await fixture(t); mkdirSync(join(f.directory,'ai-diagnostics')); writeFileSync(join(f.directory,'ai-diagnostics','notes.txt'),'retain me');
  f.respond(()=>chat(invalidOutput));
  for(let index=0;index<53;index++) await assert.rejects(f.listing.suggest(f.reference),outputInvalid);
  const files=diagnosticFiles(f.directory),saved=diagnostics(f.directory),calls=f.ai.listCalls();
  assert.equal(files.length,50); assert.equal(f.requests.length,53); assert.equal(f.ai.listResults(f.product.id).length,0);
  assert.equal(saved.some(record=>record.callId===calls[0].id),false);
  assert.equal(saved.some(record=>record.callId===calls.at(-1)!.id),true);
  assert.equal(readFileSync(join(f.directory,'ai-diagnostics','notes.txt'),'utf8'),'retain me');
});

test('a throwing optional capture observer cannot alter an otherwise valid provider reply', async () => {
  let captured=false,posts=0;
  const context:any={now:()=>new Date(),nonce:()=>'',maxResponseBytes:100000,fetch:async()=>{posts++;return chat({value:'accepted JSON'});},onUntrustedOutput:()=>{captured=true;throw new Error('diagnostic observer failed');}};
  const reply=await requestDeepSeekJson({operation:'fixture'},'Return JSON.','deepseek-flash',{apiKey:'fake-offline-key'},new AbortController().signal,context);
  assert.equal(captured,true); assert.deepEqual(reply.content,{value:'accepted JSON'}); assert.equal(posts,1);
});

test('a rejection reason is stored as a fixed code and anything else is dropped', async t => {
  const { recordInvalidAiOutput } = await import('../src/main/ai/output-diagnostics.ts');
  const { mkdtempSync, rmSync } = await import('node:fs'); const { tmpdir } = await import('node:os');
  const directory = mkdtempSync(join(tmpdir(),'htc-reason-')); t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const call = (id: string) => ({ id, productId:'11111111-1111-4111-8111-111111111111', productRevision:1, providerId:'deepseek', model:'deepseek-flash' }) as any;
  recordInvalidAiOutput(directory,{call:call('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),operation:'image-plan',createdAt:'2026-10-10T04:00:00.000Z',rejectionStage:'operation-output-validation',rejectionReason:'EMPTY_PROMPT',output:{prompt:''}});
  recordInvalidAiOutput(directory,{call:call('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),operation:'image-plan',createdAt:'2026-10-10T04:00:01.000Z',rejectionStage:'operation-output-validation',rejectionReason:'free text from a provider',output:{}});
  recordInvalidAiOutput(directory,{call:call('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),operation:'image-plan',createdAt:'2026-10-10T04:00:02.000Z',rejectionStage:'operation-output-validation',output:{}});
  const saved = diagnostics(directory);
  assert.equal(saved.length,3); assert.equal(saved[0].rejectionReason,'EMPTY_PROMPT');
  assert.equal('rejectionReason' in saved[1],false); assert.equal('rejectionReason' in saved[2],false);
});
