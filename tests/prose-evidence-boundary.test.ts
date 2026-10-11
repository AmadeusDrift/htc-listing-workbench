import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { assertListingEvidence, assertListingReview, validateListingFieldsOutput, validateListingReviewOutput, listingFingerprint } from '../src/main/listing-ai/validation.ts';
import { currentCopyIssues, currentDraftEvidenceIssues, currentProseRepairIssues, assertCurrentImageCategoryExclusions } from '../src/main/listing-ai/current-evidence.ts';
import { assertStoredListingEvidence } from '../src/main/listing-ai/stored-evidence.ts';
import { assertCurrentListingReview, assertImagePlan } from '../src/main/ai/image-validation.ts';
import { legacyFixture as fixture, saveInput, chat, reviewFor, mockStorage } from './fixtures/listing-ai.ts';
import { WorkspaceStore } from '../src/main/store.ts';
import { AmazonService } from '../src/main/amazon/service.ts';
import { HostingService } from '../src/main/hosting/service.ts';
import { AiService } from '../src/main/ai/service.ts';
import { openDatabase } from '../src/main/database.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
// Frozen v0-v3 prose authorization and historical adoption/backup compatibility.
import { LegacyListingAiService as ListingAiService, buildListingContext } from './helpers/legacy-listing-context.ts';
import type { CandidateField, ListingAiContext, ListingEvidence } from '../src/shared/listing-ai-contracts.ts';

const prose=['item_name','bullet_point','product_description','generic_keyword'] as const;
const fact=(name:string,value:string,source:ListingEvidence['source']='source_confirmed'):ListingEvidence=>({id:randomUUID(),name,value,meaning:name==='材质'?'material':name==='颜色'?'color':'general',source});
const material=fact('材质','硅胶');
const scope=(evidence:ListingEvidence[],fields:readonly CandidateField[]=prose)=>({productType:'TOOTHBRUSH',fields:fields.map(name=>({name,title:name,requirement:'optional',closedEnum:false,allowedValues:[],suggestedValues:[]})),evidence}) as unknown as ListingAiContext;
const candidate=(field:CandidateField,value:string,evidence:ListingEvidence[])=>validateListingFieldsOutput({kind:'amazon-fields',candidates:[{field,items:Array.from({length:field==='bullet_point'?5:1},(_,i)=>({value:value+(field==='bullet_point'?' option '+(i+1):''),evidenceIds:evidence.map(e=>e.id),transformation:'compose'}))}],missing:[]});

for(const field of prose)test(field+': present category sources require support and actual citations',()=>{
  for(const [name,raw,value] of [
    ['适用年龄','三岁以上','Adult Cleaner'],['适用年龄','儿童','Adult Cleaner'],['适用年龄','不适合儿童','Adult Cleaner'],
    ['供电方式','待确认','Electric Cleaner'],['供电方式','手动','Electric Cleaner'],['供电方式','非电动','Manual Cleaner'],
    ['刷毛硬度','待确认','Soft Bristles'],['刷毛硬度','硬毛','Soft Bristles'],['刷毛硬度','非硬毛','Soft Bristles'],
  ]){
    const source=fact(name,raw),context=scope([source,material]);
    assert.throws(()=>assertListingEvidence(candidate(field,value,[material]),context),raw+': '+value);
    assert.ok(currentCopyIssues([{field,values:[value]}],context).length,raw+': '+value);
    assert.doesNotThrow(()=>assertListingEvidence(candidate(field,'Silicone Cleaner',[material]),context));
  }
  const adult=fact('适用年龄','成人'),context=scope([adult,material]);
  assert.throws(()=>assertListingEvidence(candidate(field,'Adult Cleaner',[material]),context));
  assert.doesNotThrow(()=>assertListingEvidence(candidate(field,'Adult Cleaner',[adult]),context));
});

test('source absence keeps existing ordinary prose and typed inference boundaries',()=>{
  const context=scope([material,fact('产品类别','Toothbrush')],[...prose,'age_range_description']);
  assert.doesNotThrow(()=>assertListingEvidence(candidate('item_name','Adult Cleaner',[material]),context));
  assert.deepEqual(currentCopyIssues([{field:'item_name',values:['Adult Cleaner']}],context),[]);
  const output={kind:'amazon-fields',candidates:[{field:'age_range_description',items:[{value:'Adult',evidenceIds:[material.id],transformation:'infer',inferenceReason:'Judgment from the actual toothbrush category and material.'}]}],missing:[]};
  assert.doesNotThrow(()=>assertListingEvidence(validateListingFieldsOutput(output),context));
  assert.throws(()=>validateListingFieldsOutput({...output,candidates:[{...output.candidates[0],field:'item_name'}]}));
});

