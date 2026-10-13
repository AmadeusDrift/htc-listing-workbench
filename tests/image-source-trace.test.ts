import test from 'node:test';
import assert from 'node:assert/strict';
import {imageSourceTrace} from '../src/main/image-workflow/source-trace.ts';
test('P3 unknown visual observation retains selected specification, actual sent references and receipt owner',()=>{
 const result:any={id:'result',callId:'call',imageRequestBytes:4500,imageContext:{listing:{sourceProduct:{selectedSku:{originalSpec:'Selected blue 1 pc'}},evidence:[]},referenceAssets:[{assetId:'reference',sha256:'hash',variantId:'variant'}]},output:{kind:'image-plan',prompt:'',expectedText:[],productUnderstanding:{summary:'Cannot determine texture',sufficient:false,referenceAssetIds:['reference'],uncertainties:['Lighting']}}};
 const trace=imageSourceTrace({sku:'SALE',variantId:'variant',referenceAssets:[],setPlanResultId:'result'} as any,()=>result,()=>({id:'call',providerReceiptId:'receipt'} as any));
 assert.equal(trace.transport,'sent');assert.equal(trace.referenceAssets.length,1);assert.equal(trace.modelObservation?.sufficient,false);assert.deepEqual(trace.selectedSku.specification,{originalSpec:'Selected blue 1 pc'});assert.equal(trace.providerReceiptId,'receipt');
});
