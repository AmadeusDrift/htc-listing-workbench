import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import type {DatabaseSync} from 'node:sqlite';
import {fixture,storage} from './fixtures/ai-control.ts';
import {slowHttp} from './fixtures/stabilization/slow-http.ts';
import {AmazonService} from '../src/main/amazon/service.ts';
import {AiService} from '../src/main/ai/service.ts';
import {WorkspaceStore} from '../src/main/store.ts';
import {classifyProduct} from '../src/main/catalog/classification.ts';
import {categoryExpansionPort} from '../src/main/catalog/category-expansion.ts';
import {taskAiContext} from '../src/main/ai/batch/task-context.ts';
import {readCategoryOperation} from '../src/main/ai/category-operations.ts';
import {createWorkspaceBackup,prepareWorkspaceRestore,commitWorkspaceRestore} from '../src/main/backup.ts';
const local=[{name:'CLEANING_CLOTH',displayName:'Cleaning cloth'}],novel={name:'PLATFORM_SPECIALTY',displayName:'Actual platform label'};
const credentials={name:'S04 synthetic',sellerId:'S04_SELLER',marketplaceId:'ATVPDKIKX0DER',region:'na',locale:'en_US',clientId:'s04-client',clientSecret:'s04-client-secret',refreshToken:'s04-refresh'};
async function setup(t:test.TestContext,mode:'valid'|'empty'|'second-none'|'500'|'half'|'echo'|'echo-escaped'|'invalid'='valid'){
 const keywords=await slowHttp({body:JSON.stringify({id:'s04-keyword',choices:[{finish_reason:'stop',message:{content:JSON.stringify({kind:'category-decision',phase:'keywords',keywords:['cloth'],productType:null,reason:'Source cloth.',ambiguous:false})}}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5,cost:.001}})});t.after(()=>keywords.close());
 const none=await slowHttp({body:JSON.stringify({id:'s04-none',answers:{category:{type:'choice',choice:'$NO_SUITABLE'},review:{type:'choice',choice:'clear'}},usage:{input_tokens:2,output_tokens:3,cost:.002}})});t.after(()=>none.close());
 const selected=await slowHttp({body:JSON.stringify({id:'s04-expanded',answers:{category:{type:'choice',choice:mode==='second-none'?'$NO_SUITABLE':novel.name},review:{type:'choice',choice:'clear'}},usage:{input_tokens:2,output_tokens:3,cost:.003}})});t.after(()=>selected.close());
 const f=await fixture(t,{fetch:async(_url,init)=>{const body=JSON.parse(String(init?.body)),payload=Array.isArray(body.state)?body.state[0]:body.state;return fetch(!body.questions?keywords.url:payload.candidates.some((c:{name:string})=>c.name===novel.name)?selected.url:none.url,init);}});
 f.service.saveConnection({id:'openrouter',apiKey:'s04-protocol-local-only'});f.service.setEnabled({id:'openrouter',enabled:true});f.service.setEnabled({id:'openrouter-review',enabled:true});
 const raw=mode==='invalid'?'{bad json':mode==='echo-escaped'?'{"productTypes":[],"echo":"\\u007304-access-token"}':mode==='500'?'{"errors":[{"code":"SyntheticUnavailable"}]}':mode==='echo'?'{"productTypes":[],"echo":"s04-access-token"}':`{ "productTypes" : ${JSON.stringify(mode==='empty'?[]:[novel])} }`;
 let getCount=0,lwa=0,deny=false,denyAfterLwa=false;const seen:{url:string;method:string}[]=[];
 const server=createServer((request,response)=>{
  if(request.url==='/auth'){
   assert.equal(request.method,'POST');lwa++;let body='';request.on('data',c=>body+=c);request.on('end',()=>{const form=new URLSearchParams(body);assert.equal(form.get('grant_type'),'refresh_token');assert.equal(form.get('refresh_token'),credentials.refreshToken);assert.equal(form.get('client_id'),credentials.clientId);response.end(JSON.stringify({access_token:'s04-access-token',token_type:'bearer',expires_in:3600}));});return;
  }
  assert.equal(request.method,'GET');const url=new URL(request.url!,'http://127.0.0.1');assert.equal(url.pathname,'/definitions/2020-09-01/productTypes');assert.equal(url.searchParams.get('marketplaceIds'),credentials.marketplaceId);assert.equal(url.searchParams.get('keywords'),'cloth');assert.equal(url.searchParams.get('locale'),'en_US');assert.equal(url.searchParams.get('searchLocale'),'en_US');assert.equal([...url.searchParams].length,4);assert.equal(request.headers['x-amz-access-token'],'s04-access-token');assert.match(String(request.headers['x-amz-date']),/^\d{8}T\d{6}Z$/);getCount++;
  response.writeHead(mode==='500'?500:200,{'content-type':'application/json','x-amzn-requestid':'s04-original-platform','connection':'close'});if(mode==='half'){response.write('{"productTypes":[');setImmediate(()=>response.destroy());}else response.end(raw);
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));const address=server.address();assert.ok(address&&typeof address==='object');
 const fetcher:typeof fetch=async(url,init)=>{const original=new URL(String(url));seen.push({url:original.href,method:String(init?.method)});assert.ok(['api.amazon.com','sellingpartnerapi-na.amazon.com'].includes(original.hostname));const response=await fetch(`http://127.0.0.1:${address.port}${original.hostname==='api.amazon.com'?'/auth':original.pathname+original.search}`,init);if(denyAfterLwa&&original.hostname==='api.amazon.com')deny=true;return response;};
 let store=f.store,ai=f.service,amazon=new AmazonService(f.directory,id=>store.getProductSnapshot(id),storage,{fetch:fetcher,sleep:async()=>{},timeoutMs:2000,beforeEffect:()=>{if(deny)throw Error('Synthetic scope revoked before LWA/GET');},preserveHistoricalRecords:true});
 const target=await amazon.importCredentials(credentials),input={productId:f.product.id,productRevision:f.product.revision,targetId:target.id},scope={taskId:randomUUID(),rowKey:f.product.id+':'+f.product.variants[0].id,phase:'CATEGORY',mode:'immediate' as const,authorize:()=>true};
 const deps=()=>({keywords:(value:typeof input)=>ai.decideCategory({...value,phase:'keywords' as const,candidates:[]}),localCandidates:()=>local,search:()=>local,fallback:async()=>{throw Error('unexpected first fallback');},choose:(value:typeof input&{candidates:typeof local;keywords:string[];expansion?:0|1},phase:'select'|'judge')=>ai.decideCategory({...value,phase}),expansion:categoryExpansionPort(input,ai,amazon,()=>{})});
 const run=()=>taskAiContext.run(scope,()=>classifyProduct(input,deps()));
 let closed=false;const close=async()=>{if(closed)return;closed=true;amazon.close();await ai.close();if(store!==f.store)store.close();};t.after(close);
 return {f,raw,input,scope,run,get ai(){return ai;},get amazon(){return amazon;},get db(){return (ai as unknown as {db:DatabaseSync}).db;},counts:()=>({get:getCount,lwa,keywords:keywords.posts,none:none.posts,selected:selected.posts}),seen,revoke:()=>{deny=true;},revokeAfterLwa:()=>{denyAfterLwa=true;},async reopen(restore?:{file:string;password:string},allowNewExpanded=false){amazon.close();await ai.close();if(restore){await f.hosting.close();f.closeStore();await commitWorkspaceRestore(f.directory,await prepareWorkspaceRestore(f.directory,restore.file,restore.password));store=new WorkspaceStore(f.directory);}ai=new AiService(f.directory,store,f.hosting,storage,{fetch:async(_url,init)=>{if(!allowNewExpanded)throw Error('No new AI expected after restart');const body=JSON.parse(String(init?.body)),payload=Array.isArray(body.state)?body.state[0]:body.state;assert.ok(payload.candidates.some((c:{name:string})=>c.name===novel.name));return fetch(selected.url,init);}});if(allowNewExpanded){ai.saveConnection({id:'openrouter',apiKey:'s04-protocol-local-only'});ai.setEnabled({id:'openrouter',enabled:true});ai.setEnabled({id:'openrouter-review',enabled:true});}amazon=new AmazonService(f.directory,id=>store.getProductSnapshot(id),storage,{fetch:async()=>{throw Error('No LWA/GET expected after restart');},preserveHistoricalRecords:true});},close};
}
for(const recovery of ['repeat','restart','old-backup','link-gap','link-gap-old-backup'] as const)test(`actual Amazon once lookup ${recovery} preserves original bytes and never repeats LWA/GET`,async t=>{
 const s=await setup(t),file=join(s.f.directory,'before-lookup.htcbackup'),password='s04 synthetic lookup backup';try{
 if(recovery.endsWith('old-backup'))await createWorkspaceBackup(s.f.directory,file,password);
 if(recovery.startsWith('link-gap'))s.db.exec("CREATE TEMP TRIGGER fail_s04_snapshot BEFORE UPDATE ON ai_category_operations WHEN json_extract(NEW.record_json,'$.expansion.snapshot') IS NOT NULL BEGIN SELECT RAISE(FAIL,'synthetic snapshot link failed'); END");
 if(recovery.startsWith('link-gap')){await assert.rejects(s.run(),/synthetic snapshot link/);s.db.exec('DROP TRIGGER fail_s04_snapshot');assert.equal(readCategoryOperation(s.db,s.input.productId).expansion!.snapshot,null);}else assert.equal((await s.run()).productType,novel.name);
 const operation=readCategoryOperation(s.db,s.input.productId),path=join(s.f.directory,'ai-receipts/category-expansions',operation.expansion!.requestId+'.json'),rawFile=await readFile(path),record=JSON.parse(rawFile.toString());assert.equal(record.receiptSha256,createHash('sha256').update(s.raw).digest('hex'));assert.equal(Buffer.from(record.base64,'base64').toString(),s.raw);assert.equal(record.remoteRequestId,'s04-original-platform');assert.equal(record.targetScope.sellerId,credentials.sellerId);
 if(recovery==='restart'||recovery.endsWith('old-backup'))await s.reopen(recovery.endsWith('old-backup')?{file,password}:undefined,recovery==='link-gap-old-backup');
 assert.equal((await s.run()).productType,novel.name);assert.deepEqual(await readFile(path),rawFile);assert.deepEqual(s.counts(),{get:1,lwa:1,keywords:1,none:1,selected:1});assert.equal(s.ai.listCalls().length,3);assert.equal(s.ai.getUsageSummary('openrouter').reportedTokens,15);
 }finally{await s.close();}
});
for(const mode of ['empty','second-none','500','half','echo','echo-escaped','invalid'] as const)test(`actual observed lookup ${mode} stops honestly with one GET`,async t=>{
 const s=await setup(t,mode);try{await assert.rejects(s.run());const operation=readCategoryOperation(s.db,s.input.productId),requestId=operation.expansion!.requestId;
 await assert.rejects(s.run(),error=>mode==='half'||mode.startsWith('echo')?!!error&&typeof error==='object'&&(error as {requestId?:string}).requestId===requestId&&(error as {certainty?:string}).certainty==='SENT_UNKNOWN':true);
 assert.equal(s.counts().get,1);assert.equal(s.counts().lwa,1);assert.equal(s.counts().selected,mode==='second-none'?1:0);
 if(mode==='500'){await assert.rejects(s.run(),(error:any)=>error.certainty==='DEFINITIVE_REJECTION');assert.equal(operation.expansion!.snapshot,null);}
 }finally{await s.close();}
});
test('actual scope refusal before LWA leaves the expansion permit unused',async t=>{
 const s=await setup(t);try{s.revoke();await assert.rejects(s.run());assert.equal(s.counts().get,0);assert.equal(s.counts().lwa,0);assert.equal(readCategoryOperation(s.db,s.input.productId).expansion!.permittedAt,null);}finally{await s.close();}
});
test('actual scope revocation while LWA is awaiting refuses GET before consuming its permit',async t=>{
 const s=await setup(t);try{s.revokeAfterLwa();await assert.rejects(s.run());assert.equal(s.counts().get,0);assert.equal(s.counts().lwa,1);assert.equal(readCategoryOperation(s.db,s.input.productId).expansion!.permittedAt,null);}finally{await s.close();}
});
