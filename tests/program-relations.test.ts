import test from 'node:test';
import assert from 'node:assert/strict';
import { packageGraphIssues, authorizeRelationCandidates, PROGRAM_RELATION_FIELDS } from '../src/main/amazon/program-relations.ts';
import { fixture,chat } from './fixtures/listing-ai.ts';
import { parseFullGeneration } from '../src/main/listing-ai/full-schema.ts';
import { buildListingContext, listingModelPayload } from '../src/main/listing-ai/context.ts';
import { AmazonPersistence } from '../src/main/amazon/persistence.ts';
import { randomUUID } from 'node:crypto';

test('unsubmitted self cleanup requires historical AI proof, preserves receipts and invalidates preview',async t=>{
 const f=await fixture(t),p=(f.amazon as unknown as {persistence:AmazonPersistence}).persistence,r=p.record(f.draft.id),id=randomUUID();
 const edge=[{sku:r.draft.sku,marketplace_id:r.draft.marketplaceId,quantity:1}];r.draft.attributes.package_contains_sku=edge;r.draft.attributes.package_level=[{value:'unit'}];r.previewResponse={status:'INVALID',issues:[]};
 p.putRecord(r);assert.throws(()=>f.amazon.correctUnsubmittedSelfRelation({id:r.draft.id,revision:r.draft.revision}),/依据/);
 const adoption={id:'historic',fields:['package_contains_sku'],suggestionResultId:id,changes:[{field:'package_contains_sku',after:edge}]} as any;r.draft.fieldAdoptions=[adoption];
 p.db.prepare('INSERT INTO ai_results(id,record_json) VALUES(?,?)').run(id,JSON.stringify({id,listingContext:{draftId:r.draft.id},output:{kind:'amazon-fields',candidates:[{field:'package_contains_sku',nativeValue:edge}]}}));p.putRecord(r);
 const fixed=f.amazon.correctUnsubmittedSelfRelation({id:r.draft.id,revision:r.draft.revision});assert.equal(fixed.attributes.package_contains_sku,undefined);assert.deepEqual(fixed.fieldAdoptions,[adoption]);assert.deepEqual(p.record(r.draft.id).previewResponse,r.previewResponse);assert.equal(fixed.previewedAt,null);assert.equal(f.requests.length,0);
 assert.equal(p.db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='listing.self-package-corrected'").get()!.n,1);
});

const node=(sku:string,children:string[],sellerId='S')=>({sku,sellerId,marketplaceId:'M',attributes:{package_contains_sku:children.map(sku=>({sku,marketplace_id:'M',quantity:1}))}});
test('package graph rejects self and same-seller cycles independently from variation',()=>{
 assert.equal(packageGraphIssues(node('A',['A']),[])[0]?.code,'PACKAGE_SELF_REFERENCE');
 assert.equal(packageGraphIssues(node('A',['B']),[node('B',['A'])])[0]?.code,'PACKAGE_CYCLE');
 assert.deepEqual(packageGraphIssues(node('A',['B']),[node('B',['A'],'OTHER')]),[]);
 assert.deepEqual(packageGraphIssues({...node('A',[]),attributes:{package_level:[{value:'unit'}],child_parent_sku_relationship:[{parent_sku:'A'}]}},[]),[]);
});
test('current authorization omits program relations while historical parse and complete schema remain readable',async t=>{
 const f=await fixture(t,{package_level:{type:'array',items:{type:'object',properties:{value:{type:'string'},marketplace_id:{type:'string'}}}},package_contains_sku:{type:'array'}}),c=buildListingContext(f.draft,f.product,0);
 const raw={candidates:[{field:'package_level',nativeValue:[{value:'unit'}],evidenceIds:[]},{field:'package_contains_sku',nativeValue:[{sku:f.draft.sku,quantity:1}],evidenceIds:[]}]};
 const historical=parseFullGeneration(raw,c);assert.equal(historical.candidates.length,2);
 const current=authorizeRelationCandidates(historical);assert.equal(current.candidates.length,0);assert.equal(current.rejectedCandidates?.length,2);
 assert.equal(historical.candidates.length,2);const payload=listingModelPayload(c);assert.ok('fullSchema' in payload);assert.deepEqual(payload.fullSchema,c.fullSchema);
 assert.deepEqual(payload.programManagedRelationships,PROGRAM_RELATION_FIELDS);
});
test('new AI relation proposals are retained as rejected and never adopted',async t=>{
 const f=await fixture(t,{package_contains_sku:{type:'array'}});f.ai.saveFunctionSettings({id:'deepseek-review',model:'deepseek-v4-pro',enabled:false});
 f.respond(()=>chat({kind:'amazon-fields',contract:'listing-full-schema/v1',candidates:[{field:'package_contains_sku',nativeValue:[{sku:f.draft.sku,marketplace_id:f.draft.marketplaceId,quantity:1}],evidenceIds:[]}],missing:[]}));
 const result=await f.listing.suggest(f.reference);assert.equal(result.output.kind,'amazon-fields');if(result.output.kind!=='amazon-fields')throw Error('wrong kind');assert.equal(result.output.candidates.length,0);assert.equal(result.output.rejectedCandidates?.[0].field,'package_contains_sku');
 await assert.rejects(f.listing.adopt({...f.reference,suggestionResultId:result.id,reviewResultId:null,fields:['package_contains_sku']}),/程序管理/);assert.equal(f.amazon.getDraft(f.draft.id).attributes.package_contains_sku,undefined);assert.ok(f.ai.getResult(result.id));
});
