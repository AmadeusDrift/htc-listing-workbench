import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, legacyFixture, candidateFor, chat, reviewFor } from './fixtures/listing-ai.ts';

const issue = (field: string) => ({code:'90220',message:`Missing ${field}`,severity:'ERROR' as const,attributeNames:[field],autoFixable:false,source:'amazon' as const,category:'field' as const});

for(const field of ['theme','subject_character']) test(`schema-bound ${field} enters repair and independent evidence review`, async t => {
  const schema={type:'array',items:{type:'object',properties:{value:{type:'string',enum:['Coaster']},marketplace_id:{type:'string'}},required:['value'],additionalProperties:false}};
  const f=await fixture(t,{[field]:schema});let previews=0;
  f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:++previews===1?'BLOCKED':'AMAZON_VALIDATED',previewIssues:previews===1?[issue(field)]:[]});
  f.respond(payload=>chat(payload.candidate?reviewFor(payload):{kind:'amazon-fields',candidates:[{field,items:[{value:'Coaster',evidenceIds:[payload.evidence.find((e:any)=>e.value==='Coaster').id],transformation:'copy'}]}],missing:[]}));
  const result=await f.listing.complete(f.reference);
  assert.equal(result.aiCalls,2);assert.deepEqual(result.remaining,[]);assert.equal((result.draft.attributes[field] as any)[0].value,'Coaster');
});
test('a schema-bound semantic field is repaired and independently reviewed before adoption', async t => {
  const schema={title:'Included Components',description:'List only supplied components',type:'array',minItems:1,maxItems:1,items:{type:'object',properties:{value:{type:'string',enum:['Coaster']},marketplace_id:{type:'string'}},required:['value'],additionalProperties:false}};
  const f=await fixture(t,{included_components:schema});let previews=0;
  f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:++previews===1?'BLOCKED':'AMAZON_VALIDATED',previewIssues:previews===1?[issue('included_components')]:[]});
  f.respond(payload=>chat(payload.candidate ? reviewFor(payload) : {kind:'amazon-fields',candidates:[{field:'included_components',items:[{value:'Coaster',evidenceIds:[payload.evidence.find((e:any)=>e.value==='Coaster').id],transformation:'copy'}]}],missing:[]}));
  const result=await f.listing.complete(f.reference);
  assert.equal(result.aiCalls,2);assert.equal(result.previewAttempts,2);
  assert.equal((result.draft.attributes.included_components as any)[0].value,'Coaster');
  assert.ok(result.draft.fieldAdoptions?.[0].reviewResultId);
  assert.equal(result.draft.fieldAdoptions?.[0].changes[0].evidence[0].value,'Coaster');
  const payload=JSON.parse(f.requests[0].messages[1].content);
  assert.deepEqual(payload.fields.map((field:any)=>field.name),['included_components']);
  assert.deepEqual(payload.fullSchema.schema.properties.included_components.items.properties.value.enum,['Coaster']);
  assert.equal(payload.fullSchema.schema.properties.included_components.description,'List only supplied components');
  assert.equal(payload.candidate,undefined);
});
test('preview first: a valid draft uses no DeepSeek call or second review', async t => {
  const f=await fixture(t); let previews=0;
  f.amazon.previewDraft=async()=>{previews++;return {...f.amazon.getDraft(f.draft.id),state:'AMAZON_VALIDATED',previewIssues:[]};};
  const result=await f.listing.complete(f.reference);
  assert.equal(previews,1);assert.equal(result.aiCalls,0);assert.equal(f.requests.length,0);assert.deepEqual(result.remaining,[]);
});
test('known submit rejection remains repair evidence even if the next preview accepts the payload',async t=>{
  const f=await fixture(t);const get=f.amazon.getDraft.bind(f.amazon);
  f.amazon.wasSubmissionRejected=()=>true;
  f.amazon.getDraft=id=>({...get(id),listingIssues:[issue('material')]});
  f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:'AMAZON_VALIDATED',previewIssues:[]});
  const result=await f.listing.complete(f.reference);
  assert.equal(result.aiCalls,2);assert.equal((result.draft.attributes.material as any)[0].value,'Silicone');
  assert.equal(JSON.parse(f.requests[0].messages[1].content).repairRequest.issues[0].field,'material');
});
test('repair only preview error fields and independently review before automatic adoption', async t => {
  const f=await fixture(t);let previews=0;
  f.amazon.previewDraft=async()=>{const draft=f.amazon.getDraft(f.draft.id);previews++;return {...draft,state:previews===1?'BLOCKED':'AMAZON_VALIDATED',previewIssues:previews===1?[issue('material')]:[]};};
  const before=f.draft.attributes.item_name,result=await f.listing.complete(f.reference);
  assert.equal(result.aiCalls,2);assert.equal(result.previewAttempts,2);assert.equal(f.requests.length,2);
  const payload=JSON.parse(f.requests[0].messages[1].content);
  assert.deepEqual(payload.fields.map((v:any)=>v.name),['material']);assert.equal(payload.repairRequest.issues[0].code,'90220');
  assert.deepEqual(result.draft.attributes.item_name,before);assert.equal((result.draft.attributes.material as any)[0].value,'Silicone');
  assert.ok(result.draft.fieldAdoptions?.[0].reviewResultId);
});
test('network and unfillable compliance errors never trigger a model call', async t => {
  const f=await fixture(t);
  f.amazon.previewDraft=async()=>{throw new Error('Network unavailable');};
  await assert.rejects(f.listing.complete(f.reference),/Network unavailable/);assert.equal(f.requests.length,0);
  f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:'BLOCKED',previewIssues:[issue('compliance_document')]});
  const result=await f.listing.complete(f.reference);assert.equal(result.aiCalls,0);assert.ok(result.remaining.some(v=>v.includes('compliance_document')));
});
test('automatic repair has a bounded two-generation budget with independent reviews', async t => {
  const f=await fixture(t);
  f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:'BLOCKED',previewIssues:[issue('material')]});
  const result=await f.listing.complete(f.reference);
  assert.ok(result.aiCalls<=4);assert.ok(result.previewAttempts<=3);assert.ok(result.remaining.length>0);
  assert.ok(f.requests.filter(r=>JSON.parse(r.messages[1].content).candidate===undefined).length<=2);
});