test('negative prose requires its original exclusion and citation, never an inferred opposite',()=>{
  const excluded=fact('适用年龄','不适合儿童'),adult=fact('适用年龄','成人');
  for(const text of ['Not for children','Cleaner not for children','Cleaner; not for children']){
    assert.doesNotThrow(()=>assertListingEvidence(candidate('item_name',text,[excluded]),scope([excluded,material])));
    assert.throws(()=>assertListingEvidence(candidate('item_name',text,[material]),scope([excluded,material])));
    assert.throws(()=>assertListingEvidence(candidate('item_name',text,[adult]),scope([adult,material])));
  }
  const mixed=fact('适用年龄','不适合儿童；适用成人');
  assert.doesNotThrow(()=>assertListingEvidence(candidate('item_name','Not for children; suitable for adults',[mixed]),scope([mixed])));
  for(const text of ['Not for children or adults','Child Cleaner with no battery','Child Cleaner; not for children'])
    assert.throws(()=>assertListingEvidence(candidate('item_name',text,[mixed]),scope([mixed])),text);
  assert.throws(()=>assertListingEvidence(candidate('item_name','Adult Cleaner',[excluded]),scope([excluded,adult])),'a separate exclusion is not the actual positive support');
});

test('finite prose masks preserve other real claims and independent color checks',()=>{
  const age=fact('适用年龄','成人','selected_sku'),power=fact('供电方式','电动'),firm=fact('刷毛硬度','硬毛'),blue=fact('颜色','Baby Blue');
  const context=scope([age,power,firm,blue,material]);
  for(const text of ['Baby Blue Cleaner','Baby Shower Decorations','Decorations for a baby shower','Manual instructions included','Consult the instruction manual','Soft touch silicone handle','For hard surfaces'])
    assert.doesNotThrow(()=>assertListingEvidence(candidate('item_name',text,[blue,material]),context),text);
  assert.throws(()=>assertListingEvidence(candidate('item_name','Baby Blue Cleaner',[material]),context),'color obligation survives masking');
  for(const text of ['Baby Blue Cleaner for children','Baby shower gift for children','Instruction manual for a manual cleaner'])
    assert.throws(()=>assertListingEvidence(candidate('item_name',text,[blue,material]),context),text);
  const child=fact('适用年龄','儿童','selected_sku'),childContext=scope([child,material]);
  assert.doesNotThrow(()=>assertListingEvidence(candidate('item_name','Adult supervision required',[material]),childContext));
  assert.throws(()=>assertListingEvidence(candidate('item_name','Adult supervision for adult users',[child]),childContext));
});

for(const boundary of ['candidate','current copy','split review','caption'] as const)test('repeated category mentions cannot share one negative scope: '+boundary,()=>{
  for(const [name,raw,text] of [
    ['适用年龄','不适合儿童','Not for children and suitable for children'],
    ['适用年龄','不适合儿童','Not for children but child friendly'],
    ['适用年龄','不适合儿童','Not for children, children welcome'],
    ['适用年龄','不适合儿童','Not for children or kids'],
    ['供电方式','非电动','Not electric but electric cleaner'],
    ['供电方式','非有线电动','Not corded electric but corded electric cleaner'],
    ['刷毛硬度','非软毛','Not soft bristles but soft bristles'],
    ['刷毛硬度','非硬毛','Not hard bristles but firm bristles'],
  ])for(const field of prose){
    const source=fact(name,raw),context=scope([source,material]);
    const output=candidate(field,text,[source]);
    if(boundary==='candidate')assert.throws(()=>assertListingEvidence(output,context),field+': '+text);
    if(boundary==='current copy')assert.ok(currentCopyIssues([{field,values:[text]}],context).length,field+': '+text);
    if(boundary==='split review'){
      const review=reviewFor({candidate:output});
      const split=text.search(/ and | but | or |, /);
      for(const check of review.checks)check.claims=[{...check.claims[0],text:text.slice(0,split)},{...check.claims[0],text:check.claims[0].text.slice(split)}];
      assert.throws(()=>assertListingReview(validateListingReviewOutput(review),output,context),field+': '+text);
    }
    if(boundary==='caption'){
      assert.throws(()=>assertImagePlan({expectedText:[{text,evidenceIds:[source.id]}],textMode:'short'} as any,{listing:context,policyVersion:'product-image/v1',purpose:'detail'} as any,{storedVersion:'listing-evidence/v3'}),text);
      assert.throws(()=>assertCurrentImageCategoryExclusions(context,{plans:[{output:{kind:'image-plan',expectedText:[{text,evidenceIds:[source.id]}]}} as any]}),text);
    }
  }
});

test('mixed repeated source terms cannot license finite negative prose',()=>{
  for(const [name,raw,text] of [
    ['适用年龄','not for children and suitable for children','Not for children'],
    ['适用年龄','not for children but kids welcome','Not for children'],
    ['适用年龄','not for children or kids','Not for children'],
    ['适用年龄','不适合儿童但适合儿童','Not for children'],
    ['适用年龄','不适合儿童且适合儿童','Not for children'],
    ['供电方式','not electric but electric powered','Not electric'],
    ['供电方式','非电动但电动','Not electric'],
    ['刷毛硬度','not hard but firm bristles','Not hard bristles'],
    ['刷毛硬度','非硬毛但硬毛','Not hard bristles'],
  ]){
    const source=fact(name,raw),context=scope([source]);
    assert.throws(()=>assertListingEvidence(candidate('item_name',text,[source]),context),raw);
    assert.ok(currentCopyIssues([{field:'item_name',values:[text]}],context).length,raw);
  }
});

