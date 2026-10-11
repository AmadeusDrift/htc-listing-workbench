import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, chat } from './fixtures/listing-ai.ts';
import { assertListingHistory } from '../src/main/listing-ai/history.ts';
import { nativeCandidateIssues,parseFullGeneration,changedBusinessLeaves,parseFullReview } from '../src/main/listing-ai/full-schema.ts';
import { listingFingerprint } from '../src/main/listing-ai/validation.ts';
import { realAmazonSchema } from './fixtures/amazon/schema-fixture.ts';
import { buildListingContext,listingModelPayload } from '../src/main/listing-ai/context.ts';
import { LegacyListingAiService } from './helpers/legacy-listing-context.ts';
import { createWorkspaceBackup,prepareWorkspaceRestore,commitWorkspaceRestore } from '../src/main/backup.ts';
import { openDatabase } from '../src/main/database.ts';
import { join } from 'node:path';
import { retainCompletionOperations,CompletionJournal } from '../src/main/listing-ai/completion-journal.ts';

test('full review preserves negative check feedback when issues are omitted without duplicating existing issues',()=>{
  const check={field:'novel_feature',index:0,verdict:'UNSUPPORTED',evidenceIds:[],reason:'Need the observed package count',claims:[]};
  const raw={kind:'amazon-fields-review',verdict:'NEEDS_CHANGES',checks:[check],issues:[]};
  assert.deepEqual(parseFullReview(raw).issues,[{field:'novel_feature',message:check.reason}]);
  assert.deepEqual(raw.issues,[]);
  const issues=[{field:check.field,message:check.reason}];
  assert.deepEqual(parseFullReview({...raw,issues}).issues,issues);
});

test('full review rejects unexplained negative conclusions and retains negative claim feedback',()=>{
  const check={field:'novel_feature',index:0,verdict:'SUPPORTED',evidenceIds:[],reason:'Supported',claims:[]};
  for(const verdict of ['NEEDS_CHANGES','BLOCKED'])assert.throws(()=>parseFullReview({kind:'amazon-fields-review',verdict,checks:[check],issues:[]}),(error:unknown)=>/矛盾/.test(String((error as {validationReason?:string}).validationReason)));
  const claim={text:'two units',verdict:'CONTRADICTED',evidenceIds:[],reason:'Image shows one unit'};
  assert.deepEqual(parseFullReview({kind:'amazon-fields-review',verdict:'BLOCKED',checks:[{...check,claims:[claim]}],issues:[]}).issues,[{field:check.field,message:claim.reason}]);
});

test('full schema production context adopts an unknown nested native attribute and survives image snapshot',async t=>{
  const shape={type:'array',minItems:2,items:{type:'object',properties:{value:{type:'number'},enabled:{type:'boolean'},details:{type:'object',properties:{label:{type:'string'}},required:['label']}},required:['value','enabled','details'],additionalProperties:false}};
  const f=await fixture(t,{novel_feature:shape});
  f.ai.saveFunctionSettings({id:'deepseek-review',model:'deepseek-v4-pro',enabled:false});
  const {ListingAiService}=await import('../src/main/listing-ai/service.ts');
  const listing=new ListingAiService(f.store,f.amazon,f.ai,()=>false);
  assert.equal((listing.currentContext(f.draft,f.product,0) as any).contract,'listing-full-schema/v1');
  const nativeValue=[{value:3,enabled:true,details:{label:'Blue'}},{value:4,enabled:false,details:{label:'Green'}}];
  f.respond(payload=>{
    assert.equal(payload.contract,'listing-full-schema/v1');
    assert.deepEqual(payload.fullSchema.schema.properties.novel_feature,shape);
    assert.ok(payload.fullSchema.metaSchema);
    assert.ok(payload.sourceProduct.selectedSku);
    return chat({kind:'amazon-fields',contract:'listing-full-schema/v1',candidates:[{field:'novel_feature',nativeValue,evidenceIds:[payload.evidence[0].id],transformation:'infer',inferenceReason:'Product context'}],missing:[]});
  });
  const suggestion=await listing.suggest(f.reference);
  const adopted=await listing.adopt({...f.reference,suggestionResultId:suggestion.id,reviewResultId:null,fields:['novel_feature']});
  assert.deepEqual(adopted.attributes.novel_feature,nativeValue);
  assert.doesNotThrow(()=>assertListingHistory(adopted,new Map(f.ai.listResults(f.product.id).map(r=>[r.id,r])),new Map(f.ai.listCalls().map(c=>[c.id,c]))));
  const {currentImageListingSnapshot}=await import('../src/main/image-workflow/image-facts.ts');
  assert.doesNotThrow(()=>currentImageListingSnapshot(adopted,listing.currentContext(adopted,f.product,0)));
  const backup=join(f.directory,'native.htcbackup'),restored=join(f.directory,'restored-native');
  await createWorkspaceBackup(f.directory,backup,'native full schema fixture password');
  await commitWorkspaceRestore(restored,await prepareWorkspaceRestore(restored,backup,'native full schema fixture password'));
  const db=openDatabase(restored);try{const saved=JSON.parse(String(db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(adopted.id)!.record_json));assert.deepEqual(saved.draft.attributes.novel_feature,nativeValue);}finally{db.close();}
});

