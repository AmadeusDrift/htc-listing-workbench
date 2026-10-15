import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {categoryOperationId,categoryCandidateSnapshot} from '../src/main/ai/category-context.ts';
import {listingFingerprint} from '../src/main/json-fingerprint.ts';
const records=await import('../src/main/ai/category-operation-records.ts').catch(()=>null);
const at='2026-10-15T00:00:00.000Z',later='2026-10-15T00:00:01.000Z';
function fixture(){const productId=randomUUID(),operationId=categoryOperationId(productId),targetId='synthetic-target',query='cloth';return{productId,operationId,repair:{version:1,operationId,phase:'judge',originalCallIds:[randomUUID()],retryCallId:randomUUID(),inputVersion:'a'.repeat(64),candidateSnapshotSha256:'b'.repeat(64),continuedAt:at},expansion:{version:1,operationId,inputVersion:'a'.repeat(64),originalDecisionId:randomUUID(),originalCallId:randomUUID(),fromCandidateSnapshotSha256:'b'.repeat(64),claimedAt:at,requestId:randomUUID(),targetId,query,requestSha256:listingFingerprint({method:'GET',targetId,query}),permittedAt:null,snapshot:null}};}
test('category operation repair is immutable once per product-root phase rather than per revision or credential',()=>{
 assert.ok(records,'Category operation records missing');const f=fixture(),base=records.newCategoryOperation(f.productId),claimed=records.addCategoryRepair(base,f.repair);
 assert.deepEqual(base.repairs,[]);assert.equal(claimed.id,f.operationId);assert.equal(claimed.repairs.length,1);
 assert.throws(()=>records.addCategoryRepair(claimed,{...f.repair,retryCallId:randomUUID(),inputVersion:'c'.repeat(64)}));
 assert.throws(()=>records.addCategoryRepair(base,{...f.repair,operationId:randomUUID()}));
 assert.throws(()=>records.addCategoryRepair(base,{...f.repair,originalCallIds:[f.repair.retryCallId]}));
 assert.deepEqual(records.mergeCategoryOperations(base,claimed),claimed);assert.deepEqual(records.mergeCategoryOperations(claimed,base),claimed);
 assert.throws(()=>records.mergeCategoryOperations(claimed,records.addCategoryRepair(base,{...f.repair,continuedAt:later})));
});
test('an expansion with no snapshot consumes its one allowance and an external permit cannot be granted twice',()=>{
 assert.ok(records);const f=fixture(),claimed=records.addCategoryExpansion(records.newCategoryOperation(f.productId),f.expansion);
 assert.equal(claimed.expansion.snapshot,null);assert.throws(()=>records.addCategoryExpansion(claimed,{...f.expansion,requestId:randomUUID()}));
 const permitted=records.permitCategoryExpansion(claimed,f.expansion.requestId,later);assert.equal(permitted.expansion.permittedAt,later);
 assert.throws(()=>records.permitCategoryExpansion(permitted,f.expansion.requestId,later));assert.throws(()=>records.permitCategoryExpansion(claimed,randomUUID(),later));
 assert.deepEqual(records.mergeCategoryOperations(claimed,permitted),permitted);assert.deepEqual(records.mergeCategoryOperations(permitted,claimed),permitted);
});
test('expanded actual candidates keep their ordered fingerprint and receipt identity through an older restore',()=>{
 assert.ok(records);const f=fixture(),base=records.newCategoryOperation(f.productId),claimed=records.addCategoryExpansion(base,f.expansion),permitted=records.permitCategoryExpansion(claimed,f.expansion.requestId,at);
 const candidates=[{name:'CLEANING_CLOTH',displayName:'Cleaning cloth'},{name:'DISH',displayName:'Dish'}],evidence=candidates.map(candidate=>({name:candidate.name,hitKeywords:['cloth'],sources:['platform']}));
 const snapshot={version:1,candidates,evidence,candidateSnapshotSha256:categoryCandidateSnapshot(candidates),sha256:listingFingerprint({candidates,evidence}),requestId:f.expansion.requestId,receiptSha256:'d'.repeat(64),receivedAt:later};
 const completed=records.completeCategoryExpansion(permitted,snapshot);assert.deepEqual(records.mergeCategoryOperations(base,completed),completed);assert.deepEqual(records.mergeCategoryOperations(completed,claimed),completed);
 assert.throws(()=>records.completeCategoryExpansion(permitted,{...snapshot,candidateSnapshotSha256:'e'.repeat(64)}));
 assert.throws(()=>records.completeCategoryExpansion(permitted,{...snapshot,requestId:randomUUID()}));
 assert.throws(()=>records.completeCategoryExpansion(claimed,snapshot));
 assert.throws(()=>records.mergeCategoryOperations(completed,records.completeCategoryExpansion(permitted,{...snapshot,receiptSha256:'e'.repeat(64)})));
});
test('category operation strict reader rejects extra fields, getters, malformed claims and forged root identities',()=>{
 assert.ok(records);const f=fixture(),base=records.newCategoryOperation(f.productId);let getters=0;
 const getter={...base};Object.defineProperty(getter,'productId',{enumerable:true,get(){getters++;return f.productId;}});
 for(const raw of [{...base,revision:2},{...base,id:randomUUID()},{...base,repairs:[{...f.repair,phase:['judge']}]},{...base,repairs:[{...f.repair,originalCallIds:[f.repair.originalCallIds[0],f.repair.originalCallIds[0]]}]},getter])assert.throws(()=>records.parseCategoryOperation(raw));
 assert.equal(getters,0);assert.deepEqual(records.parseCategoryOperation(base),base);
});
test('sparse or accessor arrays cannot create an unreadable safety claim or run a getter',()=>{
 assert.ok(records);const f=fixture(),base=records.newCategoryOperation(f.productId);let getters=0;const accessor=new Array(1);Object.defineProperty(accessor,'0',{enumerable:true,get(){getters++;return f.repair;}});
 assert.throws(()=>records.parseCategoryOperation({...base,repairs:accessor}));
 assert.throws(()=>records.addCategoryRepair(base,{...f.repair,originalCallIds:new Array(1)}));
 assert.throws(()=>records.parseCategoryOperation({...base,repairs:new Array(1)}));assert.equal(getters,0);
});
test('an empty expanded response is a received snapshot and identical local collection is idempotent',()=>{
 assert.ok(records);const f=fixture(),claimed=records.addCategoryExpansion(records.newCategoryOperation(f.productId),f.expansion),permitted=records.permitCategoryExpansion(claimed,f.expansion.requestId,at),candidates:never[]=[],evidence:never[]=[];
 const snapshot={version:1,candidates,evidence,candidateSnapshotSha256:categoryCandidateSnapshot(candidates),sha256:listingFingerprint({candidates,evidence}),requestId:f.expansion.requestId,receiptSha256:'d'.repeat(64),receivedAt:later};
 const completed=records.completeCategoryExpansion(permitted,snapshot);assert.deepEqual(completed.expansion.snapshot!.candidates,[]);assert.deepEqual(records.completeCategoryExpansion(completed,snapshot),completed);
 assert.throws(()=>records.completeCategoryExpansion(completed,{...snapshot,receiptSha256:'e'.repeat(64)}));
});
