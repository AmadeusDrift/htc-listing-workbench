import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {randomUUID,createHash} from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { openDatabase } from '../src/main/database.ts';
import { ImageGenerationService } from '../src/main/image-generation/service.ts';
import { DEFAULT_OPENROUTER_IMAGE_MODEL as model } from '../src/shared/image-generation-contracts.ts';
import {AiSpendBudget} from '../src/main/ai/spend-budget.ts';
import {createWorkspaceBackup,prepareWorkspaceRestore,commitWorkspaceRestore} from '../src/main/backup.ts';
import {ControlledRunScopes,pauseControlledRunScopes} from '../src/main/application/controlled-run-scope.ts';
import {imageSpendBound,priceEvidence} from '../src/main/ai/spend-records.ts';
import {sanitizeFailureReason} from '../src/shared/automatic-resume.ts';

const png=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(13,8);png.write('IHDR',12);png.writeUInt32BE(256,16);png.writeUInt32BE(256,20);
const storage={isEncryptionAvailable:()=>true,encryptString:(value:string)=>Buffer.from(value),decryptString:(value:Buffer)=>value.toString()};
function concurrentFailure(error:any){return{name:String(error?.name??'UnknownError').slice(0,80),code:error?.code,reason:error?.diagnosticReason,certainty:error?.certainty,message:sanitizeFailureReason(String(error?.message??'')).replaceAll('s08-synthetic-key-only','[synthetic-key]'),stack:typeof error?.stack==='string'?error.stack.split(/\r?\n/).slice(1).filter((line:string)=>/^\s+at /.test(line)).slice(0,8).join('\n').replaceAll('s08-synthetic-key-only','[synthetic-key]'):null};}

async function fixture(t:test.TestContext,pricing:unknown[],limitUsdMicros:number|null,options:{cost?:number|null;disconnect?:boolean;body?:unknown;rawBody?:string;previewFailures?:number;onPriceRead?:()=>void}={}){
 await mkdir(resolve('.test-data'),{recursive:true});const directory=await mkdtemp(resolve('.test-data/s08-')),store=new WorkspaceStore(directory),product=store.createProduct(),db=openDatabase(directory);
 // RED uses the intended table/record on schema 33; the service currently ignores it.
 db.exec('CREATE TABLE IF NOT EXISTS ai_spend_policies(id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL)');
 db.prepare('INSERT INTO ai_spend_policies VALUES(?,?)').run('image-generation-daily',JSON.stringify({version:1,id:'image-generation-daily',period:'UTC_DAY',limitUsdMicros,updatedAt:new Date().toISOString()}));
 let posts=0;const bodies:string[]=[];const server=createServer((req,res)=>{const chunks:Buffer[]=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{res.setHeader('content-type','application/json');if(req.method==='GET'){options.onPriceRead?.();res.end(JSON.stringify({id:model,endpoints:[{provider_name:'Synthetic',provider_slug:'synthetic',pricing}]}));return;}posts++;bodies.push(Buffer.concat(chunks).toString());if(options.disconnect){req.socket.destroy();return;}res.end(options.rawBody??JSON.stringify(options.body??{id:'gen_s08_synthetic',data:[{b64_json:png.toString('base64')}],...(options.cost===null?{}:{usage:{cost:options.cost??.04}})}));});});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const port=(server.address() as {port:number}).port;
 const fetcher:typeof fetch=async(url,init)=>{const parsed=new URL(String(url));assert.equal(parsed.origin,'https://openrouter.ai');assert.ok(parsed.pathname==='/api/v1/images'||parsed.pathname===`/api/v1/images/models/${model}/endpoints`);return fetch(`http://127.0.0.1:${port}${parsed.pathname}`,init);};
 let failures=options.previewFailures??0;const service=new ImageGenerationService(directory,store,storage,{decodePreview:bytes=>{if(failures-->0)throw Error('synthetic preview failure');return bytes;},fetch:fetcher});
 service.saveConnection({model,enabled:true,apiKey:'s08-synthetic-key-only'});
 let closed=false;const closeLocal=()=>{if(!closed){db.close();store.close();closed=true;}};
 t.after(async()=>{await service.close();closeLocal();await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));t.diagnostic(JSON.stringify({providerPosts:posts}));await rm(directory,{recursive:true,force:true});});
 return{service,db,store,directory,fetcher,closeLocal,bodies,get posts(){return posts;},input:{productId:product.id,productRevision:product.revision,prompt:'Synthetic white background',referenceAssetIds:[],size:'auto',quality:'auto',background:'auto'}};
}