test('the complete real 854KB Amazon schema and metaSchema reach field payload unchanged',async t=>{
  const f=await fixture(t),schema=realAmazonSchema(),context=buildListingContext({...f.draft,schema},f.product,0);
  const payload=listingModelPayload(context);
  assert.ok('fullSchema' in payload);
  assert.deepEqual(payload.fullSchema,{schema:schema.schema,metaSchema:schema.metaSchema});
  assert.ok(JSON.stringify(payload).length>60000);
  assert.equal(context.fields.length,Object.keys(schema.schema.properties as object).length);
  assert.ok(!JSON.stringify(payload.fields).includes('free_text'));
});

test('native candidates validate together with cross-attribute dependencies and return precise errors',async t=>{
  const f=await fixture(t),c=structuredClone(f.listing.currentContext(f.draft,f.product,0));
  c.fullSchema!.schema={type:'object',properties:{alpha:{type:'boolean'},beta:{type:'object',properties:{count:{type:'number',minimum:2}},required:['count']}},dependentRequired:{alpha:['beta']}};
  c.fullSchema!.metaSchema={};c.schemaSha256=listingFingerprint(c.fullSchema);c.currentAttributes={};c.businessValues={};
  const output=parseFullGeneration({candidates:[{field:'alpha',nativeValue:true},{field:'beta',nativeValue:{count:2}}]},c);
  assert.deepEqual(nativeCandidateIssues(output,c),[]);
  const errors=nativeCandidateIssues({...output,candidates:[output.candidates[0]]},c);
  assert.ok(errors.some(e=>e.message.includes('dependentRequired')&&e.message.includes('beta')));
  const wrong=parseFullGeneration({candidates:[{field:'beta',nativeValue:{count:1}}]},c);
  assert.ok(nativeCandidateIssues(wrong,c).some(e=>e.message.includes('/beta/count')&&e.message.includes('minimum')));
});

test('business JSON protects existing leaves and allows schema-required sibling additions',()=>{
  const before=[{currency:'USD',price:{value:5}}];
  assert.deepEqual(changedBusinessLeaves(before,[{currency:'USD',price:{value:5},channel:'DEFAULT'}]),[]);
  assert.deepEqual(changedBusinessLeaves(before,[{currency:'USD',price:{value:7}}]),['/0/price/value']);
  assert.throws(()=>parseFullReview({kind:'amazon-fields-review',verdict:'PASS',checks:[{field:'alpha',index:0,verdict:'SUPPORTED',evidenceIds:[],claims:[{text:'x',verdict:'CONTRADICTED',evidenceIds:[]}]}],issues:[]}));
});

test('automatic native schema errors feed a second generation instead of ending the operation',async t=>{
  const f=await fixture(t,{new_count:{type:'integer',minimum:2}});
  const {ListingAiService}=await import('../src/main/listing-ai/service.ts');
  const listing=new ListingAiService(f.store,f.amazon,f.ai,()=>false);let generations=0;
  f.amazon.previewDraft=async()=>{const d=f.amazon.getDraft(f.draft.id);return {...d,state:d.attributes.new_count===2?'AMAZON_VALIDATED':'BLOCKED',previewIssues:d.attributes.new_count===2?[]:[{code:'required',message:'new_count missing',severity:'ERROR',category:'field',source:'amazon',autoFixable:false,attributeNames:['new_count']}]};};
  f.respond(payload=>{generations++;if(generations===2)assert.ok(payload.repairRequest.issues.some((i:any)=>i.message.includes('minimum')));return chat({kind:'amazon-fields',contract:'listing-full-schema/v1',candidates:[{field:'new_count',nativeValue:generations===1?1:2,evidenceIds:[],transformation:'infer'}],missing:[]});});
  const result=await listing.complete(f.reference);
  assert.equal(result.aiCalls,2);assert.equal(result.draft.attributes.new_count,2);assert.deepEqual(result.remaining,[]);
});

