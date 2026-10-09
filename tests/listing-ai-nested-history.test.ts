import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fixture, saveInput, chat, reviewFor } from './fixtures/listing-ai.ts';
import { assertListingHistory } from '../src/main/listing-ai/history.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import { openDatabase } from '../src/main/database.ts';
import type { JsonObject } from '../src/shared/amazon-contracts.ts';

test('nested blade adoption retains existing non-AI siblings in history and encrypted backup',async t=>{
  const blade:JsonObject={type:'array',items:{type:'object',properties:{marketplace_id:{type:'string'},length:{type:'number'},material:{type:'array',items:{type:'object',properties:{value:{type:'string'},language_tag:{type:'string'}},required:['value','language_tag']}}},required:['material','marketplace_id'],additionalProperties:false}};
  const f=await fixture(t,{blade}),input=saveInput(f.product);
  const product=f.store.saveProduct({...input,facts:[...input.facts,{id:randomUUID(),name:'刀片材质',value:'金属',source:'manual',sourceRef:'fixture',state:'human_confirmed'}]});
  let draft=await f.amazon.createDraft({productId:product.id,variantId:product.variants[0].id,targetId:f.draft.targetId,productType:f.draft.schema.productType,parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'});
  draft=f.amazon.saveDraft({id:draft.id,revision:draft.revision,attributes:{...draft.attributes,blade:[{material:[{value:'Original value',language_tag:'en_US'}],length:12,marketplace_id:draft.marketplaceId}]}});
  f.respond(payload=>chat(payload.candidate?reviewFor(payload):{kind:'amazon-fields',candidates:[{field:'blade',items:[{value:'Metal',evidenceIds:[payload.evidence.find((e:{name:string})=>e.name==='刀片材质').id],transformation:'translate'}]}],missing:payload.fields.filter((field:{name:string})=>field.name!=='blade').map((field:{name:string})=>({field:field.name,reason:'No candidate in this fixture.'}))}));
  const ref={draftId:draft.id,draftRevision:draft.revision},suggestion=await f.listing.suggest(ref),review=await f.listing.review({...ref,suggestionResultId:suggestion.id});
  const adopted=await f.listing.adopt({...ref,suggestionResultId:suggestion.id,reviewResultId:review.id,fields:['blade']});
  assert.deepEqual(adopted.attributes.blade,[{material:[{value:'Metal',language_tag:'en_US'}],length:12,marketplace_id:draft.marketplaceId}]);
  const results=new Map(f.ai.listResults(product.id).map(result=>[result.id,result])),calls=new Map(f.ai.listCalls().map(call=>[call.id,call]));
  assert.doesNotThrow(()=>assertListingHistory(adopted,results,calls));
  for(const key of ['before','after'] as const){const changed=structuredClone(adopted);(changed.fieldAdoptions![0].changes[0][key] as JsonObject[])[0].length=999;assert.throws(()=>assertListingHistory(changed,results,calls));}
  const backup=join(f.directory,'nested-history.htcbackup'),directory=join(f.directory,'restored-nested-history');
  await createWorkspaceBackup(f.directory,backup,'isolated nested history passphrase');
  await commitWorkspaceRestore(directory,await prepareWorkspaceRestore(directory,backup,'isolated nested history passphrase'));
  const restored=openDatabase(directory);try{const record=JSON.parse(String(restored.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(adopted.id)!.record_json));assert.deepEqual(record.draft.fieldAdoptions,adopted.fieldAdoptions);}finally{restored.close();}
});
