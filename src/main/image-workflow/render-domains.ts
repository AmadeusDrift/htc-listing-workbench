import type {ImagePlanOutput,ProductImageContext} from '../../shared/image-ai-contracts.ts';
import {describesOtherObject,imageMeasurements,withoutImageMeasurements,withoutRenderExclusions} from './image-facts.ts';
/** Domain projection only; never mutates the stored model response or promotes observations to facts. */
export function imageRenderDomains(plan:ImagePlanOutput,context?:ProductImageContext){
 const prompt=withoutRenderExclusions(plan.prompt);
 return{renderRequirements:{prompt,expectedText:plan.expectedText},observations:{summary:plan.productUnderstanding?.summary??'',uncertainties:plan.productUnderstanding?.uncertainties??[]},
  exclusions:prompt===plan.prompt?[]:[plan.prompt],
  fitTargetDimensions:(context?.listing.evidence??[]).filter(e=>describesOtherObject(e.name+' '+e.value)&&imageMeasurements(e.value).length).map(e=>({id:e.id,name:e.name,value:e.value}))};
}
/** Numbers in visual observations carry no measurement authority. Omit their complete clauses
 * from the rendering handoff so "use the default" prose cannot survive number stripping. */
export function observationRenderingText(text:string):string{
 return text.split(/(?<=[;；。\n])|(?<!\d)\.(?!\d)/).map(clause=>imageMeasurements(clause).length?'[Unverified measurement observation retained separately; do not render a measurement.]':withoutImageMeasurements(clause)).join(' ').trim();
}