test('actual image service refuses a configured money budget without a reliable image-token upper bound before POST',async t=>{
 const f=await fixture(t,[{billable:'output_image',unit:'token',cost_usd:.00003}],1_000_000);
 await assert.rejects(f.service.generate(f.input),(e:any)=>e.diagnosticReason==='SPEND_BOUND_UNAVAILABLE');
 assert.equal(f.posts,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ai_image_requests').get()!.n,0);
});
test('actual image service refuses an exhausted money budget before reserving an intent or POST',async t=>{
 const f=await fixture(t,[{billable:'output_image',unit:'image',cost_usd:.04}],0);
 await assert.rejects(f.service.generate(f.input),(e:any)=>e.diagnosticReason==='SPEND_LIMIT_EXCEEDED'&&e.certainty==='NOT_SENT'&&e.notSent===true);
 assert.equal(f.posts,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ai_image_requests').get()!.n,0);
 const evidence=JSON.parse(String(f.db.prepare("SELECT detail_json FROM audit_events WHERE action='operation.failed' ORDER BY rowid DESC LIMIT 1").get()!.detail_json));assert.equal(evidence.certainty,'NOT_SENT');assert.equal(evidence.requestOutcome,'NOT_SENT');
});
for(const table of ['ai_spend_reservations','ai_image_requests'])test(`actual image beforeSend rolls back hold and intent together when ${table} owner fails`,async t=>{
 const f=await fixture(t,[{billable:'output_image',unit:'image',cost_usd:.04}],100_000);
 f.db.exec(`CREATE TRIGGER fail_s08 BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'synthetic owner failure');END;`);
 await assert.rejects(f.service.generate(f.input));assert.equal(f.posts,0);assert.equal(new AiSpendBudget(f.db).list().length,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ai_image_requests').get()!.n,0);f.db.exec('DROP TRIGGER fail_s08');
});
test('actual image UNKNOWN retains its original monetary hold through service restart and changed Key/model/input',async t=>{
 const f=await fixture(t,[{billable:'output_image',unit:'image',cost_usd:.04}],100_000,{disconnect:true});await assert.rejects(f.service.generate(f.input));assert.equal(f.posts,1);const first=new AiSpendBudget(f.db).list()[0];assert.equal(first.state,'UNKNOWN');assert.equal(first.bound!.upperUsdMicros,40_000);await f.service.close();
 const restarted=new ImageGenerationService(f.directory,f.store,storage,{decodePreview:bytes=>bytes,fetch:f.fetcher});try{restarted.saveConnection({model:'openai/gpt-image-2.5-flare',enabled:true,apiKey:'s08-different-synthetic-key'});await assert.rejects(restarted.generate({...f.input,prompt:'changed'}),(e:any)=>e.code==='INTERRUPTED'&&e.certainty==='SENT_UNKNOWN');assert.equal(f.posts,1);assert.deepEqual(new AiSpendBudget(f.db).list()[0],first);const evidence=JSON.parse(String(f.db.prepare("SELECT detail_json FROM audit_events WHERE action='operation.failed' ORDER BY rowid DESC LIMIT 1").get()!.detail_json));assert.equal(evidence.certainty,'SENT_UNKNOWN');assert.equal(evidence.requestOutcome,'RESULT_UNKNOWN');}finally{await restarted.close();}
});
test('actual fee below the upper reserve releases only the difference, while absent fee continues to hold',async t=>{
 const f=await fixture(t,[{billable:'output_image',unit:'image',cost_usd:.04}],50_000,{cost:.02});await f.service.generate(f.input);assert.equal(f.posts,1);const budget=new AiSpendBudget(f.db);assert.equal(budget.summary('image-generation-daily').reportedUsdMicros,20_000);assert.equal(budget.summary('image-generation-daily').heldUsdMicros,0);
 const next=f.store.createProduct();await assert.rejects(f.service.generate({...f.input,productId:next.id,productRevision:next.revision}),(e:any)=>e.diagnosticReason==='SPEND_LIMIT_EXCEEDED');assert.equal(f.posts,1);
});
test('actual reported fee over the frozen upper is retained and blocks subsequent new image requests',async t=>{
 const f=await fixture(t,[{billable:'output_image',unit:'image',cost_usd:.04}],1_000_000,{cost:.08});await assert.rejects(f.service.generate(f.input),(e:any)=>e.diagnosticReason==='SPEND_COST_ANOMALY');assert.equal(f.posts,1);const record=new AiSpendBudget(f.db).list()[0];assert.equal(record.state,'COST_ANOMALY');assert.equal(record.actualUsdMicros,80_000);assert.equal(record.receiptIds.length,1);
 const next=f.store.createProduct();await assert.rejects(f.service.generate({...f.input,productId:next.id,productRevision:next.revision}),(e:any)=>e.diagnosticReason==='SPEND_COST_ANOMALY');assert.equal(f.posts,1);
});
test('ordinary explicitly unlimited image use stays unbounded and does not claim a missing fee is zero',async t=>{
 const f=await fixture(t,[{billable:'output_image',unit:'token',cost_usd:.00003}],null,{cost:null});await f.service.generate(f.input);assert.equal(f.posts,1);const summary=new AiSpendBudget(f.db).summary('image-generation-daily');assert.equal(summary.limitUsdMicros,null);assert.equal(summary.unboundedCalls,1);assert.equal(summary.reportedUsdMicros,0);assert.equal(new AiSpendBudget(f.db).list()[0].actualUsdMicros,null);
 const tomorrow=new Date(Date.parse(new AiSpendBudget(f.db).list()[0].createdAt)+86400_000);assert.equal(new AiSpendBudget(f.db,()=>tomorrow).summary('image-generation-daily').unboundedCalls,1);
});
test('actual old backup prepare and commit keep a later image intent and monetary UNKNOWN without another POST',async t=>{
 const f=await fixture(t,[{billable:'output_image',unit:'image',cost_usd:.04}],100_000,{disconnect:true}),backup=resolve(f.directory,'before-image.htcbackup');await createWorkspaceBackup(f.directory,backup,'s08-synthetic-backup-only');await assert.rejects(f.service.generate(f.input));assert.equal(f.posts,1);const original=new AiSpendBudget(f.db).list()[0],intent=f.db.prepare('SELECT record_json FROM ai_image_requests WHERE id=?').get(original.id)!.record_json;
 const prepared=await prepareWorkspaceRestore(f.directory,backup,'s08-synthetic-backup-only'),staged=openDatabase(prepared.stagingDirectory);try{assert.deepEqual(new AiSpendBudget(staged).list()[0],original);}finally{staged.close();}await f.service.close();f.closeLocal();await commitWorkspaceRestore(f.directory,prepared);
 const store=new WorkspaceStore(f.directory),db=openDatabase(f.directory),service=new ImageGenerationService(f.directory,store,storage,{decodePreview:bytes=>bytes,fetch:f.fetcher});try{service.saveConnection({model,enabled:true,apiKey:'s08-post-restore-synthetic-key'});await assert.rejects(service.generate(f.input),(e:any)=>e.code==='INTERRUPTED');assert.equal(f.posts,1);assert.equal(db.prepare('SELECT record_json FROM ai_image_requests WHERE id=?').get(original.id)!.record_json,intent);assert.deepEqual(new AiSpendBudget(db).list()[0],original);}finally{await service.close();db.close();store.close();}
});
test('two actual image services share the SQLite money lock instead of spending the same remaining amount twice',async t=>{
 const f=await fixture(t,[{billable:'output_image',unit:'image',cost_usd:.04}],50_000),second=f.store.createProduct(),other=new ImageGenerationService(f.directory,f.store,storage,{decodePreview:bytes=>bytes,fetch:f.fetcher});
 try{const results=await Promise.allSettled([f.service.generate(f.input),other.generate({...f.input,productId:second.id,productRevision:second.revision})]);t.diagnostic(JSON.stringify(results.map(r=>r.status==='fulfilled'?{status:r.status}:{status:r.status,...concurrentFailure(r.reason)})));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected'&&(r.reason as any).diagnosticReason==='SPEND_LIMIT_EXCEEDED').length,1);assert.equal(f.posts,1);assert.equal(new AiSpendBudget(f.db).list().length,1);assert.equal(f.db.prepare('SELECT count(*) n FROM ai_image_requests').get()!.n,1);}finally{await other.close();}
});
for(const cost of [0,.01])test(`actual processing-error receipt with reported cost ${cost} retains the remaining upper liability`,async t=>{
 const f=await fixture(t,[{billable:'output_image',unit:'image',cost_usd:.04}],100_000,{body:{id:'gen_s08_pending',error:{code:502,message:'Synthetic upstream processing failure'},usage:{cost}}});await assert.rejects(f.service.generate(f.input));assert.equal(f.posts,1);const budget=new AiSpendBudget(f.db),record=budget.list()[0],summary=budget.summary('image-generation-daily');assert.equal(record.state,'UNKNOWN');assert.equal(record.actualUsdMicros,cost*1_000_000);assert.equal(summary.reportedUsdMicros,cost*1_000_000);assert.equal(summary.heldUsdMicros,40_000-cost*1_000_000);await assert.rejects(f.service.generate(f.input));assert.equal(f.posts,1);
});
test('saved canonical raw image recovers a failed local candidate save without another charge or POST',async t=>{
 const f=await fixture(t,[{billable:'output_image',unit:'image',cost_usd:.04}],100_000,{cost:.02,previewFailures:1});await assert.rejects(f.service.generate(f.input),(e:any)=>e.code==='OUTPUT_INVALID');const budget=new AiSpendBudget(f.db),original=budget.list()[0];assert.equal(original.state,'SETTLED');const candidate=await f.service.generate(f.input);assert.equal(candidate.id,original.id);assert.equal(f.posts,1);assert.deepEqual(budget.list()[0],original);assert.equal(budget.summary('image-generation-daily').reportedUsdMicros,20_000);
});
test('canonical raw recovery repairs a missing SQLite receipt index through the original owner without charging again',async t=>{
 const f=await fixture(t,[{billable:'output_image',unit:'image',cost_usd:.04}],100_000,{cost:.02,previewFailures:1});await assert.rejects(f.service.generate(f.input),(e:any)=>e.code==='OUTPUT_INVALID');const budget=new AiSpendBudget(f.db),original=budget.list()[0];f.db.prepare('DELETE FROM ai_provider_receipts WHERE id=?').run(original.receiptIds[0]);const recovered=await f.service.generate(f.input);assert.equal(recovered.id,original.id);assert.equal(f.posts,1);assert.deepEqual(budget.list()[0],original);assert.equal(f.db.prepare('SELECT count(*) n FROM ai_provider_receipts WHERE id=?').get(original.receiptIds[0])!.n,1);
});
test('received invalid complete image result with a known fee consumes its original budget instead of becoming free or UNKNOWN',async t=>{
 const f=await fixture(t,[{billable:'output_image',unit:'image',cost_usd:.04}],50_000,{body:{id:'gen_s08_invalid',data:[],usage:{cost:.02}}});await assert.rejects(f.service.generate(f.input),(e:any)=>e.code==='OUTPUT_INVALID'&&e.certainty==='RECEIVED_INVALID');const record=new AiSpendBudget(f.db).list()[0];assert.equal(record.state,'SETTLED');assert.equal(record.actualUsdMicros,20_000);assert.equal(record.receiptProofs[0].certainty,'RECEIVED_INVALID');await assert.rejects(f.service.generate(f.input),(e:any)=>e.diagnosticReason==='SPEND_LIMIT_EXCEEDED');assert.equal(f.posts,1);
});

for(const invalid of [true,false])test(`original image raw ${invalid?'invalid result':'processing result'} recovers its certainty locally without Key or another fee`,async t=>{
 const f=await fixture(t,[{billable:'output_image',unit:'image',cost_usd:.04}],50_000,{body:invalid?{id:'s08_original_invalid',data:[],usage:{cost:.02}}:{id:'s08_original_processing',error:{code:502,message:'Synthetic processing failure'},usage:{cost:0}}});await assert.rejects(f.service.generate(f.input));const budget=new AiSpendBudget(f.db),record=budget.list()[0],intent=String(f.db.prepare('SELECT record_json FROM ai_image_requests WHERE id=?').get(record.id)!.record_json),receipts=f.db.prepare('SELECT record_json FROM ai_provider_receipts').all();f.service.disconnect();
 await assert.rejects(f.service.reconcileWorkflowGeneration(record.id),(e:any)=>e.certainty===(invalid?'RECEIVED_INVALID':'SENT_UNKNOWN'));assert.equal(f.posts,1);assert.equal(f.service.getConnection().configured,false);assert.deepEqual(budget.list()[0],record);assert.equal(String(f.db.prepare('SELECT record_json FROM ai_image_requests WHERE id=?').get(record.id)!.record_json),intent);assert.deepEqual(f.db.prepare('SELECT record_json FROM ai_provider_receipts').all(),receipts);assert.equal(record.state,invalid?'SETTLED':'UNKNOWN');assert.equal(budget.summary('image-generation-daily').heldUsdMicros,invalid?0:40_000);
});

test('an original raw with a mismatched receipt model cannot gain received certainty from the pure decoder',async t=>{
 const f=await fixture(t,[{billable:'output_image',unit:'image',cost_usd:.04}],50_000,{body:{id:'s08_original_bad_binding',data:[],usage:{cost:.02}}});await assert.rejects(f.service.generate(f.input));const budget=new AiSpendBudget(f.db),original=budget.list()[0],row=f.db.prepare('SELECT id,record_json FROM ai_provider_receipts').get()!,metadata=String(row.record_json);f.service.disconnect();f.db.prepare('UPDATE ai_provider_receipts SET record_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(metadata),model:'wrong-model'}),row.id);
 try{await assert.rejects(f.service.reconcileWorkflowGeneration(original.id),(e:any)=>e.certainty!=='RECEIVED_INVALID');assert.equal(f.posts,1);assert.deepEqual(budget.list()[0],original);}finally{f.db.prepare('UPDATE ai_provider_receipts SET record_json=? WHERE id=?').run(metadata,row.id);}await assert.rejects(f.service.reconcileWorkflowGeneration(original.id),(e:any)=>e.certainty==='RECEIVED_INVALID');assert.equal(f.posts,1);assert.deepEqual(budget.list()[0],original);
});
for(const invalid of ['missing-scope','seller','site','sku','family','missing-authority','unbounded-model'] as const)test(`actual image controlled ${invalid} cannot fall back to ordinary unlimited dispatch`,async t=>{
 const f=await fixture(t,[{billable:'output_image',unit:'token',cost_usd:.00003}],null),product=f.store.getProduct(f.input.productId),variantId=product.variants[0].id,taskId=randomUUID(),draftId=randomUUID(),owner={draftId,sku:'S08-CONTROLLED',targetId:'s08-target',marketplaceId:'US',variantIds:[variantId],slot:1};
 const task={id:taskId,revision:1,status:'RUNNING',targetId:owner.targetId,sellerId:'s08-seller',marketplaceId:'US',mode:'live',items:[{key:`${product.id}:${variantId}`,sku:owner.sku,productId:product.id,variantId}]},draft={id:draftId,productId:product.id,productRevision:product.revision,variantId,sku:owner.sku,targetId:owner.targetId,sellerId:task.sellerId,marketplaceId:'US',mode:'live',schema:{parentageLevel:'NONE'}};
 f.db.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(taskId,JSON.stringify(task));f.db.prepare('INSERT INTO listing_drafts(id,product_id,request_json,schema_checksum,validation_json,state,created_at,record_json) VALUES(?,?,?,?,?,?,?,?)').run(draftId,product.id,'{}','synthetic','{}','DRAFT',new Date().toISOString(),JSON.stringify({draft}));
 const scopes=new ControlledRunScopes(f.db),scope=scopes.register({taskId,expectedTaskRevision:1,targetId:owner.targetId,sellerId:task.sellerId,marketplaceId:'US',items:[{itemKey:task.items[0].key,sku:owner.sku,productId:product.id,variantIds:[variantId],recipeKey:null,parentage:'NONE'}]}),run=scopes.activate(scope.id);
 if(invalid==='missing-scope')f.db.prepare('DELETE FROM controlled_run_scopes WHERE id=?').run(scope.id);
 if(invalid==='seller')draft.sellerId='wrong-seller';if(invalid==='site'){draft.marketplaceId='JP';owner.marketplaceId='JP';}if(invalid==='sku'){draft.sku='WRONG-SKU';owner.sku='WRONG-SKU';}if(invalid==='family')draft.schema.parentageLevel='CHILD';
 f.db.prepare('UPDATE listing_drafts SET record_json=? WHERE id=?').run(JSON.stringify({draft}),draftId);
 const invoke=()=>f.service.generateForWorkflow(f.input,{requestId:randomUUID(),owner});await assert.rejects(invalid==='missing-authority'?invoke():run(invoke),(e:any)=>e.diagnosticReason===(invalid==='unbounded-model'?'SPEND_BOUND_UNAVAILABLE':'CONTROLLED_RUN_SCOPE_BLOCKED'));assert.equal(f.posts,0);assert.equal(new AiSpendBudget(f.db).list().length,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ai_image_requests').get()!.n,0);
});
test('an actual prior-day UNKNOWN retains reported plus remaining upper exposure in the next UTC daily budget',async t=>{
 const f=await fixture(t,[{billable:'output_image',unit:'image',cost_usd:.04}],50_000,{body:{id:'gen_s08_prior_day',error:{code:502,message:'Synthetic processing failure'},usage:{cost:.01}}});await assert.rejects(f.service.generate(f.input));const original=new AiSpendBudget(f.db).list()[0],tomorrow=new Date(Date.parse(original.createdAt)+86400_000),next=new AiSpendBudget(f.db,()=>tomorrow),summary=next.summary('image-generation-daily');assert.equal(summary.reportedUsdMicros,10_000);assert.equal(summary.heldUsdMicros,30_000);
 const body=f.bodies[0],bound=imageSpendBound(body,priceEvidence(model,original.bound!.evidence.body,tomorrow),tomorrow.toISOString())!,hash=(s:string)=>createHash('sha256').update(s).digest('hex');await assert.rejects(async()=>{const {transaction}=await import('../src/main/application/transaction.ts');transaction(f.db,()=>next.reserveInTransaction(f.db,{id:randomUUID(),businessKey:hash(randomUUID()),requestSha256:hash(body),model,purpose:'image_generation',scopeId:null},body,bound));},(e:any)=>e.diagnosticReason==='SPEND_LIMIT_EXCEEDED');assert.equal(f.posts,1);assert.equal(next.list().length,1);
});
for(const corrupt of ['forged-result-proof','duplicate-record-key'] as const)test(`actual backup rejects ${corrupt} instead of releasing the original unknown liability`,async t=>{
 const f=await fixture(t,[{billable:'output_image',unit:'image',cost_usd:.04}],100_000,{body:{id:'gen_s08_corrupt_proof',error:{code:502,message:'Synthetic processing failure'},usage:{cost:0}}});await assert.rejects(f.service.generate(f.input));const record=new AiSpendBudget(f.db).list()[0],original=String(f.db.prepare('SELECT record_json FROM ai_spend_reservations WHERE id=?').get(record.id)!.record_json);
 const forged=corrupt==='duplicate-record-key'?original.slice(0,-1)+',"version":1}':JSON.stringify({...record,state:'SETTLED',receiptProofs:record.receiptProofs.map(p=>({...p,certainty:'RECEIVED_VALID'}))});f.db.prepare('UPDATE ai_spend_reservations SET record_json=? WHERE id=?').run(forged,record.id);
 await assert.rejects(createWorkspaceBackup(f.directory,resolve(f.directory,'corrupt.htcbackup'),'s08-synthetic-corrupt-backup'));assert.equal(f.posts,1);assert.equal(f.db.prepare('SELECT record_json FROM ai_spend_reservations WHERE id=?').get(record.id)!.record_json,forged);f.db.prepare('UPDATE ai_spend_reservations SET record_json=? WHERE id=?').run(original,record.id);
});

function controlledImage(f:Awaited<ReturnType<typeof fixture>>,recipeKey:string|null){
 const product=f.store.getProduct(f.input.productId),variantId=product.variants[0].id,taskId=randomUUID(),draftId=randomUUID(),sku='S08-REVIEW',key=product.id+':'+variantId,recipe=recipeKey===null?undefined:{key:recipeKey,components:[{variantId,quantity:1}]};
 const task={id:taskId,revision:1,status:'RUNNING',targetId:'s08-target',sellerId:'s08-seller',marketplaceId:'US',mode:'live',items:[{key,sku,productId:product.id,variantId,...(recipe?{salesPlan:{parentage:'NONE',recipe}}:{})}]},draft={id:draftId,productId:product.id,productRevision:product.revision,variantId,sku,targetId:task.targetId,sellerId:task.sellerId,marketplaceId:'US',mode:'live',schema:{parentageLevel:'NONE'},...(recipe?{salesPlan:{parentage:'NONE',recipe}}:{})};
 f.db.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(taskId,JSON.stringify(task));f.db.prepare('INSERT INTO listing_drafts(id,product_id,request_json,schema_checksum,validation_json,state,created_at,record_json) VALUES(?,?,?,?,?,?,?,?)').run(draftId,product.id,'{}','synthetic','{}','DRAFT',new Date().toISOString(),JSON.stringify({draft}));
 const scopes=new ControlledRunScopes(f.db),scope=scopes.register({taskId,expectedTaskRevision:1,targetId:task.targetId,sellerId:task.sellerId,marketplaceId:'US',items:[{itemKey:key,sku,productId:product.id,variantIds:[variantId],recipeKey,parentage:'NONE'}]}),run=scopes.activate(scope.id),owner={draftId,sku,targetId:task.targetId,marketplaceId:'US',variantIds:[variantId],slot:1};
 return{scope,run,owner,changeRecipe(){f.db.prepare('UPDATE listing_drafts SET record_json=? WHERE id=?').run(JSON.stringify({draft:{...draft,salesPlan:{parentage:'NONE',recipe:{key:'changed-five-units',components:[{variantId,quantity:5}]}}}}),draftId);}};
}

for(const change of ['matching','before-generation','during-pricing'] as const)test(`actual controlled image checks its registered draft recipe ${change}`,async t=>{
 let onPriceRead=()=>{};const f=await fixture(t,[{billable:'output_image',unit:'image',cost_usd:.04}],null,{onPriceRead:()=>onPriceRead()}),c=controlledImage(f,'original-one-unit');if(change==='before-generation')c.changeRecipe();if(change==='during-pricing')onPriceRead=()=>c.changeRecipe();
 const invoke=()=>c.run(()=>f.service.generateForWorkflow(f.input,{requestId:randomUUID(),owner:c.owner}));if(change==='matching')await invoke();else await assert.rejects(invoke(),(e:any)=>e.diagnosticReason==='CONTROLLED_RUN_SCOPE_BLOCKED');
 assert.equal(f.posts,change==='matching'?1:0);assert.equal(new AiSpendBudget(f.db).list().length,change==='matching'?1:0);assert.equal(f.db.prepare('SELECT count(*) n FROM ai_image_requests').get()!.n,change==='matching'?1:0);
});

for(const limit of [null,1_000_000])test(`actual controlled cost anomaly preserves its lock and isolates ordinary daily policy ${limit}`,async t=>{
 const f=await fixture(t,[{billable:'output_image',unit:'image',cost_usd:.04}],limit,{cost:.08}),c=controlledImage(f,null),budget=new AiSpendBudget(f.db);await assert.rejects(c.run(()=>f.service.generateForWorkflow(f.input,{requestId:randomUUID(),owner:c.owner})),(e:any)=>e.diagnosticReason==='SPEND_COST_ANOMALY');
 const original=budget.list()[0];assert.equal(original.state,'COST_ANOMALY');assert.equal(original.actualUsdMicros,80_000);assert.equal(original.receiptIds.length,1);assert.equal(budget.summary('controlled-live-lifetime').anomaly,true);
 const body=f.bodies[0],hash=(s:string)=>createHash('sha256').update(s).digest('hex'),{transaction}=await import('../src/main/application/transaction.ts');assert.throws(()=>transaction(f.db,()=>budget.reserveInTransaction(f.db,{id:randomUUID(),businessKey:hash('next-controlled'),requestSha256:hash(body),model,purpose:'image_generation',scopeId:c.scope.id},body,original.bound)),(e:any)=>e.diagnosticReason==='SPEND_COST_ANOMALY');
 const next=f.store.createProduct(),ordinary=()=>f.service.generate({...f.input,productId:next.id,productRevision:next.revision});if(limit===null)await ordinary();else await assert.rejects(ordinary(),(e:any)=>e.diagnosticReason==='SPEND_COST_ANOMALY');assert.equal(f.posts,limit===null?2:1);assert.equal(budget.list().length,limit===null?2:1);assert.deepEqual(budget.list().find(r=>r.id===original.id),original);assert.equal(budget.summary('image-generation-daily').anomaly,true);
});

test('actual image quote cannot dispatch when the same-revision controlled authority is revoked during pricing',async t=>{
 let revoke=()=>{};const f=await fixture(t,[{billable:'output_image',unit:'image',cost_usd:.04}],null,{onPriceRead:()=>revoke()}),c=controlledImage(f,null);revoke=()=>pauseControlledRunScopes(f.db);
 await assert.rejects(c.run(()=>f.service.generateForWorkflow(f.input,{requestId:randomUUID(),owner:c.owner})),(e:any)=>e.diagnosticReason==='CONTROLLED_RUN_SCOPE_BLOCKED');assert.equal(f.posts,0);assert.equal(new AiSpendBudget(f.db).list().length,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ai_image_requests').get()!.n,0);assert.equal(f.db.prepare("SELECT json_extract(record_json,'$.revision') revision FROM automatic_listing_tasks").get()!.revision,1);
});


test('received valid image with cost anomaly keeps its fee lock without reporting result unknown',async t=>{
 const f=await fixture(t,[{billable:'output_image',unit:'image',cost_usd:.04}],100_000,{cost:.08});
 const error=await f.service.generate(f.input).catch(error=>error);assert.equal(error.diagnosticReason,'SPEND_COST_ANOMALY');assert.equal(error.certainty,'RECEIVED_VALID');
 const spend=new AiSpendBudget(f.db).list()[0];assert.equal(spend.state,'COST_ANOMALY');assert.equal(spend.actualUsdMicros,80_000);assert.equal(f.posts,1);
 const failure=f.db.prepare("SELECT detail_json FROM audit_events WHERE action='operation.failed' ORDER BY rowid DESC LIMIT 1").get()!,evidence=JSON.parse(String(failure.detail_json));
 t.diagnostic(JSON.stringify({certainty:evidence.certainty,requestOutcome:evidence.requestOutcome,spendState:spend.state,posts:f.posts}));
 assert.equal(evidence.certainty,'RECEIVED_VALID');assert.notEqual(evidence.requestOutcome,'RESULT_UNKNOWN');
 const before=JSON.stringify(spend);await assert.rejects(f.service.generate(f.input));assert.equal(f.posts,1);assert.equal(JSON.stringify(new AiSpendBudget(f.db).list()[0]),before);
});

for(const beforeSend of [false,true])test('image legacy diagnostic keeps '+(beforeSend?'NOT_SENT before budget rejection':'RESULT_UNKNOWN after transport interruption'),async t=>{
 const f=await fixture(t,[{billable:'output_image',unit:beforeSend?'token':'image',cost_usd:.04}],100_000,{disconnect:!beforeSend});await assert.rejects(f.service.generate(f.input));
 const row=f.db.prepare("SELECT detail_json FROM audit_events WHERE action='operation.failed' ORDER BY rowid DESC LIMIT 1").get()!,evidence=JSON.parse(String(row.detail_json));
 assert.equal(evidence.requestOutcome,beforeSend?'NOT_SENT':'RESULT_UNKNOWN');assert.equal(f.posts,beforeSend?0:1);if(!beforeSend)assert.equal(evidence.certainty,'SENT_UNKNOWN');
});


test('actual invalid image output classifies separately without inferring invalid from a generic code or losing another UNKNOWN',async t=>{
 const f=await fixture(t,[{billable:'output_image',unit:'image',cost_usd:.04}],100_000,{rawBody:''});
 const error=await f.service.generate(f.input).catch(error=>error);assert.equal(error.certainty,'RECEIVED_INVALID');
 const {AutomaticListingService}=await import('../src/main/automatic-listing/service.ts'),{validateAutomaticListingTask}=await import('../src/main/automatic-listing/records.ts'),{defaultListingRules}=await import('../src/shared/listing-rules.ts'),{DEFAULT_ITEM_LABEL_FORMAT}=await import('../src/shared/item-label-contracts.ts'),{AiError}=await import('../src/main/ai/errors.ts');
 const rules=defaultListingRules(),hash='a'.repeat(64),at=new Date().toISOString(),variantId=randomUUID(),taskId=randomUUID(),product=f.store.getProduct(f.input.productId);
 const row={key:product.id+':'+variantId,productId:product.id,productRevision:product.revision,sourceStamp:hash,productTitle:product.title,variantId,sku:'STATUS-SYNTHETIC',stockSets:5,sourcesPrepared:false,status:'FAILED',stage:'DRAFT',draftId:null,executionTaskIds:[],imageStarted:false,imageAttempts:0,repairAttempts:0,repair:null,batchId:null,error:'invalid output'};
 const task=validateAutomaticListingTask({id:taskId,revision:1,status:'PAUSED',targetId:'synthetic',targetName:'Synthetic',sellerId:'synthetic',marketplaceId:'US',mode:'demo',targetStamp:hash,profileId:'alpha',profileStamp:hash,rulesStamp:hash,ruleRevision:rules.revision,productType:'BOX',locale:'en_US',labelFormat:DEFAULT_ITEM_LABEL_FORMAT,items:[row],createdAt:at,updatedAt:at,error:null});
 const owner:any=new AutomaticListingService(f.directory,{store:f.store,rules:()=>rules,amazon:{},images:{getProgress:()=>null},execution:{list:()=>[]}} as any);try{
 const classified=structuredClone(task.items[0]);await owner.classifyFailure(task,classified,error);assert.ok(classified.outcome);assert.equal(classified.outcome.code,'AI_RECEIVED_INVALID_OUTPUT');assert.equal(classified.outcome.kind,'SYSTEM_REPAIR');assert.doesNotThrow(()=>validateAutomaticListingTask({...task,items:[classified]}));
 assert.throws(()=>validateAutomaticListingTask({...task,items:[{...classified,outcome:{...classified.outcome,kind:'NEEDS_INPUT'}}]}));
 for(const failure of [new AiError('OUTPUT_INVALID'),Object.assign(new AiError('OUTPUT_INVALID'),{certainty:'SENT_UNKNOWN'}),Object.assign(new AiError('QUOTA_EXCEEDED'),{certainty:'RECEIVED_VALID',diagnosticReason:'SPEND_COST_ANOMALY'})]){const next=structuredClone(task.items[0]);await owner.classifyFailure(task,next,failure);assert.ok(next.outcome);assert.notEqual(next.outcome.code,'AI_RECEIVED_INVALID_OUTPUT');}
 const unknown={...structuredClone(task.items[0]),imageStarted:true};await owner.classifyFailure(task,unknown,error);assert.ok(unknown.outcome);assert.equal(unknown.outcome.kind,'UNKNOWN');assert.equal(unknown.outcome.code,'IMAGE_RESULT_UNKNOWN');assert.equal(f.posts,1);assert.equal(new AiSpendBudget(f.db).list()[0].actualUsdMicros,null);assert.equal(new AiSpendBudget(f.db).list()[0].state,'UNKNOWN');
 }finally{await owner.close();}
});

test('P06 same generation service atomically admits only budgeted concurrent requests',async t=>{
 const f=await fixture(t,[{billable:'output_image',unit:'image',cost_usd:.04}],40_000),second=f.store.createProduct();
 const results=await Promise.allSettled([f.service.generate(f.input),f.service.generate({...f.input,productId:second.id,productRevision:second.revision})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.filter(r=>r.status==='rejected'&&(r.reason as any).diagnosticReason==='SPEND_LIMIT_EXCEEDED').length,1);
 assert.equal(f.posts,1);assert.equal(new AiSpendBudget(f.db).list().length,1);assert.equal(f.db.prepare('SELECT count(*) n FROM ai_image_requests').get()!.n,1);
});
