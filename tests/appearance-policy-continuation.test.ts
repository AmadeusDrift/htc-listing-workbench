import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {continueAppearancePolicy,runAppearanceReview,validateAppearanceCheckpoint} from '../src/main/image-workflow/appearance-review.ts';
import {initializePurposeProfiles,resolvePurpose} from '../src/main/ai/purpose-routing.ts';

function sample(){
 const candidate={id:randomUUID(),sha256:'a'.repeat(64),width:256,height:256},planResultId=randomUUID(),ref=randomUUID(),results=new Map<string,any>();
 const result=(verdict='UNCERTAIN',previousResultId:string|null=null,policyVersion?:string)=>{const r={id:randomUUID(),output:{kind:'image-appearance-review',...(policyVersion?{policyVersion}:{}),candidate,planResultId,previousResultId,verdict,checks:[{aspect:'count',expected:'50',observed:'one in use',reason:'Legacy pack proof',referenceAssetIds:[ref]}]}};results.set(r.id,r);return r;};
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE ai_profiles(id TEXT PRIMARY KEY,record_json TEXT)');initializePurposeProfiles(db);const snapshot=resolvePurpose(db,'appearance_review',{vision:true});db.close();
 const first=result(),second=result('UNCERTAIN',first.id),attempt:any={appearanceReview:{state:'DONE',candidate,planResultId,resultIds:[first.id,second.id],snapshot}};
 return {candidate,planResultId,result,results,first,second,attempt};
}

test('one policy continuation archives exact old identity and requires known old results',()=>{
 const f=sample(),before=structuredClone(f.attempt);let saves=0;
 const input={attempt:f.attempt,candidate:f.candidate,planResultId:f.planResultId,findResult:(id:string)=>f.results.get(id),assertKnown:()=>{throw Error('missing receipt');},save:()=>{saves++;}};
 assert.throws(()=>continueAppearancePolicy(input),/missing receipt/);assert.deepEqual(f.attempt,before);assert.equal(saves,0);
 f.attempt.appearanceReview.state='PENDING';f.attempt.appearanceReview.resultIds=[f.first.id];assert.throws(()=>continueAppearancePolicy({...input,assertKnown:()=>{}}),/未知/);assert.equal(f.attempt.appearanceReview.policyVersion,undefined);
 f.attempt.appearanceReview=structuredClone(before.appearanceReview);assert.equal(continueAppearancePolicy({...input,assertKnown:()=>{}}),true);assert.deepEqual(f.attempt.appearanceReview.previousPolicy,before.appearanceReview);assert.equal(saves,1);assert.equal(continueAppearancePolicy({...input,assertKnown:()=>{throw Error('must not inspect twice');}}),false);
 assert.deepEqual(validateAppearanceCheckpoint(f.attempt.appearanceReview),f.attempt.appearanceReview);
 for(const patch of [{basePreviousResultId:randomUUID()},{previousPolicy:{...before.appearanceReview,state:'PENDING'}},{previousPolicy:{...before.appearanceReview,previousPolicy:before.appearanceReview}},{candidate:{...f.candidate,sha256:'b'.repeat(64)}}])assert.throws(()=>validateAppearanceCheckpoint({...f.attempt.appearanceReview,...patch}));
});

test('legacy PENDING accepts only its stored original result and never sends or receives a new policy marker',async()=>{
 const f=sample();f.attempt.appearanceReview={state:'PENDING',candidate:f.candidate,planResultId:f.planResultId,resultIds:[],snapshot:{upgrade:null}};let sent=0;
 const input:any={enabled:true,attempt:f.attempt,candidate:f.candidate,planResultId:f.planResultId,getSnapshot:()=>{throw Error('must keep old snapshot');},save:()=>{},findResult:(id:string)=>f.results.get(id),send:async()=>{sent++;throw Error('must not send');}};
 await assert.rejects(runAppearanceReview(input),/原身份结果/);assert.equal(sent,0);assert.equal(f.attempt.appearanceReview.policyVersion,undefined);
 const late=f.result('PASS');assert.equal(await runAppearanceReview({...input,recover:()=>late}),'PASS');assert.equal(sent,0);assert.equal(f.attempt.appearanceReview.policyVersion,undefined);assert.equal(late.output.policyVersion,undefined);
});

test('v2 READY reuses exact stored result and PENDING stays locked across a changed current configuration',async()=>{
 const f=sample();f.attempt.appearanceReview={policyVersion:'appearance-review/v2',state:'READY',candidate:f.candidate,planResultId:f.planResultId,resultIds:[],snapshot:{upgrade:null}};let sent=0;
 const saved=f.result('PASS',null,'appearance-review/v2'),input:any={enabled:true,attempt:f.attempt,candidate:f.candidate,planResultId:f.planResultId,getSnapshot:()=>{throw Error('configuration must stay frozen');},save:()=>{},findResult:(id:string)=>f.results.get(id),recover:()=>saved,send:async()=>{sent++;throw Error('must not send');}};
 assert.equal(await runAppearanceReview(input),'PASS');assert.equal(sent,0);
 f.attempt.appearanceReview.state='PENDING';f.attempt.appearanceReview.resultIds=[];await assert.rejects(runAppearanceReview({...input,recover:()=>undefined}),/原身份结果/);assert.equal(sent,0);
});

test('v2 first review and configured upgrade keep the archived base and remain bounded on repeated continue',async()=>{
 const f=sample(),old=structuredClone(f.attempt.appearanceReview);f.attempt.appearanceReview={policyVersion:'appearance-review/v2',previousPolicy:old,basePreviousResultId:f.second.id,state:'READY',candidate:f.candidate,planResultId:f.planResultId,resultIds:[],snapshot:old.snapshot};let sends=0;
 const input:any={enabled:true,attempt:f.attempt,candidate:f.candidate,planResultId:f.planResultId,getSnapshot:()=>{throw Error('must keep original snapshot');},save:()=>{},findResult:(id:string)=>f.results.get(id),send:async(_snapshot:any,previous:string)=>{sends++;return f.result('UNCERTAIN',previous,'appearance-review/v2');}};
 assert.equal(await runAppearanceReview(input),'UNCERTAIN');assert.equal(sends,2);assert.equal(f.results.get(f.attempt.appearanceReview.resultIds[0]).output.previousResultId,f.second.id);assert.equal(await runAppearanceReview(input),'UNCERTAIN');assert.equal(sends,2);assert.deepEqual(f.attempt.appearanceReview.previousPolicy,old);
});