for(const boundary of ['candidate','current copy','split review','caption'] as const)test('non-bristle adjectives cannot donate their negation to a bristle claim: '+boundary,()=>{
  for(const [raw,text] of [
    ['非软毛','Not soft handle but soft bristles'],
    ['非硬毛','Not firm grip but firm bristles'],
    ['非硬毛','Not firm grip but hard bristles'],
    ['非超软','Not extra soft handle but extra soft bristles'],
  ])for(const field of prose){
    const source=fact('刷毛硬度',raw),context=scope([source]),output=candidate(field,text,[source]);
    if(boundary==='candidate')assert.throws(()=>assertListingEvidence(output,context),text);
    if(boundary==='current copy')assert.ok(currentCopyIssues([{field,values:[text]}],context).length,text);
    if(boundary==='split review'){
      const review=reviewFor({candidate:output}),split=text.indexOf(' but ');
      for(const check of review.checks)check.claims=[{...check.claims[0],text:text.slice(0,split)},{...check.claims[0],text:check.claims[0].text.slice(split)}];
      assert.throws(()=>assertListingReview(validateListingReviewOutput(review),output,context),text);
    }
    if(boundary==='caption'){
      assert.throws(()=>assertImagePlan({expectedText:[{text,evidenceIds:[source.id]}],textMode:'short'} as any,{listing:context,policyVersion:'product-image/v1',purpose:'detail'} as any,{storedVersion:'listing-evidence/v3'}),text);
      assert.throws(()=>assertCurrentImageCategoryExclusions(context,{plans:[{output:{kind:'image-plan',expectedText:[{text,evidenceIds:[source.id]}]}} as any]}),text);
    }
  }
});

test('non-bristle wording stays ordinary and separated firmness clauses retain their own polarity',()=>{
  const soft=fact('刷毛硬度','软毛'),excluded=fact('刷毛硬度','非软毛');
  for(const source of [soft,excluded,fact('刷毛硬度','待确认')])for(const text of ['For hard surfaces','Soft touch handle','Not soft handle','Not firm grip but soft touch']){
    assert.doesNotThrow(()=>assertListingEvidence(candidate('item_name',text,[material]),scope([source,material])));
    assert.deepEqual(currentCopyIssues([{field:'item_name',values:[text]}],scope([source])),[]);
  }
  assert.doesNotThrow(()=>assertListingEvidence(candidate('item_name','Not soft handle; soft bristles',[soft]),scope([soft])));
  assert.throws(()=>assertListingEvidence(candidate('item_name','Not soft handle; soft bristles',[excluded]),scope([excluded])));
  assert.doesNotThrow(()=>assertListingEvidence(candidate('item_name','Not soft bristles',[excluded]),scope([excluded])));
  assert.doesNotThrow(()=>assertListingEvidence(candidate('item_name','Not soft bristles; soft touch handle',[excluded]),scope([excluded])));
  const hard=fact('刷毛硬度','硬毛');
  assert.doesNotThrow(()=>assertListingEvidence(candidate('item_name','Soft touch handle with hard bristles',[hard]),scope([hard])));
  assert.doesNotThrow(()=>assertListingEvidence(candidate('item_name','Not soft handle but soft bristles',[material]),scope([material])));
  assert.doesNotThrow(()=>assertStoredListingEvidence(candidate('item_name','Not soft handle but soft bristles',[excluded]),scope([excluded]),'listing-evidence/v2'));
});

test('single exclusions, separately scoped clauses and absent-source negative prose retain their boundaries',()=>{
  const negative=fact('适用年龄','不适合儿童'),mixed=fact('适用年龄','不适合儿童；适用成人');
  for(const [source,text] of [[negative,'Not for children'],[negative,'Not for children; not for children'],[mixed,'Not for children; suitable for adults'],[mixed,'Not for children, suitable for adults'],[fact('供电方式','非电动；手动'),'Not electric; manual cleaner'],[fact('刷毛硬度','非软毛；硬毛'),'Not soft bristles; hard bristles'],[fact('供电方式','非有线电动'),'Not corded electric'],[fact('刷毛硬度','非超软毛'),'Not extra soft bristles']] as const)
    assert.doesNotThrow(()=>assertListingEvidence(candidate('item_name',text,[source]),scope([source])));
  for(const text of ['Not for children','Not for children and suitable for children']){
    assert.doesNotThrow(()=>assertListingEvidence(candidate('item_name',text,[material]),scope([material])));
    assert.deepEqual(currentCopyIssues([{field:'item_name',values:[text]}],scope([material])),[]);
    assert.doesNotThrow(()=>assertStoredListingEvidence(candidate('item_name',text,[negative]),scope([negative]),'listing-evidence/v2'));
  }
});

