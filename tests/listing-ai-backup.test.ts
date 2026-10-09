import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/listing-ai.ts';
import { assertListingHistory } from '../src/main/listing-ai/history.ts';
test('adopted history survives JSON serialization and rejects changed values or missing source records',async t=>{
  const f=await fixture(t),s=await f.listing.suggest(f.reference),r=await f.listing.review({...f.reference,suggestionResultId:s.id});
  const draft=await f.listing.adopt({...f.reference,suggestionResultId:s.id,reviewResultId:r.id,fields:['material']});
  const results=new Map([[s.id,s],[r.id,r]]),calls=new Map(f.ai.listCalls().map(c=>[c.id,c]));
  assertListingHistory(JSON.parse(JSON.stringify(draft)),results,calls);
  const bad=structuredClone(draft);(bad.fieldAdoptions![0].changes[0].after as any)[0].value='Cotton';assert.throws(()=>assertListingHistory(bad,results,calls));
  assert.throws(()=>assertListingHistory(draft,new Map(),calls));
});
