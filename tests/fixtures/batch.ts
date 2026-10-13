import type test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { openDatabase } from '../../src/main/database.ts';
import { resolvePurpose } from '../../src/main/ai/purpose-routing.ts';
import { BatchService } from '../../src/main/ai/batch/service.ts';
import type { BatchOperation } from '../../src/shared/ai-batch-contracts.ts';

export function fixture(t:test.TestContext,fetcher:typeof fetch){
  const root=resolve('.test-data');mkdirSync(root,{recursive:true});const directory=mkdtempSync(join(root,'batch-')),db=openDatabase(directory);
  const credentialScope='a'.repeat(64),taskId=randomUUID();let closed=false;
  const close=()=>{if(!closed){closed=true;db.close();}};
  const service=new BatchService(db,directory,{fetch:fetcher,credential:()=>({apiKey:'batch-fixture-private-key',scope:credentialScope})});
  t.after(()=>{close();rmSync(directory,{recursive:true,force:true});});
  const operation=():BatchOperation=>({taskId,operationId:randomUUID(),attempt:1,phase:'copy',inputFingerprint:'b'.repeat(64),schemaFingerprint:'c'.repeat(64),credentialScope,owner:{productId:randomUUID(),productRevision:1,providerId:'openrouter' as const,generation:1},purpose:resolvePurpose(db,'listing_title'),body:{messages:[{role:'user',content:'Return JSON title'}],reasoning:{effort:'medium'},max_tokens:4096,response_format:{type:'json_object'}},references:[]});
  return{service,db,directory,operation,close};
}