test('current source blockers and selected priority apply through finite prose grammar',()=>{
  const adult=fact('适用年龄','成人'),child=fact('适用年龄','儿童','selected_sku');
  assert.throws(()=>assertListingEvidence(candidate('item_name','Adult Cleaner',[adult]),scope([adult,child])));
  assert.doesNotThrow(()=>assertListingEvidence(candidate('item_name','Child Cleaner',[child]),scope([adult,child])));
  const context=scope([material]);
  context.evidenceBlockers=[{field:'age_range_description',reason:'source_conflict',facts:[adult,child]}];
  assert.throws(()=>assertListingEvidence(candidate('item_name','Adult Cleaner with no battery',[material]),context));
  assert.doesNotThrow(()=>assertListingEvidence(candidate('item_name','Baby shower decoration',[material]),context));
});

test('PASS checks, split claims, current reviews and captions retain category citation obligations',()=>{
  const age=fact('适用年龄','成人'),context=scope([material,age]),output=candidate('item_name','Adult Cleaner',[age]);
  const review=reviewFor({candidate:output}) as any;
  review.checks[0].evidenceIds=[material.id];
  assert.throws(()=>assertListingReview(review,output,context));
  review.checks[0].evidenceIds=[age.id];review.checks[0].claims=[{text:'Adult',verdict:'SUPPORTED',evidenceIds:[material.id],reason:'Unsupported citation'},{text:'Cleaner',verdict:'SUPPORTED',evidenceIds:[material.id],reason:'Product wording'}];
  assert.throws(()=>assertListingReview(review,output,context));
  const unknown=fact('适用年龄','三岁以上'),unknownContext=scope([material,unknown]),bad=candidate('item_name','Adult Cleaner',[material]);
  assert.throws(()=>assertCurrentListingReview(reviewFor({candidate:bad}) as any,[{field:'item_name',values:['Adult Cleaner']}],unknownContext));
  assert.throws(()=>assertImagePlan({expectedText:[{text:'Adult Cleaner',evidenceIds:[material.id]}],textMode:'short'} as any,{listing:unknownContext,policyVersion:'product-image/v1',purpose:'detail'} as any,{storedVersion:'listing-evidence/v3'}));
  const excluded=fact('适用年龄','不适合儿童'),negative=candidate('item_name','Not for children',[excluded]),negativeReview=reviewFor({candidate:negative}) as any;
  negativeReview.checks[0].claims=[{text:'Not for',verdict:'SUPPORTED',evidenceIds:[excluded.id],reason:'Scope'},{text:'children',verdict:'SUPPORTED',evidenceIds:[excluded.id],reason:'Same negative claim'}];
  assert.doesNotThrow(()=>assertListingReview(negativeReview,negative,scope([excluded])));
  const power=fact('供电方式','手动'),both=candidate('item_name','Adult Manual Cleaner',[age,power]),split=reviewFor({candidate:both}) as any;
  split.checks[0].claims=[{text:'Adult',verdict:'SUPPORTED',evidenceIds:[age.id],reason:'Age'},{text:'Manual',verdict:'SUPPORTED',evidenceIds:[power.id],reason:'Power'},{text:'Cleaner',verdict:'SUPPORTED',evidenceIds:[material.id],reason:'General'}];
  assert.doesNotThrow(()=>assertListingReview(split,both,scope([age,power,material])));
  const blue=fact('颜色','Baby Blue'),blueCopy=candidate('item_name','Baby Blue Cleaner',[blue]),blueReview=reviewFor({candidate:blueCopy}) as any;
  blueReview.checks[0].claims=[{text:'Baby',verdict:'SUPPORTED',evidenceIds:[blue.id],reason:'Part of color'},{text:'Blue Cleaner',verdict:'SUPPORTED',evidenceIds:[blue.id],reason:'Color'}];
  assert.doesNotThrow(()=>assertListingReview(blueReview,blueCopy,scope([age,blue])));
});

test('v0/v1/v2 retain historical prose semantics while current authorization rejects',()=>{
  const age=fact('适用年龄','三岁以上'),context=scope([age,material]),output=candidate('item_name','Adult Cleaner',[material]);
  for(const version of [undefined,'listing-evidence/v1','listing-evidence/v2'])
    assert.doesNotThrow(()=>assertStoredListingEvidence(output,context,version));
  assert.throws(()=>assertListingEvidence(output,context));
  assert.throws(()=>assertStoredListingEvidence(output,context,'listing-evidence/v999'));
});