test('automatic repair keeps valid copy when another field has unsupported evidence', async t => {
  const f=await fixture(t);let previews=0;
  f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:'BLOCKED',previewIssues:++previews===1?[issue('item_name'),issue('color')]:[issue('color')]});
  f.respond(payload=>{
    if (payload.candidate) return chat(reviewFor(payload));
    const response=candidateFor(payload);
    for(const candidate of response.candidates) if(candidate.field==='color') candidate.items=[{value:'Green',evidenceIds:[payload.evidence.find((e:any)=>e.meaning==='material').id],transformation:'translate'}];
    return chat(response);
  });
  const result=await f.listing.complete(f.reference);
  assert.equal((result.draft.attributes.item_name as any)[0].value,'Blue Silicone Coaster');
  assert.notEqual((result.draft.attributes.color as any)?.[0]?.value,'Green');
  assert.equal(result.aiCalls,3);assert.equal(f.requests.length,3);
  assert.deepEqual(JSON.parse(f.requests[2].messages[1].content).fields.map((field:any)=>field.name),['color']);
  assert.ok(result.remaining.some(value=>value.includes('color')&&value.includes('矛盾')));
  assert.equal(f.ai.getUsageSummary('deepseek').attempts,2);
});

test('automatic repair isolates a field length error but rejects unexpected envelope keys', async t => {
  const f=await legacyFixture(t);let previews=0;
  f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:'BLOCKED',previewIssues:++previews===1?[issue('item_name'),issue('material')]:[issue('compliance_document')]});
  f.respond(payload=>{if(payload.candidate)return chat(reviewFor(payload));const response=candidateFor(payload);response.candidates.find((c:any)=>c.field==='material')!.items[0].value='x'.repeat(501);return chat(response);});
  const result=await f.listing.complete(f.reference);
  assert.equal(result.aiCalls,2);assert.equal((result.draft.attributes.item_name as any)[0].value,'Blue Silicone Coaster');
  assert.notEqual((result.draft.attributes.material as any)?.[0]?.value,'x'.repeat(501));
  f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:'BLOCKED',previewIssues:[issue('item_name')]});
  f.respond(payload=>chat({...candidateFor(payload),unexpected:'must reject'}));
  await assert.rejects(f.listing.complete({draftId:result.draft.id,draftRevision:result.draft.revision}));
});
test('manual adoption does not require a second model review, but cannot bypass an existing rejection', async t => {
  const f=await fixture(t), suggestion=await f.listing.suggest(f.reference);
  const result=await f.listing.adopt({...f.reference,suggestionResultId:suggestion.id,reviewResultId:null,fields:['material']});
  assert.equal(result.fieldAdoptions?.[0].reviewResultId,null);
  const reference={draftId:result.id,draftRevision:result.revision}, next=await f.listing.suggest(reference);
  f.respond(p=>p.candidate?chat({kind:'amazon-fields-review',verdict:'BLOCKED',checks:p.candidate.candidates.flatMap((c:any)=>c.items.map((v:any,index:number)=>({field:c.field,index,verdict:'UNSUPPORTED',evidenceIds:[],reason:'Unsupported',claims:[{text:v.value,verdict:'UNSUPPORTED',evidenceIds:[],reason:'Unsupported'}]}))),issues:[{field:'material',message:'Unsupported'}]}):chat(candidateFor(p)));
  await f.listing.review({...reference,suggestionResultId:next.id});
  await assert.rejects(f.listing.adopt({...reference,suggestionResultId:next.id,reviewResultId:null,fields:['material']}),/复核/);
});

