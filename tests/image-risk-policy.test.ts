import { evaluateImageRisk } from '../src/shared/image-risk-policy.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { imageIpVerdict } from '../src/main/ai/image-validation.ts';
import { parseImageRiskSettings } from '../src/main/image-workflow/risk-settings.ts';
const labels=(score:number|null,label='tm_goods')=>[{label,confidence:score,description:''}];
test('W11 strict score boundary and independent high level',()=>{
 assert.equal(imageIpVerdict('medium',labels(90)),'PASS');
 assert.equal(imageIpVerdict('low',labels(90.1)),'BLOCKED');
 assert.equal(imageIpVerdict('high',labels(2)),'BLOCKED');
 assert.equal(imageIpVerdict('medium',labels(null)),'UNCERTAIN');
 assert.equal(imageIpVerdict('none',labels(99,'nonLabel_lib')),'PASS');
 assert.equal(imageIpVerdict('none',labels(99,'unknown')),'UNCERTAIN');
 assert.equal(imageIpVerdict('low',[...labels(2),...labels(95,'cartoon_ip')]),'BLOCKED');
});
test('W11 settings persist explicit thresholds and default legacy settings',()=>{
 assert.deepEqual(parseImageRiskSettings({enabled:true}),{enabled:true,scoreThreshold:90,levelThreshold:'high'});
 assert.deepEqual(parseImageRiskSettings({enabled:true,scoreThreshold:80,levelThreshold:'medium'}),{enabled:true,scoreThreshold:80,levelThreshold:'medium'});
 for(const scoreThreshold of [-1,101,NaN,'90'])assert.throws(()=>parseImageRiskSettings({enabled:true,scoreThreshold}));
});

test('W11 configurable score and level are OR; disabled is skipped and library semantics stay separate',()=>{
 const output={riskLevel:'medium' as const,labels:labels(70)};
 assert.equal(evaluateImageRisk(output,{enabled:true,scoreThreshold:80,levelThreshold:'medium'}).verdict,'BLOCKED');
 assert.equal(evaluateImageRisk(output,{enabled:true,scoreThreshold:60,levelThreshold:'high'}).verdict,'BLOCKED');
 assert.equal(evaluateImageRisk(output,{enabled:false,scoreThreshold:60,levelThreshold:'high'}).verdict,'SKIPPED');
 assert.equal(evaluateImageRisk({...output,labels:labels(95,'tm_goods_lib')}).verdict,'BLOCKED');
 const allow=evaluateImageRisk({...output,labels:labels(100,'nonLabel_lib')});assert.equal(allow.riskScore,null);assert.equal(allow.verdict,'PASS');
 assert.equal(evaluateImageRisk({...output,labels:labels(null,'nonLabel_lib')}).verdict,'UNCERTAIN');
 const missing=evaluateImageRisk({...output,labels:labels(null)});assert.equal(missing.riskScore,null);assert.equal(missing.verdict,'UNCERTAIN');
});
