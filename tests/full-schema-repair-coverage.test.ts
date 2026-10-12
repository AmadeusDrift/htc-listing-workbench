import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,chat} from './fixtures/listing-ai.ts';
import {buildListingContext} from '../src/main/listing-ai/context.ts';
import {currentProseRepairIssues,currentDraftEvidenceIssues} from '../src/main/listing-ai/current-evidence.ts';
const stringField={type:'array',items:{type:'object',properties:{value:{type:'string'}}}};
test('full-schema repair covers the same explicit special_feature conflict as final checking',async t=>{
 const f=await fixture(t,{special_feature:stringField});
 const draft={...f.draft,attributes:{...f.draft.attributes,special_feature:[{value:'Soft Bristles'}]}};
 const context=buildListingContext(draft,f.product,f.amazon.executionTargetScope(draft.targetId).generation);
 context.evidence.push({id:'sku-firmness',name:'item_firmness_description',meaning:'general',value:'Hard',source:'source_confirmed'});
 assert.ok(currentDraftEvidenceIssues(draft,context).some(s=>s.includes('special_feature')));
 assert.deepEqual(currentProseRepairIssues(draft,context).map(i=>i.field),['special_feature']);
 draft.attributes.special_feature=[{value:'Hard Bristles'}];
 assert.deepEqual(currentProseRepairIssues(draft,context),[]);
 draft.attributes.special_feature=[{value:'A playful touch for everyday use'}];
 assert.deepEqual(currentProseRepairIssues(draft,context),[]);
});

test('completion repairs the conflicting structured field while preserving other copy',async t=>{
 const f=await fixture(t,{special_feature:stringField});
 const saved=f.amazon.saveDraft({id:f.draft.id,revision:f.draft.revision,attributes:{...f.draft.attributes,special_feature:[{value:'Soft Bristles'}]}});
 const current=f.listing.currentContext.bind(f.listing);
 f.listing.currentContext=(...args)=>{const context=current(...args);context.evidence.push({id:'sku-firmness',name:'item_firmness_description',meaning:'general',value:'Hard',source:'source_confirmed'});return context;};
 f.amazon.previewDraft=async()=>({...f.amazon.getDraft(saved.id),state:'AMAZON_VALIDATED',previewIssues:[]});
 f.respond(payload=>payload.candidate?chat({kind:'amazon-fields-review',verdict:'PASS',checks:[{field:'special_feature',index:0,verdict:'SUPPORTED',evidenceIds:['sku-firmness'],reason:'Source explicitly says hard.',claims:[]}],issues:[]}):chat({kind:'amazon-fields',candidates:[{field:'special_feature',nativeValue:[{value:'Hard Bristles'}],evidenceIds:['sku-firmness'],transformation:'compose'}],missing:[]}));
 const result=await f.listing.complete({draftId:saved.id,draftRevision:saved.revision});
 const payload=JSON.parse(f.requests[0].messages[1].content);
 assert.deepEqual(payload.repairRequest.issues.map((i:any)=>i.field),['special_feature']);
 assert.deepEqual(result.draft.attributes.special_feature,[{value:'Hard Bristles'}]);
 assert.deepEqual(result.draft.attributes.item_name,saved.attributes.item_name);
 assert.equal(result.remaining.length,0);assert.equal(result.aiCalls,2);
});
