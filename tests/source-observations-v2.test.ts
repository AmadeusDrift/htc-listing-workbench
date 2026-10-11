import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { projectSourceClaims, validateConsistencyOutput, assertConsistencyOutput, reduceSourceConsistency, normalizeSourceObservations } from '../src/main/source-image-consistency/comparison.ts';

const assetId=randomUUID();
const projection=projectSourceClaims([{id:'model',name:'型号',value:'XZ-190'}]);
const output={kind:'source-image-consistency',version:'source-image-consistency/v2',assets:[{assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:['Teal','Cream'],appearance:['Frog-shaped'],claims:[{claimId:'new-visual-observation',value:'Frog-shaped',visibility:'visible'}],observations:[{name:'shape',values:['Frog-shaped'],visibility:'visible'}]}]};
test('independent observations preserve free visible values with opaque supplier model and additional claims',()=>{
  const parsed=validateConsistencyOutput(output);
  assertConsistencyOutput(parsed,{claims:projection.claims,referenceAssets:[{assetId}]} as never);
  assert.equal(reduceSourceConsistency(projection,parsed).decision,'MATCH');
  assert.deepEqual(parsed.assets[0].colors,['Teal','Cream']);
});
test('v2 explicit contradiction is attributed to a field, without rejecting the whole product',()=>{
  const p=projectSourceClaims([{id:'color',name:'color',value:'Blue'}]);
  const parsed=validateConsistencyOutput({...output,assets:[{...output.assets[0],claims:[{claimId:p.claims[0].id,value:'Red',visibility:'visible'}]}]});
  const result=reduceSourceConsistency(p,parsed);
  assert.equal(result.decision,'MATCH');
  assert.ok(result.reasons.includes(`VISIBLE_CONTRADICTION:${p.claims[0].id}`));
});
test('legacy strict parsing and reduction retain their stored history semantics',()=>{
  const legacy={kind:'source-image-consistency',assets:[{assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:['Blue'],appearance:['Round'],claims:[]}]};
  assert.equal(reduceSourceConsistency(projection,validateConsistencyOutput(legacy)).decision,'UNCERTAIN');
  assert.throws(()=>validateConsistencyOutput({...legacy,assets:[{...legacy.assets[0],appearance:['Frog-shaped']}]}));
});
test('provider shell and observations-only output normalize without inventing claims or losing asset identity',()=>{
  const {colors,appearance,claims,...asset}=output.assets[0];
  const parsed=normalizeSourceObservations({type:'json_object',assets:[asset]},{claims:[],referenceAssets:[{assetId}]} as never);
  assert.deepEqual(parsed.assets[0].claims,[]);assert.deepEqual(parsed.assets[0].colors,[]);assert.deepEqual(parsed.assets[0].observations,asset.observations);
  assert.throws(()=>normalizeSourceObservations({type:'json_object',assets:[{...asset,assetId:randomUUID()}]},{claims:[],referenceAssets:[{assetId}]} as never));
});
