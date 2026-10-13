import { ListingAiService } from '../src/main/listing-ai/service.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/listing-ai.ts';
import { enumDecisionPlans } from '../src/main/ai/enum-decisions.ts';

const shape={type:'array',minItems:1,maxItems:2,uniqueItems:true,items:{type:'object',properties:{value:{type:'string',enum:['Indoor','Outdoor']}},required:['value'],additionalProperties:false}};
test('A20 real Listing completion routes missing enum to Decisions with ledger and original receipt',async t=>{
 const f=await fixture(t,{specific_uses_for_product:shape});
 f.ai.saveConnection({id:'openrouter',apiKey:'enum-fixture-or-key'});f.ai.setEnabled({id:'openrouter',enabled:true});
 f.ai.saveFunctionSettings({id:'deepseek-review',model:'deepseek-v4-pro',enabled:false});
 const sent:any[]=[];(f.ai as any).context.fetch=async(url:string,init:any)=>{const body=JSON.parse(init.body);sent.push({url,body});return new Response(JSON.stringify({id:'enum-original',answers:Object.fromEntries(Object.keys(body.questions).map((key,i)=>[key,{type:'choice',choice:i===0?'yes':'no'}])),usage:{input_tokens:10,output_tokens:3,cost:0.001}}));};
 f.amazon.previewDraft=async()=>{const d=f.amazon.getDraft(f.draft.id),missing=!d.attributes.specific_uses_for_product;return {...d,state:missing?'BLOCKED':'AMAZON_VALIDATED',previewIssues:missing?[{code:'MISSING',message:'Missing enum',severity:'ERROR',category:'field',source:'amazon',attributeNames:['specific_uses_for_product'],autoFixable:false}]:[]};};
 const result=await new ListingAiService(f.store,f.amazon,f.ai,()=>false).complete(f.reference);
 assert.deepEqual(result.remaining,[]);assert.deepEqual(result.draft.attributes.specific_uses_for_product,[{value:'Indoor'}]);
 assert.equal(sent.length,1);assert.ok(sent[0].url.endsWith('/api/alpha/decisions'));assert.equal(Object.keys(sent[0].body.questions).length,2);
 const call=f.ai.listCalls()[0];assert.equal(call.purposeSnapshot?.purposeId,'enum_decision');assert.equal(call.purposeSnapshot?.effectiveEffort,'not_applicable');assert.equal(call.requestId,'enum-original');
 assert.equal((f.ai as any).db.prepare('SELECT count(*) n FROM ai_usage_ledger').get().n,1);
});
test('A20 scope excludes ordinary suggestions, existing values and fixed rules',async t=>{
 const f=await fixture(t,{specific_uses_for_product:shape});const c=f.listing.currentContext(f.draft,f.product,0);
 assert.equal(enumDecisionPlans(c).length,0);c.repairRequest={issues:[{field:'specific_uses_for_product',code:'MISSING',message:'missing'}],currentValues:{}};
 assert.equal(enumDecisionPlans(c).length,1);c.currentAttributes!.specific_uses_for_product=[{value:'Manual'}];assert.equal(enumDecisionPlans(c).length,0);
 delete c.currentAttributes!.specific_uses_for_product;c.businessValues!.specific_uses_for_product=[{value:'Indoor'}];assert.equal(enumDecisionPlans(c).length,0);
});




for(const mode of ['unknown','both-not','both-oneOf','both-anyOf','valid-single','outside-single'] as const)test(`A20 real AiService enum response gate: ${mode}`,async t=>{
 const node:any=structuredClone(shape);
 if(mode.includes('single'))node.maxItems=1;
 if(mode==='both-not')node.not={minItems:2};
 if(mode==='both-oneOf')node.oneOf=[{contains:{properties:{value:{const:'Indoor'}}}},{contains:{properties:{value:{const:'Outdoor'}}}}];
 if(mode==='both-anyOf')node.anyOf=[{maxItems:1},{maxItems:0}];
 const f=await fixture(t,{specific_uses_for_product:node});f.ai.saveConnection({id:'openrouter',apiKey:'enum-fixture-gate-key'});f.ai.setEnabled({id:'openrouter',enabled:true});
 const c=f.listing.currentContext(f.draft,f.product,0);c.fields=c.fields.filter(v=>v.name==='specific_uses_for_product');c.repairRequest={issues:[{field:'specific_uses_for_product',code:'MISSING',message:'missing'}],currentValues:{specific_uses_for_product:null}};
 let requests=0;(f.ai as any).context.fetch=async(_url:string,init:any)=>{requests++;const body=JSON.parse(init.body);return new Response(JSON.stringify({id:'enum-gate-original',answers:Object.fromEntries(Object.keys(body.questions).map((key,i)=>[key,{type:'choice',choice:key.endsWith('_value')?(mode==='outside-single'?'invented':'v0'):mode==='unknown'&&i===1?'unknown':'yes'}])),usage:{input_tokens:10,output_tokens:4}}));};
 if(mode==='outside-single'){await assert.rejects(f.ai.listingFields(c,async()=>{}),{code:'OUTPUT_INVALID'});assert.equal(f.ai.listCalls()[0].status,'FAILED');}
 else{const result=await f.ai.listingFields(c,async()=>{});assert.equal(result.output.kind,'amazon-fields');const out=result.output as any;assert.equal(out.candidates.length,mode==='valid-single'?1:0);assert.equal(out.missing.length,mode==='valid-single'?0:1);}
 assert.equal(requests,1);const call=f.ai.listCalls()[0];assert.equal(call.purposeSnapshot?.purposeId,'enum_decision');
 const {readProviderReceipt}=await import('../src/main/ai/receipts.ts');const receipt:any=await readProviderReceipt((f.ai as any).db,f.directory,call.id);assert.equal(receipt.body.id,'enum-gate-original');assert.ok(receipt.body.answers);
});

