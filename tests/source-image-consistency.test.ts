import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { projectSourceClaims, reduceSourceConsistency, validateConsistencyOutput, assertConsistencyOutput } from '../src/main/source-image-consistency/comparison.ts';

const assetId=randomUUID();
function project(raw='Blue round',normalized=raw) {
  return projectSourceClaims([{id:'receipt.originalSpec',name:'spec',value:raw},{id:'variant.sourceSpec',name:'spec',value:raw},{id:'variant.originalSpec',name:'spec',value:raw},{id:'variant.normalizedSpec',name:'spec',value:normalized}]);
}
function observation(p:ReturnType<typeof project>,color='Blue',shape='Round') {
  return {kind:'source-image-consistency',assets:[{assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:[color],appearance:[shape],claims:p.claims.map(c=>({claimId:c.id,value:c.axis==='color'?color:shape,visibility:'visible'}))}]} as const;
}
test('host compares existing explicit Blue round against independent visible claims',()=>{
  const p=project(),o=validateConsistencyOutput(observation(p));
  assertConsistencyOutput(o,{claims:p.claims,referenceAssets:[{assetId}]} as never);
  assert.equal(reduceSourceConsistency(p,o).decision,'MATCH');
  assert.equal(reduceSourceConsistency(p,validateConsistencyOutput(observation(p,'Red','Square'))).decision,'MISMATCH');
});
test('raw versus normalized conflict cannot become a match or rewrite raw claims',()=>{
  const p=project('Red round','Blue round');
  assert.ok(p.issues.includes('RAW_NORMALIZED_CONFLICT'));
  assert.equal(reduceSourceConsistency(p,validateConsistencyOutput(observation(p))).decision,'UNCERTAIN');
  assert.ok(p.claims.some(c=>c.raw==='Red'&&c.value==='Red'));
});
test('same thumbnail with S/L and 10cm/20cm never verifies dimensions or mismatches style solely on size',()=>{
  for(const spec of ['Blue round S 10cm','Blue round L 20cm']) {
    const p=project(spec);assert.equal(p.claims.some(c=>(c.axis as string)==='size'),false);
    assert.equal(reduceSourceConsistency(p,validateConsistencyOutput(observation(p))).decision,'MATCH');
  }
  const p=project('S 10cm');assert.equal(reduceSourceConsistency(p,validateConsistencyOutput(observation(p))).decision,'UNCERTAIN');
});
test('low detail, occlusion, lighting and alternatives cannot acquire unchecked model PASS',()=>{
  const p=project();
  for(const change of [{quality:'low-detail'},{visibility:'occluded'},{lighting:'uncertain'},{presentation:'alternatives'}]) {
    const o=observation(p);assert.equal(reduceSourceConsistency(p,validateConsistencyOutput({...o,assets:[{...o.assets[0],...change}]})).decision,'UNCERTAIN');
  }
  assert.throws(()=>validateConsistencyOutput({...observation(p),verdict:'PASS'}));
});
test('random fulfillment and opaque style remain pending; actual striped multicolor is comparable',()=>{
  for(const spec of ['Blue random round','随机颜色','混色','款式 XZ-190','Color: Ocean Dream'])assert.equal(reduceSourceConsistency(project(spec),validateConsistencyOutput(observation(project(spec)))).decision,'UNCERTAIN');
  const p=project('Multicolor striped');assert.equal(reduceSourceConsistency(p,validateConsistencyOutput(observation(p,'Multicolor','Striped'))).decision,'MATCH');
  const shade=project('Off White round');assert.ok(shade.claims.some(c=>c.raw==='Off White'&&c.value==='White'&&c.rule==='color-family/v1'));
  assert.equal(project('Gold').claims.every(c=>c.axis==='color'),true);
});
test('exact claim and asset coverage rejects sibling IDs, order, duplicates and extra properties',()=>{
  const p=project(),o=observation(p),context={claims:p.claims,referenceAssets:[{assetId}]} as never;
  for(const value of [
    {...o,assets:[{...o.assets[0],assetId:randomUUID()}]},
    {...o,assets:[{...o.assets[0],claims:[...o.assets[0].claims].reverse()}]},
    {...o,assets:[{...o.assets[0],claims:o.assets[0].claims.slice(1)}]},
    {...o,assets:[{...o.assets[0],confidence:1}]},
  ]) assert.throws(()=>assertConsistencyOutput(validateConsistencyOutput(value),context));
});
test('negation and opaque identifiers cannot be promoted to positive appearance',()=>{
  for(const spec of ['不是蓝色','非红色','not blue','Blue XZ-190']){
    const p=project(spec);assert.equal(reduceSourceConsistency(p,validateConsistencyOutput(observation(p))).decision,'UNCERTAIN');
  }
  for(const spec of ['solid plastic','clear instructions'])assert.equal(project(spec).claims.length,0);
});
test('shape and pattern fields are compatible independent axes',()=>{
  const p=projectSourceClaims([{id:'shape',name:'形状',value:'Round'},{id:'pattern',name:'图案',value:'Striped'},{id:'normalized',name:'spec',value:'Round striped'}]);
  assert.deepEqual(p.issues,[]);
});

test('separate unknown visual fields cannot borrow another field supported color',()=>{
  for(const name of ['Pattern','Shape','spec','图案','形状']){
    const p=projectSourceClaims([{id:'color',name:'Color',value:'Blue'},{id:'unknown',name,value:'Rabbit'}]);
    const output=validateConsistencyOutput(observation(p));assertConsistencyOutput(output,{claims:p.claims,referenceAssets:[{assetId}]} as never);
    assert.equal(reduceSourceConsistency(p,output).decision,'UNCERTAIN',name);
    assert.ok(p.issues.includes('UNSUPPORTED_STYLE'),name);
  }
  for(const [name,value] of [['Size','L 20cm'],['Material','recycled polymer'],['spec','L 20cm'],['Country of origin','China']]){
    const p=projectSourceClaims([{id:'color',name:'Color',value:'Blue'},{id:'nonvisual',name,value}]);
    assert.equal(reduceSourceConsistency(p,validateConsistencyOutput(observation(p))).decision,'MATCH',name);
  }
});

test('unsupported substantive style cannot hide behind a supported color token',()=>{
  for(const spec of ['Blue rabbit','蓝色兔子款','Blue round rabbit']){
    const p=project(spec);assert.ok(p.issues.includes('UNSUPPORTED_STYLE'),spec);assert.equal(reduceSourceConsistency(p,validateConsistencyOutput(observation(p))).decision,'UNCERTAIN');
  }
  for(const spec of ['Blue round S 10cm','Blue round L 20cm','Blue silicone','Blue / material: recycled polymer / 10cm','蓝色 / 材质: 硅胶 / 20厘米'])assert.equal(reduceSourceConsistency(project(spec),validateConsistencyOutput(observation(project(spec)))).decision,'MATCH',spec);
  const material=projectSourceClaims([{id:'material',name:'Material',value:'Gold'}]);assert.equal(material.claims.length,0,'a material field does not become a color claim');
});