test('two explicit review rejections exhaust automatic repair without adopting either candidate', async t => {
  const f = await fixture(t);
  f.amazon.previewDraft = async () => ({ ...f.amazon.getDraft(f.draft.id), state: 'BLOCKED', previewIssues: [issue('material')] });
  f.respond(payload => chat(payload.candidate ? { ...reviewFor(payload), verdict: 'NEEDS_CHANGES', issues: [{ field: 'material', message: 'Confirm the material wording.' }] } : candidateFor(payload)));
  const result = await f.listing.complete(f.reference);
  assert.equal(result.aiCalls,4); assert.equal(f.requests.length,4);
  assert.equal(result.draft.fieldAdoptions?.length ?? 0,0);
  assert.deepEqual(result.draft.attributes.material,f.draft.attributes.material);
  assert.ok(result.remaining.some(value => value.includes('Confirm the material wording')));
  assert.ok(JSON.parse(f.requests[2].messages[1].content).repairRequest.issues.some((entry: any) => entry.code === 'CONTENT_REVIEW'));
});

for (const secondReviewPass of [true, false]) test(`negative item verdict alias enters bounded completion; second review passes=${secondReviewPass}`, async t => {
  const f = await fixture(t); let reviews = 0;
  f.amazon.previewDraft = async () => {
    const draft = f.amazon.getDraft(f.draft.id), adopted = Boolean(draft.fieldAdoptions?.length);
    return { ...draft, state: adopted ? 'AMAZON_VALIDATED' : 'BLOCKED', previewIssues: adopted ? [] : [issue('product_description')] };
  };
  f.respond(payload => {
    if (!payload.candidate) return chat(candidateFor(payload));
    const review = reviewFor(payload);
    if (++reviews === 1 || !secondReviewPass) {
      review.verdict = 'NEEDS_CHANGES'; review.checks[0].verdict = 'NEEDS_CHANGES';
      review.checks[0].claims[0].verdict = 'UNSUPPORTED';
      review.issues = [{ field: 'product_description', message: 'Remove the unsupported wording.' }] as any;
    }
    return chat(review);
  });
  const result = await f.listing.complete(f.reference);
  assert.equal(result.aiCalls, secondReviewPass?3:6); assert.equal(f.requests.length, secondReviewPass?3:6); assert.equal(reviews, secondReviewPass?2:4);
  assert.ok(result.previewAttempts <= 3);
  if(!secondReviewPass){const repair = JSON.parse(f.requests[3].messages[1].content).repairRequest;
  assert.ok(repair.issues.some((entry: any) => entry.code === 'CONTENT_REVIEW' && entry.message === 'Remove the unsupported wording.'));}
  assert.equal(result.draft.fieldAdoptions?.length ?? 0, secondReviewPass ? 1 : 0);
  if (secondReviewPass) {
    assert.deepEqual(result.remaining, []);
    assert.equal((f.ai.getResult(result.draft.fieldAdoptions![0].reviewResultId!)!.output as any).verdict, 'PASS');
  } else {
    assert.deepEqual(result.draft.attributes.product_description, f.draft.attributes.product_description);
    assert.ok(result.remaining.some(value => value.includes('Remove the unsupported wording.')));
  }
});

