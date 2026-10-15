import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,chat} from './fixtures/listing-ai.ts';
import {parseFullGeneration,retainValidNativeCandidates} from '../src/main/listing-ai/full-schema.ts';
import {replayReferenceCandidates} from '../src/main/listing-ai/candidate-recovery.ts';
import {listingProblems} from '../src/main/listing-ai/problems.ts';
import {ListingAiService} from '../src/main/listing-ai/service.ts';
import {suggestListingFields} from '../src/main/ai/listing-adapters.ts';
const shape={type:'array',items:{type:'object',properties:{value:{anyOf:[{type:'string'},{type:'string',enum:['Wall Mount','Floor Mount']}]}}}};
test('reference replay requires surviving exact citations and never repairs an alien UUID',async t=>{
 const f=await fixture(t,{mounting_type:shape}),c=f.listing.currentContext(f.draft,f.product,0);
 const make=(ids:string[])=>parseFullGeneration({candidates:[{field:'mounting_type',nativeValue:[{value:'Clip-on'}],evidenceIds:ids}]},c);
 const rejected=make(['wrong-observation-uuid']);
 assert.equal(rejected.candidates.length,0);
 assert.equal(replayReferenceCandidates(rejected,c).candidates.length,0);
 assert.equal(replayReferenceCandidates(rejected,c,true).candidates.length,1,'legacy v1 reading reproduces its historical parser only');
 const valid=make([f.product.assets[0].id,'wrong-observation-uuid']);
 assert.equal(replayReferenceCandidates(valid,c).candidates.length,1);
 assert.deepEqual(replayReferenceCandidates(valid,c).candidates[0].items[0].evidenceIds,[f.product.assets[0].id]);
 const mixed={...valid,missing:[...valid.missing,...rejected.missing.map(m=>({...m,field:'unrecoverable'}))],rejectedCandidates:[...valid.rejectedCandidates!,...rejected.rejectedCandidates!.map(item=>({...item,field:'unrecoverable'}))]};
 const recovered=replayReferenceCandidates(mixed,c);
 assert.ok(recovered.missing.some(m=>m.field==='unrecoverable'&&m.reason.includes('[FIELD_REFERENCE]')));
 assert.ok(recovered.rejectedCandidates?.some(item=>item.field==='unrecoverable'));
});
test('composite color recovers only the same primary hue plus individually cited colors from one neutral SKU image',async t=>{
 const f=await fixture(t,{color:shape}),c=f.listing.currentContext(f.draft,f.product,0),asset=f.product.assets[0].id;
 c.evidence=[{id:'primary',name:'Color',value:'Green',meaning:'color',source:'source_confirmed'},...['Green','Off-White'].map((value,index)=>({id:`${c.variantId}:observation:${asset}:${index}`,name:index?'head color':'handle color',value,meaning:'general' as const,source:'image_observation' as const}))];
 const image={assetId:asset,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:['green','off-white'],observations:[{name:'handle color',values:['green'],visibility:'visible'},{name:'head color',values:['off-white'],visibility:'visible'}]};
 c.sourceProduct!.observations=[{variantId:c.variantId,images:[image]} as any];
 const raw={candidates:[{field:'color',nativeValue:[{value:'Green and Off-White'}],evidenceIds:c.evidence.map(e=>e.id)}]};
 const candidate=parseFullGeneration(raw,c),rejected={...candidate,candidates:[],rejectedCandidates:candidate.candidates,missing:[{field:'color',reason:'[SOURCE_VALUE_CONFLICT] legacy whole-value comparison'}]};
 assert.equal(replayReferenceCandidates(rejected,c).candidates.length,1);
 for(const [key,value] of [['lighting','uncertain'],['presentation','alternatives'],['visibility','occluded']] as const){
  const changed=structuredClone(c);(changed.sourceProduct!.observations![0].images[0] as any)[key]=value;
  assert.equal(retainValidNativeCandidates(parseFullGeneration(raw,changed),changed).candidates.length,0);
 }
 const human=structuredClone(c);human.evidence[0].source='human_confirmed';
 assert.equal(retainValidNativeCandidates(parseFullGeneration(raw,human),human).candidates.length,0);
 const finish=structuredClone(c);finish.sourceProduct!.observations![0].images[0].observations![1].name='metal finish';
 assert.equal(retainValidNativeCandidates(parseFullGeneration(raw,finish),finish).candidates.length,0);
 const wrong=structuredClone(raw);wrong.candidates[0].nativeValue[0].value='Red and Off-White';
 assert.equal(retainValidNativeCandidates(parseFullGeneration(wrong,c),c).candidates.length,0);
 const uncited=structuredClone(raw);uncited.candidates[0].evidenceIds=['primary'];
 assert.equal(retainValidNativeCandidates(parseFullGeneration(uncited,c),c).candidates.length,0);
});
test('full schema request explains open branches and keeps source primary color and compatibility boundaries',async t=>{
 const f=await fixture(t,{mounting_type:shape});
 let request:any;
 await suggestListingFields(f.listing.currentContext(f.draft,f.product,0),'deepseek-flash',{apiKey:'fixture'},new AbortController().signal,{fetch:async(_url,options)=>{request=JSON.parse(String(options?.body));return chat({kind:'amazon-fields',candidates:[],missing:[]});}});
 const instructions=request.messages[0].content;
 assert.match(instructions,/anyOf.*unrestricted string/i);
 assert.match(instructions,/primary SKU color/i);
 assert.match(instructions,/universal.*compatibility/i);
 const payload=JSON.parse(request.messages[1].content);
 assert.deepEqual(payload.fullSchema.schema.properties.mounting_type,shape);
});
test('output citation and format errors are system failures, not requests for missing product facts',async t=>{
 const f=await fixture(t);
 const issues=listingProblems({...f.draft,localIssues:[],previewIssues:[],listingIssues:[]},['item_name：[FIELD_REFERENCE] invalid observation ID','color：[FIELD_FORMAT] native JSON invalid','material：supplier did not supply material']);
 assert.deepEqual(issues.map(i=>i.kind),['system-failure','system-failure','needs-input']);
});
test('DONE retains unresolved output diagnostics without new calls or turning exhausted rounds into success',async t=>{
 const f=await fixture(t),listing=new ListingAiService(f.store,f.amazon,f.ai,()=>false),op=listing.beginCompletion(f.reference);
 op.state='DONE';op.remaining=['color：[FIELD_REFERENCE] invalid observation ID','item_name：[FIELD_REFERENCE] stale resolved title issue'];f.ai.completionJournal.save(op);
 const result=await listing.complete(f.reference,undefined,op.id);
 assert.ok(result.remaining.includes(op.remaining[0]),JSON.stringify(result.remaining));
 assert.equal(result.remaining.includes(op.remaining[1]),false);
 assert.equal(result.aiCalls,0);assert.equal(f.requests.length,0);
 assert.ok(result.issues.some(i=>i.kind==='system-failure'&&i.rawMessage===op.remaining[0]));
});