test('old image text is checked against current present sources without rebinding its historical citations',()=>{
  const age=fact('适用年龄','三岁以上'),context=scope([age,material]);
  const plan={output:{kind:'image-plan',expectedText:[{text:'Adult Cleaner',evidenceIds:['historical-only-id']}]}} as any;
  assert.throws(()=>assertCurrentImageCategoryExclusions(context,{plans:[plan]}));
  const adult=fact('适用年龄','成人'),current=scope([adult,material]);
  assert.throws(()=>assertCurrentImageCategoryExclusions(current,{plans:[plan]}),'current matching value cannot replace missing historical citation');
  plan.output.expectedText[0].evidenceIds=[adult.id];
  assert.doesNotThrow(()=>assertCurrentImageCategoryExclusions(current,{plans:[plan]}));
});

async function proseDraft(t:test.TestContext,age:string){
  const f=await fixture(t);
  const product=f.store.saveProduct({...saveInput(f.product),facts:[...f.product.facts,{id:randomUUID(),name:'适用年龄',value:age,source:'manual',sourceRef:'fixture',state:'human_confirmed'}]});
  let draft=await f.amazon.createDraft({productId:product.id,variantId:product.variants[0].id,targetId:f.draft.targetId,productType:f.draft.schema.productType,parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'});
  draft=f.amazon.saveDraft({id:draft.id,revision:draft.revision,attributes:{...draft.attributes,item_name:[{value:'Adult Cleaner',marketplace_id:draft.marketplaceId,language_tag:'en_US'}],product_description:[{value:'Handwritten description',marketplace_id:draft.marketplaceId,language_tag:'en_US'}]}});
  return {...f,product,draft,reference:{draftId:draft.id,draftRevision:draft.revision}};
}
test('completion selects only the failed prose field before preview-valid early return',async t=>{
  const f=await proseDraft(t,'三岁以上');
  f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:'AMAZON_VALIDATED',previewIssues:[]});
  f.respond(payload=>chat(payload.candidate?reviewFor(payload):{kind:'amazon-fields',candidates:candidate('item_name','Silicone Cleaner',payload.evidence.filter((e:ListingEvidence)=>e.meaning==='material')).candidates,missing:[]}));
  const result=await f.listing.complete(f.reference);
  assert.equal(result.aiCalls,2);assert.deepEqual(result.remaining,[]);
  assert.deepEqual(JSON.parse(f.requests[0].messages[1].content).fields.map((field:any)=>field.name),['item_name']);
  assert.equal((result.draft.attributes.item_name as any)[0].value,'Silicone Cleaner');
  assert.deepEqual(result.draft.attributes.product_description,f.draft.attributes.product_description);
  const op=f.listing.completionOperations(f.draft.id)[0],before=JSON.stringify(op);
  const done=await f.listing.complete({draftId:f.draft.id,draftRevision:result.draft.revision},undefined,op.id);
  assert.equal(done.aiCalls,0);assert.equal(done.previewAttempts,0);assert.equal(JSON.stringify(f.listing.getCompletion(op.id)),before);
});

test('current image copy review rejects unsupported present-source prose before a paid request',async t=>{
  const f=await proseDraft(t,'三岁以上'),before=f.requests.length;
  await assert.rejects(f.listing.reviewCurrentForImages(f.reference));
  assert.equal(f.requests.length,before);
});

async function filteredProseDraft(t:test.TestContext,age:string,text:string){
  const f=await proseDraft(t,age),weight=[{value:0.22,unit:'pounds'}];
  const draft=f.amazon.saveDraft({id:f.draft.id,revision:f.draft.revision,attributes:{...f.draft.attributes,item_package_weight:weight,item_name:[{value:'Silicone Cleaner'}],product_description:[{value:text}]}});
  const db=openDatabase(f.directory);
  try{
    const record=JSON.parse(String(db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(draft.id)!.record_json));
    record.draft.businessRules={revision:1,fields:{item_package_weight:{value:weight,reason:'业务默认；缺少实测重量'}},notices:[],quote:null,bundleQuantity:1};
    db.prepare('UPDATE listing_drafts SET record_json=? WHERE id=?').run(JSON.stringify(record),draft.id);
  }finally{db.close();}
  return {...f,draft:f.amazon.getDraft(draft.id),reference:{draftId:draft.id,draftRevision:draft.revision}};
}

test('raw finite prose is checked before image-only measurement sentence filtering in all four fields',()=>{
  const context=scope([fact('适用年龄','三岁以上')]),dimension=[{value:10,unit:'centimeters'}];
  for(const field of prose){
    const draft={attributes:{[field]:[{value:'Adult Cleaner 10 cm'}],item_length:dimension},businessRules:{fields:{item_length:{value:dimension,reason:'业务默认'}}}} as any;
    assert.ok(currentDraftEvidenceIssues(draft,context).some(issue=>issue.includes(field)),field);
  }
});