test('preview cleanup checkpoints an active completion atomically before caller recovery',async t=>{
  const f=await fixture(t),p=(f.amazon as any).persistence,r=p.record(f.draft.id);r.draft.listingProgram='haul';r.draft.attributes.merchant_suggested_asin=[];p.putRecord(r);
  const operation=f.listing.beginCompletion(f.reference),before=operation.draftStamp;
  try{await f.amazon.previewDraft(f.draft,operation.id);}catch{/* unrelated malformed demo attributes are still blocked */}
  const current=f.amazon.getDraft(f.draft.id),saved=f.ai.completionJournal.get(operation.id);
  const {completionDraftStamp}=await import('../src/main/listing-ai/completion-journal.ts');
  assert.equal(current.attributes.merchant_suggested_asin,undefined);assert.equal(saved.draftRevision,current.revision);assert.equal(saved.draftStamp,completionDraftStamp(current));assert.notEqual(saved.draftStamp,before);
  assert.equal(f.listing.beginCompletion({draftId:current.id,draftRevision:current.revision},operation.id).id,operation.id);assert.equal(f.requests.length,0);
});

for (const step of ['candidate','review']) test(`unknown ${step} retries only the missing call and retains the bounded history`, async t=>{
 const f=await fixture(t);let lost=true;
 f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:f.amazon.getDraft(f.draft.id).fieldAdoptions?.length?'AMAZON_VALIDATED':'BLOCKED',previewIssues:[issue('material')]});
 f.respond(p=>{if(lost&&Boolean(p.candidate)===(step==='review')){lost=false;throw Error('synthetic lost response');}return chat(p.candidate?reviewFor(p):candidateFor(p));});
 await assert.rejects(f.listing.complete(f.reference));
 const before=f.ai.completionJournal.list(f.draft.id)[0], old=structuredClone(before.rounds[0][step as 'candidate'|'review']);
 const result=await f.listing.complete({draftId:f.draft.id,draftRevision:f.amazon.getDraft(f.draft.id).revision},undefined,before.id);
 assert.equal((result.draft.attributes.material as any)[0].value,'Silicone');
 const after=f.ai.completionJournal.get(before.id),entry=after.rounds[0][step as 'candidate'|'review']!;
 assert.deepEqual((entry as any).previous,[old]);assert.equal(f.requests.length,3);
});

test('saved field candidate with missing journal reference is recovered with zero replacement calls',async t=>{
 const f=await fixture(t);f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:f.amazon.getDraft(f.draft.id).fieldAdoptions?.length?'AMAZON_VALIDATED':'BLOCKED',previewIssues:[issue('material')]});
 const send=f.ai.listingFields.bind(f.ai);let stop=true;f.ai.listingFields=async(...args)=>{const result=await send(...args);if(stop){stop=false;throw Error('synthetic checkpoint loss');}return result;};
 await assert.rejects(f.listing.complete(f.reference));const op=f.listing.completionOperations(f.draft.id)[0],resultId=op.rounds[0].candidate.resultId;op.rounds[0].candidate.resultId=null;f.ai.completionJournal.save(op);
 await f.listing.complete(f.reference);const after=f.listing.getCompletion(op.id);assert.equal(after.rounds[0].candidate.resultId,resultId);assert.equal(after.rounds[0].candidate.previous,undefined);assert.equal(f.requests.length,2);
});

test('unknown field cannot retry when its saved call owner is corrupt',async t=>{
 const f=await fixture(t);f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:'BLOCKED',previewIssues:[issue('material')]});f.respond(()=>{throw Error('synthetic unavailable');});await assert.rejects(f.listing.complete(f.reference));
 const op=f.listing.completionOperations(f.draft.id)[0],{openDatabase}=await import('../src/main/database.ts'),db=openDatabase(f.directory);
 try{const row=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(op.rounds[0].candidate.id)!,call=JSON.parse(String(row.record_json));call.presentationContext.draftId='00000000-0000-4000-8000-000000000099';db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(call),call.id);}finally{db.close();}
 await assert.rejects(f.listing.complete(f.reference),/证据无效/);assert.equal(f.requests.length,1);assert.equal(f.listing.getCompletion(op.id).rounds[0].candidate.previous,undefined);
});
