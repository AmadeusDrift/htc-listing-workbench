import test from 'node:test';
import assert from 'node:assert/strict';
import {assertImagePromptMeasurements,assertImageMeasurements} from '../src/main/image-workflow/image-facts.ts';
const empty={evidence:[]};
for(const direction of ['Camera look of an 85 mm lens','50 mm perspective','100 mm macro-style perspective','100 mm macro perspective','50 mm look','85 to 100 mm look','Camera: 35 to 50 mm look','Camera: 85 mm lens','85 mm lens look','35–50 mm perspective feel'])test(`photography direction is not a product measurement: ${direction}`,()=>{
 assert.doesNotThrow(()=>assertImagePromptMeasurements(`Photograph the reference product, ${direction}, natural light.`,empty));
 assert.throws(()=>assertImageMeasurements(direction,empty),e=>(e as any).reason==='UNSUPPORTED_MEASUREMENT','Captions and facts stay strict');
});
for(const prompt of ['Product length 3.50 mm look','Package width 3.50 mm look, product is red','Product length 3.5 mm perspective','Product lens focal length is 85 mm','An 85 mm lens','Camera product has an 85 mm lens','Package height is 99 cm','50 mm look, product is 99 cm tall','Product offers a 50 mm look','Camera: 50 mm lens with 99 cm package'])test(`unverified product claim remains rejected: ${prompt}`,()=>{
 assert.throws(()=>assertImagePromptMeasurements(prompt,empty),e=>(e as any).reason==='UNSUPPORTED_MEASUREMENT');
});
test('a photography span cannot erase a real measurement in the same prompt',()=>{
 const evidence=[{id:'dimension',name:'Product length',value:'3.5 cm',meaning:'general' as const,source:'source_confirmed' as const}];
 assert.doesNotThrow(()=>assertImagePromptMeasurements('Camera look of an 85 mm lens, product length 3.5 cm.',{evidence}));
 assert.throws(()=>assertImagePromptMeasurements('Camera look of an 85 mm lens, product length 35 cm.',{evidence}));
});