test('a legacy DONE operation on an existing draft upgrades to full schema without reusing its failure',async t=>{
  const f=await fixture(t,{new_count:{type:'integer',minimum:2}}),legacy=new LegacyListingAiService(f.store,f.amazon,f.ai,()=>false);
  f.amazon.previewDraft=async()=>{const d=f.amazon.getDraft(f.draft.id);return {...d,state:d.attributes.new_count===2?'AMAZON_VALIDATED':'BLOCKED',previewIssues:d.attributes.new_count===2?[]:[{code:'required',message:'new_count missing',severity:'ERROR',category:'field',source:'amazon',autoFixable:false,attributeNames:['new_count']}]};};
  const old=await legacy.complete(f.reference);assert.equal(old.aiCalls,0);
  const operation=legacy.completionOperations(f.draft.id)[0];assert.equal(operation.state,'DONE');
  const {ListingAiService}=await import('../src/main/listing-ai/service.ts');const current=new ListingAiService(f.store,f.amazon,f.ai,()=>false);
  f.respond(()=>chat({kind:'amazon-fields',contract:'listing-full-schema/v1',candidates:[{field:'new_count',nativeValue:2}],missing:[]}));
  const result=await current.complete({draftId:old.draft.id,draftRevision:old.draft.revision},undefined,operation.id);
  assert.equal(result.aiCalls,1);assert.equal(result.draft.attributes.new_count,2);assert.equal(current.completionOperations(f.draft.id).length,2);
});

test('known local native rejections retain their rejected values across safety merge without becoming UNKNOWN',async t=>{
  const f=await fixture(t,{new_count:{type:'integer',minimum:2}});
  const {ListingAiService}=await import('../src/main/listing-ai/service.ts');const listing=new ListingAiService(f.store,f.amazon,f.ai,()=>false);
  f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:'BLOCKED',previewIssues:[{code:'required',message:'new_count missing',severity:'ERROR',category:'field',source:'amazon',autoFixable:false,attributeNames:['new_count']}]});
  f.respond(()=>chat({kind:'amazon-fields',contract:'listing-full-schema/v1',candidates:[{field:'new_count',nativeValue:1}],missing:[]}));
  const result=await listing.complete(f.reference);assert.equal(result.aiCalls,2);
  const op=listing.completionOperations(f.draft.id)[0];assert.equal(op.state,'DONE');assert.equal(op.rounds[0].resolved,true);
  const saved=f.ai.getResult(op.rounds[0].candidate.resultId!);assert.equal(saved?.output.kind,'amazon-fields');if(saved?.output.kind!=='amazon-fields')throw Error('Expected fields');
  assert.equal(saved.output.rejectedCandidates?.[0].nativeValue,1);
  const db=openDatabase(f.directory);try{retainCompletionOperations(db,db);const retained=new CompletionJournal(db).get(op.id);assert.equal(retained.state,'DONE');assert.equal(new CompletionJournal(db).unknown(op.id),false);}finally{db.close();}
  assert.equal(f.requests.length,2);
});

test('new operation scope does not invoke the legacy catalog or small-source budget and ignores mutable attributes',async t=>{
  const f=await fixture(t),draft=structuredClone(f.draft),product=structuredClone(f.product);
  (draft.schema.schema.properties as Record<string,unknown>).arbitrary_schema=true;
  product.facts=Array.from({length:100},(_,i)=>({...f.product.facts[0],id:`scope-fact-${i}`,value:'source description '.repeat(100)}));
  f.amazon.getDraft=()=>draft;f.store.getProduct=()=>product;
  const op=f.listing.beginCompletion(f.reference);
  draft.attributes.arbitrary_schema={nested:['any',3,false]};draft.revision++;
  const again=f.listing.beginCompletion({draftId:draft.id,draftRevision:draft.revision});
  assert.equal(again.id,op.id);assert.equal(again.scopeHash,op.scopeHash);assert.equal(f.requests.length,0);
});