test('public image snapshot rejects raw unsupported prose hidden by default-weight sentence filtering',async t=>{
  const f=await filteredProseDraft(t,'三岁以上','Adult Cleaner 100 g. Silicone coaster.');
  await assert.rejects(f.listing.snapshotCurrentForImages(f.reference));
  await assert.rejects(f.listing.reviewCurrentForImages(f.reference));
  assert.equal(f.requests.length,0);assert.deepEqual(f.amazon.getDraft(f.draft.id),f.draft);
});

test('DONE reports raw unsupported prose hidden by image filtering without calls or journal changes',async t=>{
  const f=await filteredProseDraft(t,'三岁以上','Adult Cleaner 100 g. Silicone coaster.'),operation=f.listing.beginCompletion(f.reference);
  operation.state='DONE';operation.remaining=[];f.ai.completionJournal.save(operation);
  const before=JSON.stringify(f.listing.getCompletion(operation.id)),result=await f.listing.complete(f.reference,undefined,operation.id);
  assert.equal(result.aiCalls,0);assert.equal(result.previewAttempts,0);assert.equal(f.requests.length,0);
  assert.equal(JSON.stringify(f.listing.getCompletion(operation.id)),before);
  assert.ok(result.remaining.some(issue=>issue.includes('product_description')));
});

test('raw finite checks retain ordinary measurement filtering, supported manual age and real adoption citations',async t=>{
  for(const [age,text] of [['三岁以上','Cleaner 100 g. Silicone coaster.'],['成人','Adult Cleaner 100 g. Silicone coaster.']]){
    const f=await filteredProseDraft(t,age,text),snapshot=await f.listing.snapshotCurrentForImages(f.reference);
    assert.deepEqual(snapshot.currentListingCopy.find(item=>item.field==='product_description')?.values,['Silicone coaster.']);
    assert.deepEqual(f.amazon.getDraft(f.draft.id),f.draft);assert.equal(f.requests.length,0);
  }
  const age=fact('适用年龄','成人'),measure=fact('Measured weight','100 g'),context=scope([age,measure]),values=[{value:'Adult Cleaner 100 g'}];
  const result={id:'valid',listingContext:context,sourceSha256:listingFingerprint(context),output:candidate('product_description',values[0].value,[age,measure])} as any;
  const draft={attributes:{product_description:values},fieldAdoptions:[{suggestionResultId:result.id,contextSha256:result.sourceSha256,changes:[{field:'product_description',after:values}]}]} as any;
  assert.deepEqual(currentDraftEvidenceIssues(draft,context,()=>result),[]);
});

for(const version of [undefined,'listing-evidence/v1','listing-evidence/v2'] as const)test((version??'v0')+' prose PASS history stays readable and backup-stable but grants no current review, adoption or DONE calls',async t=>{
  const f=await proseDraft(t,'三岁以上'),suggestion=structuredClone(await f.listing.suggest(f.reference));
  const review=structuredClone(await f.listing.review({...f.reference,suggestionResultId:suggestion.id}));
  const evidence=suggestion.listingContext!.evidence.filter(item=>item.meaning==='material');
  suggestion.output=candidate('item_name','Adult Cleaner',evidence);review.output=validateListingReviewOutput(reviewFor({candidate:suggestion.output}));
  for(const record of [suggestion,review])if(version)record.listingEvidenceContractVersion=version;else delete record.listingEvidenceContractVersion;
  const raws=new Map([suggestion,review].map(record=>[record.id,JSON.stringify(record)])),db=openDatabase(f.directory);
  try{for(const [id,raw]of raws)db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(raw,id);}finally{db.close();}
  assert.deepEqual(f.ai.getResult(suggestion.id),suggestion);assert.deepEqual(f.ai.getResult(review.id),review);
  assert.ok(f.ai.queryResults({productId:f.product.id}).items.some(record=>record.id===suggestion.id));
  const before=f.requests.length;
  await assert.rejects(f.listing.review({...f.reference,suggestionResultId:suggestion.id}));
  await assert.rejects(f.listing.adopt({...f.reference,suggestionResultId:suggestion.id,reviewResultId:review.id,fields:['item_name']}));
  await assert.rejects(f.listing.snapshotCurrentForImages(f.reference));
  const operation=f.listing.beginCompletion(f.reference);operation.state='DONE';operation.remaining=[];f.ai.completionJournal.save(operation);
  const journal=JSON.stringify(f.listing.getCompletion(operation.id)),done=await f.listing.complete(f.reference,undefined,operation.id);
  assert.equal(done.aiCalls,0);assert.equal(done.previewAttempts,0);assert.ok(done.remaining.some(issue=>issue.includes('item_name')));
  assert.equal(JSON.stringify(f.listing.getCompletion(operation.id)),journal);assert.equal(f.requests.length,before);
  const path=join(f.directory,'prose.htcbackup'),target=join(f.directory,'restored'),password='isolated prose evidence backup';
  await createWorkspaceBackup(f.directory,path,password);await commitWorkspaceRestore(target,await prepareWorkspaceRestore(target,path,password));
  const restored=openDatabase(target);try{for(const [id,raw]of raws)assert.equal(restored.prepare('SELECT record_json FROM ai_results WHERE id=?').get(id)!.record_json,raw);}finally{restored.close();}
});