test('A20 mixed repair uses one enum request plus its chat sibling and preserves attribution',async t=>{
 const f=await fixture(t,{specific_uses_for_product:shape});f.ai.saveConnection({id:'openrouter',apiKey:'mixed-enum-fixture-key'});f.ai.setEnabled({id:'openrouter',enabled:true});
 const c=f.listing.currentContext(f.draft,f.product,0);c.fields=c.fields.filter(v=>['specific_uses_for_product','material'].includes(v.name));delete c.currentAttributes!.material;c.repairRequest={issues:c.fields.map(v=>({field:v.name,code:'MISSING',message:'missing'})),currentValues:{material:null,specific_uses_for_product:null}};
 const transport=(f.ai as any).context,original=transport.fetch;let decisions=0;transport.fetch=async(url:string,init:any)=>{const body=JSON.parse(init.body);if(!body.questions)return original(url,init);decisions++;return new Response(JSON.stringify({id:'mixed-enum',answers:{f0_v0:{type:'choice',choice:'yes'},f0_v1:{type:'choice',choice:'no'}},usage:{input_tokens:5,output_tokens:2}}));};
 const result=await f.ai.listingFields(c,async()=>{});assert.equal(decisions,1);assert.equal(f.requests.length,1);assert.equal(result.fieldGroupAssembly?.sources.length,2);assert.equal((result.output as any).candidates.length,2);
 const calls=f.ai.listCalls();assert.equal(calls.filter(v=>v.purposeSnapshot?.purposeId==='enum_decision').length,1);assert.equal(calls.length,2);
});

test('A20 seven real purpose groups stop at quota then resume without duplicate paid siblings',async t=>{
 const f=await fixture(t,{specific_uses_for_product:shape,novel_feature:{type:'string'},generic_keyword:{type:'string'},bullet_point:{type:'array',items:{type:'string'}}});f.ai.saveConnection({id:'openrouter',apiKey:'seven-group-fixture-key'});f.ai.setEnabled({id:'openrouter',enabled:true});
 const ids=['listing_generation','listing_title','listing_bullets','listing_description','listing_search_terms','listing_repair'] as const,efforts=['none','low','medium','high','xhigh','max'] as const;
 for(const [i,id] of ids.entries()){const p=f.ai.getPurposeProfiles().find(p=>p.purposeId===id)!;f.ai.savePurposeProfile({purposeId:id,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-luna',effort:efforts[i]}});}
 const c=f.listing.currentContext(f.draft,f.product,0);c.fields=c.fields.filter(v=>['specific_uses_for_product','novel_feature','item_name','bullet_point','product_description','generic_keyword','material'].includes(v.name));c.repairRequest={issues:c.fields.map(v=>({field:v.name,code:'MISSING',message:'missing'})),currentValues:{material:[{value:'Silicone'}]}};
 let posts=0;(f.ai as any).context.fetch=async(_url:string,init:any)=>{posts++;const body=JSON.parse(init.body);if(body.questions)return new Response(JSON.stringify({id:'seven-enum',answers:{f0_v0:{type:'choice',choice:'yes'},f0_v1:{type:'choice',choice:'no'}},usage:{input_tokens:1,output_tokens:1}}));const payload=JSON.parse(body.messages[1].content);return new Response(JSON.stringify({id:'seven-chat',choices:[{finish_reason:'stop',message:{content:JSON.stringify({kind:'amazon-fields',contract:'listing-full-schema/v1',candidates:[],missing:payload.fields.map((v:any)=>({field:v.name,reason:'Unknown in fake service'}))})}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));};
 f.ai.setUsagePolicy({providerId:'openrouter',dailyCallLimit:6,dailyTokenLimit:null});await assert.rejects(f.ai.listingFields(c,async()=>{}),{code:'QUOTA_EXCEEDED'});assert.equal(posts,6);
 f.ai.setUsagePolicy({providerId:'openrouter',dailyCallLimit:7,dailyTokenLimit:null});const result=await f.ai.listingFields(c,async()=>{});assert.equal(posts,7);assert.equal(result.fieldGroupAssembly?.sources.length,7);assert.equal(f.ai.listCalls().length,7);assert.equal(f.ai.getResult(result.id)?.id,result.id);
});
