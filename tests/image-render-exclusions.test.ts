import test from 'node:test';
import assert from 'node:assert/strict';
import {assertImagePromptMeasurements} from '../src/main/image-workflow/image-facts.ts';
const empty={evidence:[]};
for(const text of ['Do not render weight 100 g.','不要绘制重量100 g。','Do not show dimensions 5 x 5 x 5 cm; preserve shape.'])test(`F02 negative rendering: ${text}`,()=>assert.doesNotThrow(()=>assertImagePromptMeasurements(text,empty)));
for(const text of ['Do not render weight 100 g; product length 99 cm.','不要绘制重量100 g；商品长度99 cm。','Render weight 100 g.','Do not render weight 100 g and show product length 99 cm.'])test(`F02 adjacent positive stays strict: ${text}`,()=>assert.throws(()=>assertImagePromptMeasurements(text,empty)));
import {imageRenderDomains,observationRenderingText} from '../src/main/image-workflow/render-domains.ts';
import {imageEvidence} from '../src/main/image-workflow/image-facts.ts';
test('F02 render requirements, observations, exclusions and fit-target sizes remain separate',()=>{
 const plan:any={prompt:'Do not render weight 100 g.',expectedText:[],productUnderstanding:{summary:'Looks about 8 cm.',uncertainties:['Use default 5 cm.']}};
 const context:any={listing:{evidence:[{id:'fit',name:'Fits phone',value:'15 cm'},{id:'real',name:'Product length',value:'9 cm'}]}};
 const before=JSON.stringify(plan),domains=imageRenderDomains(plan,context);assert.equal(JSON.stringify(plan),before);assert.equal(domains.observations.summary,'Looks about 8 cm.');assert.equal(domains.exclusions.length,1);assert.equal(domains.fitTargetDimensions[0].id,'fit');assert.doesNotMatch(domains.renderRequirements.prompt,/100 g/);assert.doesNotMatch(observationRenderingText(domains.observations.uncertainties[0]),/Use default|5 cm/);assert.deepEqual(imageEvidence(context).map(e=>e.id),['real']);
});
for(const text of ['Do not render weight 100 grams.','Do not show dimensions 5 cm, preserve product shape.','不要画重量100克，保持原外观。','Do not render weight 100 grams, do not show dimensions 5 centimeters.'])test(`F02 full units and comma exclusion: ${text}`,()=>assert.doesNotThrow(()=>assertImagePromptMeasurements(text,empty)));
for(const text of ['Do not render weight 100 grams, product length 99 centimeters.','不要画重量100克，商品长度99厘米。','Do not show dimensions 5 cm, render weight 100 grams.','Do not show dimensions 5 centimeters and display product length 99 cm.'])test(`F02 comma leaves positive claims strict: ${text}`,()=>assert.throws(()=>assertImagePromptMeasurements(text,empty)));