for(const field of prose)test(field+': latest matching adoption owns its proof before validation',()=>{
  const age=fact('适用年龄','成人'),context=scope([age,material]),value=candidate(field,'Adult Cleaner',[age]).candidates[0].items.map(item=>({value:item.value}));
  const result=(id:string,evidence:ListingEvidence[])=>({id,output:candidate(field,'Adult Cleaner',evidence),listingContext:context,sourceSha256:listingFingerprint(context)}) as any;
  const old=result('old',[material]),latest=result('latest',[age]);
  const adoption=(id:string,fromRevision:number)=>({id,suggestionResultId:id,reviewResultId:null,contextSha256:listingFingerprint(context),fromRevision,toRevision:fromRevision+1,fields:[field],changes:[{field,before:value,after:value,evidence:[]}],at:'2026-10-10T00:00:00.000Z'}) as any;
  const draft={revision:3,attributes:{[field]:value},fieldAdoptions:[adoption('old',1),adoption('latest',2)]} as any;
  const records=new Map([['old',old],['latest',latest]]);
  assert.ok(currentDraftEvidenceIssues({...draft,fieldAdoptions:[draft.fieldAdoptions[0]]},context,id=>records.get(id)).length);
  assert.deepEqual(currentDraftEvidenceIssues(draft,context,id=>records.get(id)),[]);
  for(const invalid of [undefined,{...latest,sourceSha256:'0'.repeat(64)},{...latest,output:{kind:'amazon-fields',candidates:[],missing:[]}},{...latest,output:candidate(field,'Child Cleaner',[age])},{...latest,output:old.output}]){
    const get=(id:string)=>id==='latest'?invalid:result('old',[age]);
    assert.ok(currentDraftEvidenceIssues(draft,context,get).length,'invalid latest cannot fall back to an older valid adoption');
  }
  const nonmatching=structuredClone(draft);nonmatching.fieldAdoptions[1].changes[0].after=[{value:'A different value'}];
  assert.ok(currentDraftEvidenceIssues(nonmatching,context,id=>records.get(id)).length,'nonmatching newer adoption cannot hide the matching older responsibility');
});

test('broken adoption proof and unrelated material citation errors do not authorize new prose repair',()=>{
  const age=fact('适用年龄','成人'),context=scope([age,material]);
  for(const text of ['Adult Cleaner','Silicone Cleaner']){
    const values=[{value:text}],valid={id:'latest',output:candidate('item_name',text,[age]),listingContext:context,sourceSha256:listingFingerprint(context)} as any;
    const draft={attributes:{item_name:values},fieldAdoptions:[{suggestionResultId:'latest',contextSha256:listingFingerprint(context),changes:[{field:'item_name',after:values}]}]} as any;
    for(const result of [undefined,{...valid,sourceSha256:'0'.repeat(64)},{...valid,output:{kind:'amazon-fields',candidates:[],missing:[]}},...(text==='Silicone Cleaner'?[valid]:[])]){
      assert.ok(currentDraftEvidenceIssues(draft,context,()=>result).length);
      assert.deepEqual(currentProseRepairIssues(draft,context,()=>result),[]);
    }
  }
});

test('stored adoption scope retains full evidence but cannot hide a newly present current category source',()=>{
  const age=fact('适用年龄','成人'),stored=scope([material]),current=scope([material,age]),value=[{value:'Adult Cleaner'}];
  const result={id:'old',listingContext:stored,sourceSha256:listingFingerprint(stored),output:candidate('item_name','Adult Cleaner',[material])} as any;
  const draft={attributes:{item_name:value},fieldAdoptions:[{suggestionResultId:'old',contextSha256:result.sourceSha256,changes:[{field:'item_name',after:value}]}]} as any;
  const options={adoptionFields:prose,adoptionContext:'stored' as const};
  assert.ok(currentDraftEvidenceIssues(draft,current,()=>result,options).length);
  assert.deepEqual(currentDraftEvidenceIssues(draft,stored,()=>result,options),[],'source_absent keeps the previous prose boundary');
});

