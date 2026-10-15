import type {DatabaseSync} from 'node:sqlite';
import type {AiCall} from '../../shared/ai-contracts.ts';
import type {CategoryDecision} from '../../shared/category-ai-contracts.ts';
import type {ProductTypeOption} from '../../shared/amazon-contracts.ts';
import {verifiedRecoveryReceipt} from './receipt-recovery.ts';
import {categoryDecision} from './category-adapter.ts';

/** Decode the verified original response through the current category adapter.
 * The private fetch returns local bytes only: no credential lookup, reservation,
 * provider request, receipt rewrite, result insertion or adoption occurs here. */
export async function parseOriginalCategoryReceipt(db:DatabaseSync,directory:string,call:AiCall,payload:{phase:CategoryDecision['phase'];candidates:ProductTypeOption[];[key:string]:unknown}):Promise<CategoryDecision|null>{
 const saved=verifiedRecoveryReceipt(db,directory,call);if(!saved||!call.categoryContext||call.categoryContext.phase!==payload.phase||!call.purposeSnapshot)return null;
 try{
  const expected=(saved.record.gateway==='openrouter'?'https://openrouter.ai':'https://api.deepseek.com')+saved.record.endpoint;
  const reply=await categoryDecision(payload,{apiKey:'local-receipt-read-only'},new AbortController().signal,{
   fetch:async(url,init)=>{if(String(url)!==expected||init?.method!=='POST')throw Error('LOCAL_RECEIPT_ENDPOINT_MISMATCH');return Response.json(saved.capture.body,{status:saved.record.status});},
   now:()=>new Date(call.finishedAt!),nonce:()=>'',maxResponseBytes:200*1024*1024,gateway:call.purposeSnapshot.gateway,effectiveEffort:call.purposeSnapshot.effectiveEffort,purposeSnapshot:call.purposeSnapshot,
  },[]);
  return reply.output;
 }catch{return null;}
}
