import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,chat,reviewFor } from './fixtures/listing-ai.ts';

const native={enabled:true,dimensions:{width:2.5,unit:'centimeters'},parts:['base','rim']};
const schema={type:'object',properties:{enabled:{type:'boolean'},dimensions:{type:'object',properties:{width:{type:'number'},unit:{const:'centimeters'}},required:['width','unit'],additionalProperties:false},parts:{type:'array',items:{type:'string'}}},required:['enabled','dimensions','parts'],additionalProperties:false};
for(const path of ['initial','completion'] as const)test(`A22 ${path} adopts exact nested native JSON and preserves an unrelated manual title`,async t=>{
  const f=await fixture(t,{custom_structure:schema}),saved=f.amazon.saveDraft({id:f.draft.id,revision:f.draft.revision,attributes:{item_name:[{value:'Human title'}]}}),reference={draftId:saved.id,draftRevision:saved.revision};
  f.respond(payload=>chat(payload.candidate?reviewFor(payload):{kind:'amazon-fields',contract:'listing-full-schema/v1',candidates:[{field:'custom_structure',nativeValue:native,evidenceIds:[],transformation:'infer',inferenceReason:'Synthetic native-shape contract fixture'}],missing:[]}));
  if(path==='initial'){
    const suggestion=await f.listing.suggest(reference),review=await f.listing.review({...reference,suggestionResultId:suggestion.id});
    await f.listing.adopt({...reference,suggestionResultId:suggestion.id,reviewResultId:review.id,fields:['custom_structure']});
  }else{
    f.amazon.previewDraft=async()=>{const draft=f.amazon.getDraft(saved.id);return{...draft,state:draft.attributes.custom_structure?'AMAZON_VALIDATED':'BLOCKED',previewIssues:draft.attributes.custom_structure?[]:[{code:'MISSING',message:'Missing nested attribute',severity:'ERROR',category:'field',source:'amazon',attributeNames:['custom_structure'],autoFixable:false}]};};
    const result=await f.listing.complete(reference);assert.deepEqual(result.remaining,[]);
  }
  const result=f.amazon.getDraft(saved.id);assert.deepEqual(result.attributes.custom_structure,native);assert.deepEqual(result.attributes.item_name,[{value:'Human title'}]);
});

test('A22 copy repair compares native JSON without replacing native-only structure with a display wrapper',async t=>{
  const f=await fixture(t,{item_name:{type:'array',items:{type:'object',properties:{value:{type:'string'},marketplace_id:{type:'string'},language_tag:{type:'string'},display_metadata:{type:'object',properties:{enabled:{type:'boolean'}}}},required:['value'],additionalProperties:false}}});
  const value=[{value:'Blue Silicone Coaster',display_metadata:{enabled:true}}],saved=f.amazon.saveDraft({id:f.draft.id,revision:f.draft.revision,attributes:{item_name:value}}),reference={draftId:saved.id,draftRevision:saved.revision};
  let reviewCalls=0;f.respond(payload=>{
    if(payload.operation==='listing-current-review'){
      for(const c of payload.candidate.candidates)for(const item of c.items)item.evidenceIds=payload.evidence.map((e:any)=>e.id);
      const review=reviewFor(payload);if(reviewCalls++<2){review.verdict='NEEDS_CHANGES';review.issues=[{field:'item_name',message:'Please verify the title'}] as any;for(const check of review.checks){check.verdict='UNSUPPORTED';for(const claim of check.claims)claim.verdict='UNSUPPORTED';}}
      return chat(review);
    }
    return chat(payload.candidate?reviewFor(payload):{kind:'amazon-fields',contract:'listing-full-schema/v1',candidates:[{field:'item_name',nativeValue:value,evidenceIds:payload.evidence.map((e:any)=>e.id),transformation:'compose'}],missing:[]});
  });
  const current=await f.listing.reviewCurrentForImages(reference);
  assert.equal(reviewCalls,2,'both ordinary and upgraded reviews genuinely reject before repair');assert.equal((current.review.output as any).verdict,'NEEDS_CHANGES');
  const repaired=await f.listing.repairCurrentForImages({...reference,reviewResultId:current.review.id});
  assert.deepEqual(repaired.draft.attributes.item_name,value);assert.equal(repaired.draft.revision,saved.revision);assert.equal(repaired.draft.fieldAdoptions?.length??0,0);
});
