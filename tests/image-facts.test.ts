import test from 'node:test';
import assert from 'node:assert/strict';
import { assertImageMeasurements, imageMeasurements, imageListingSnapshot } from '../src/main/image-workflow/image-facts.ts';

test('business fallback measurements never enter image context or copy while actual measured facts remain',()=>{
  const value=[{value:0.22,unit:'pounds'}];
  const draft={attributes:{item_package_weight:value},businessRules:{fields:{item_package_weight:{value,reason:'业务默认；缺少实测值'}}}} as any;
  const listing={evidence:[{id:'material',name:'Material',value:'Silicone'},{id:'actual',name:'Measured diameter',value:'8 cm'}],unverifiedSourceTitle:'Coaster'} as any;
  const copy=[{field:'item_name',values:['Silicone coaster']},{field:'bullet_point',values:['Weight 100 g. Diameter 8 cm. Easy care.']} ] as any;
  const filtered=imageListingSnapshot(draft,listing,copy);
  assert.equal(JSON.stringify(filtered).includes('100 g'),false);
  assert.ok(JSON.stringify(filtered).includes('8 cm'));
  assert.equal(copy[1].values[0],'Weight 100 g. Diameter 8 cm. Easy care.');
});

test('focal-length wording remains a measurement in facts, source evidence and visible text',()=>{
  for(const text of ['50mm lens','50mm lens look','100mm macro lens look']){
    assert.equal(imageMeasurements(text).length,1);
    assert.throws(()=>assertImageMeasurements(text,{evidence:[]}));
  }
  const evidence=[{id:'lens',name:'Verified lens focal length',value:'50 mm',meaning:'general',source:'source_confirmed'}] as any;
  assert.doesNotThrow(()=>assertImageMeasurements('50mm lens',{evidence}));
  assert.throws(()=>assertImageMeasurements('100mm macro lens',{evidence}));
});
