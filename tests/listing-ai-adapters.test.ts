import test from 'node:test';
import assert from 'node:assert/strict';
import { parseListingGeneration } from '../src/main/ai/listing-adapters.ts';
test('normalizes only the observed JSON-mode envelope alias, without relaxing field or evidence validation',()=>{
 const raw={type:'json_object',candidates:[{field:'material',items:[{value:'Silicone',evidenceIds:['fact'],transformation:'translate'}]}],missing:[]};
 assert.equal(parseListingGeneration(raw).kind,'amazon-fields');
 assert.throws(()=>parseListingGeneration({...raw,apiKey:'extra'}));
 assert.throws(()=>parseListingGeneration({...raw,type:'tool_call'}));
 assert.throws(()=>parseListingGeneration({...raw,candidates:[{field:'brand',items:raw.candidates[0].items}]}));
});
