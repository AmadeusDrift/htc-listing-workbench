import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readItemDiagnostic } from '../src/main/automatic-listing/item-diagnostic.ts';
import { completionSafetyIdentity } from '../src/main/listing-ai/completion-journal.ts';

test('unknown fields retain uncertainty and only exact same-sale original calls are displayed',()=>{
 const db=new DatabaseSync(':memory:');try{
  for(const name of ['listing_drafts','listing_completion_operations','ai_calls'])db.exec(`CREATE TABLE ${name}(id TEXT,record_json TEXT)`);
  const item:any={productId:'product',productRevision:1,variantId:'variant',sku:'SKU',draftId:'draft',stage:'IMAGES',outcome:{kind:'UNKNOWN'},repair:{remaining:['color：原结果待核对']}};
  const task:any={mode:'live',sellerId:'seller',marketplaceId:'US'};
  const draft:any={id:'draft',...task,productId:'product',productRevision:1,variantId:'variant',sku:'SKU',listingProgram:'haul',attributes:{color:[]},localIssues:[{severity:'ERROR',attributeNames:['color'],message:'颜色冲突'}],previewIssues:[],listingIssues:[]};
  db.prepare('INSERT INTO listing_drafts VALUES(?,?)').run('draft',JSON.stringify({draft}));
  const op={draftId:'draft',safetyIdentity:completionSafetyIdentity(draft),rounds:[{context:{draftId:'draft',productId:'product',variantId:'variant',sku:'SKU',fields:[{name:'color'}]},candidate:{id:'original',previous:[]},review:null}],reviewIssues:[]};
  db.prepare('INSERT INTO listing_completion_operations VALUES(?,?)').run('op',JSON.stringify(op));
  db.prepare('INSERT INTO listing_completion_operations VALUES(?,?)').run('foreign',JSON.stringify({...op,safetyIdentity:{...op.safetyIdentity,sku:'OTHER'},rounds:[{...op.rounds[0],candidate:{id:'foreign'}}]}));
  for(const id of ['original','foreign'])db.prepare('INSERT INTO ai_calls VALUES(?,?)').run(id,JSON.stringify({id,productId:'product',productRevision:1,status:'FAILED',errorCode:'CANCELLED',startedAt:'2026-10-15T08:00:00.000Z'}));
  const changes=db.prepare('SELECT total_changes() n').get()!.n;
  const diagnostic=readItemDiagnostic(db,task,item);
  assert.equal(diagnostic.resultUnknown,true);assert.deepEqual(diagnostic.requests.map(r=>r.id),['original']);
  assert.deepEqual(diagnostic.requests[0].fields,['color']);assert.equal(diagnostic.fields[0].name,'color');
  assert.match(diagnostic.note,/不能认定.*字段缺失/);assert.equal(db.prepare('SELECT total_changes() n').get()!.n,changes);
 }finally{db.close();}
});

test('missing original records remain explicitly unavailable rather than invented missing fields',()=>{
 const db=new DatabaseSync(':memory:');try{const result=readItemDiagnostic(db,{} as any,{draftId:'missing',outcome:{kind:'UNKNOWN'}} as any);assert.equal(result.resultUnknown,true);assert.equal(result.fields.length,0);assert.equal(result.requests.length,0);assert.match(result.note,/不可读/);}finally{db.close();}
});
