import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {openDatabase} from '../src/main/database.ts';
import {transaction} from '../src/main/application/transaction.ts';
import {AiSpendBudget,assertSpendHistory} from '../src/main/ai/spend-budget.ts';
import {saveProviderReceipt} from '../src/main/ai/receipts.ts';
import {imageSpendBound,priceEvidence} from '../src/main/ai/spend-records.ts';
import {prepareImageSpendReceiptProof,readImageSpendReceiptProof} from '../src/main/ai/spend-receipts.ts';
import type {ProviderReceiptCapture} from '../src/main/ai/transport.ts';

const model='openai/gpt-image-2.5-sunburst',hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const cases:[string,unknown,number,'SENT_UNKNOWN'|'RECEIVED_INVALID'|'DEFINITIVE_REJECTION'][]=[
 ['processing error zero',{error:{code:502,message:'Synthetic processing failure'},usage:{cost:0}},0,'SENT_UNKNOWN'],
 ['choice processing error',{choices:[{error:{code:502,message:'Synthetic processing failure'}}],usage:{cost:.01}},.01,'SENT_UNKNOWN'],
 ['omitted body','[omitted: credential echo]',0,'SENT_UNKNOWN'],
 ['missing body',undefined,0,'SENT_UNKNOWN'],
 ['complete invalid scalar',null,.02,'RECEIVED_INVALID'],
];
for(const [label,body,cost,certainty] of cases)test(`private ${label} keeps reported money separate from unresolved exposure`,async()=>{
 await mkdir(resolve('.test-data'),{recursive:true});const root=await mkdtemp(resolve('.test-data/s08-receipt-')),db=openDatabase(root),budget=new AiSpendBudget(db),id=randomUUID(),request=JSON.stringify({model,n:1}),now=new Date(),quote=imageSpendBound(request,priceEvidence(model,{id:model,endpoints:[{pricing:[{billable:'output_image',unit:'image',cost_usd:.04}]}]},now),now.toISOString())!;
 try{budget.setImagePolicy(100_000);transaction(db,()=>budget.reserveInTransaction(db,{id,businessKey:hash(id),requestSha256:hash(request),model,purpose:'image_generation',scopeId:null},request,quote));
 const capture={gateway:'openrouter' as const,endpoint:'/api/v1/images',model,status:200,requestId:null,receivedAt:new Date().toISOString(),costUsd:cost,...(body===undefined?{}:{body})} as ProviderReceiptCapture,record=await saveProviderReceipt(db,root,id,capture,undefined),proof=prepareImageSpendReceiptProof(record,capture);assert.equal(proof.certainty,certainty);assert.deepEqual(readImageSpendReceiptProof(db,root,record.id),proof);
 transaction(db,()=>budget.settleReceiptInTransaction(db,id,record.id,proof));const summary=budget.summary('image-generation-daily');assert.equal(summary.reportedUsdMicros,cost*1_000_000);assert.equal(summary.heldUsdMicros,certainty==='SENT_UNKNOWN'?40_000-cost*1_000_000:0);assert.equal(summary.reportedUsdMicros+summary.heldUsdMicros,certainty==='SENT_UNKNOWN'?40_000:cost*1_000_000);assertSpendHistory(db,root);
 assert.throws(()=>transaction(db,()=>readImageSpendReceiptProof(db,root,record.id)));assert.throws(()=>transaction(db,()=>budget.settleReceiptInTransaction(db,id,record.id,{...proof,certainty:'RECEIVED_VALID'})));assert.equal(budget.list()[0].state,certainty==='SENT_UNKNOWN'?'UNKNOWN':'SETTLED');
 }finally{db.close();await rm(root,{recursive:true,force:true});}
});