test('same-value v2 citation repair appends a v3 adoption and preserves old result and adoption bytes',async t=>{
  const f=await proseDraft(t,'成人');
  f.respond(payload=>chat(payload.candidate?reviewFor(payload):{kind:'amazon-fields',candidates:candidate('item_name','Adult Cleaner',payload.evidence.filter((e:ListingEvidence)=>e.name==='适用年龄')).candidates,missing:payload.fields.filter((field:any)=>field.name!=='item_name').map((field:any)=>({field:field.name,reason:'Outside this repair'}))}));
  const suggestion=await f.listing.suggest(f.reference),review=await f.listing.review({...f.reference,suggestionResultId:suggestion.id});
  let draft=await f.listing.adopt({...f.reference,suggestionResultId:suggestion.id,reviewResultId:review.id,fields:['item_name']});
  const material=suggestion.listingContext!.evidence.find(e=>e.meaning==='material')!,oldSuggestion=structuredClone(suggestion),oldReview=structuredClone(review);
  oldSuggestion.listingEvidenceContractVersion='listing-evidence/v2';oldReview.listingEvidenceContractVersion='listing-evidence/v2';
  if(oldSuggestion.output.kind!=='amazon-fields'||oldReview.output.kind!=='amazon-fields-review')throw Error('fixture kind');
  oldSuggestion.output.candidates[0].items[0].evidenceIds=[material.id];
  oldReview.output.checks[0].evidenceIds=[material.id];oldReview.output.checks[0].claims[0].evidenceIds=[material.id];
  const db=openDatabase(f.directory);
  try{
    for(const result of [oldSuggestion,oldReview])db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify(result),result.id);
    const record=JSON.parse(String(db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(draft.id)!.record_json));
    record.draft.fieldAdoptions[0].changes[0].evidence=[material];draft=record.draft;
    db.prepare('UPDATE listing_drafts SET record_json=? WHERE id=?').run(JSON.stringify(record),draft.id);
  }finally{db.close();}
  const oldAdoption=JSON.stringify(draft.fieldAdoptions![0]),before=f.requests.length;
  assert.deepEqual(f.ai.getResult(suggestion.id),oldSuggestion);
  assert.ok(currentDraftEvidenceIssues(draft,buildListingContext(draft,f.product,1),id=>f.ai.getResult(id)).length);
  f.amazon.previewDraft=async()=>({...f.amazon.getDraft(draft.id),state:'AMAZON_VALIDATED',previewIssues:[]});
  const result=await f.listing.complete({draftId:draft.id,draftRevision:draft.revision});
  assert.equal(result.aiCalls,2);assert.equal(f.requests.length,before+2);assert.deepEqual(result.remaining,[]);
  assert.deepEqual(result.draft.attributes,draft.attributes);assert.equal(result.draft.revision,draft.revision+1);
  assert.equal(result.draft.fieldAdoptions!.length,2);assert.equal(JSON.stringify(result.draft.fieldAdoptions![0]),oldAdoption);
  assert.deepEqual(f.ai.getResult(suggestion.id),oldSuggestion);assert.deepEqual(f.ai.getResult(review.id),oldReview);
  const next=f.ai.getResult(result.draft.fieldAdoptions![1].suggestionResultId)!;assert.equal(next.listingEvidenceContractVersion,'listing-evidence/v3');
  const restarted=new ListingAiService(f.store,f.amazon,f.ai);
  const snapshot=await restarted.snapshotCurrentForImages({draftId:draft.id,draftRevision:result.draft.revision});assert.ok(snapshot.currentListingCopy.length);
  const op=restarted.completionOperations(draft.id)[0],journal=JSON.stringify(op);
  const done=await restarted.complete({draftId:draft.id,draftRevision:result.draft.revision},undefined,op.id);
  assert.equal(done.aiCalls,0);assert.equal(done.previewAttempts,0);assert.equal(JSON.stringify(restarted.getCompletion(op.id)),journal);
  assert.equal(f.requests.length,before+2);
  const path=join(f.directory,'same-value.htcbackup'),target=join(f.directory,'same-value-restored'),password='isolated same-value adoption backup';
  await createWorkspaceBackup(f.directory,path,password);await commitWorkspaceRestore(target,await prepareWorkspaceRestore(target,path,password));
  // Backup preflight and restore both run strict stored history validation. Open
  // independent services and SQLite connections over the restored workspace.
  const store=new WorkspaceStore(target),amazon=new AmazonService(target,id=>store.getProduct(id),mockStorage),hosting=new HostingService(target,store,mockStorage);
  let restoredCalls=0;
  const ai=new AiService(target,store,hosting,mockStorage,{fetch:async()=>{restoredCalls++;throw Error('Unexpected restored provider call');}}),listing=new ListingAiService(store,amazon,ai);
  try{
    const restored=amazon.getDraft(draft.id);assert.deepEqual(restored.fieldAdoptions,result.draft.fieldAdoptions);
    assert.deepEqual(ai.getResult(suggestion.id),oldSuggestion);assert.deepEqual(ai.getResult(review.id),oldReview);
    await listing.snapshotCurrentForImages({draftId:draft.id,draftRevision:restored.revision});
    const resumed=await listing.complete({draftId:draft.id,draftRevision:restored.revision},undefined,op.id);
    assert.equal(resumed.aiCalls,0);assert.equal(resumed.previewAttempts,0);assert.deepEqual(resumed.remaining,[]);
    assert.equal(JSON.stringify(listing.getCompletion(op.id)),journal);assert.equal(restoredCalls,0);
  }finally{await ai.close();await hosting.close();amazon.close();store.close();}
});
