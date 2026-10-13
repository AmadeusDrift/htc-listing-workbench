import {randomUUID} from 'node:crypto';
import {realAmazonSchema} from './fixtures/amazon/schema-fixture.ts';
import {saveInput} from './fixtures/listing-ai.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { AmazonService } from '../src/main/amazon/service.ts';
import { demoSchema } from '../src/main/amazon/demo.ts';
import type { JsonObject } from '../src/shared/amazon-contracts.ts';

async function fixture(t:test.TestContext, mode:'live'|'demo'='live') {
  mkdirSync('.test-data',{recursive:true});const directory=mkdtempSync(resolve('.test-data/preview-first-'));
  const store=new WorkspaceStore(directory), requests:{url:string;body:any}[]=[];
  const service=new AmazonService(directory,id=>store.getProduct(id),{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()}, {fetch:async(url,init)=>{
    if(String(url).includes('/auth/o2/token'))return Response.json({access_token:'FIXTURE_ACCESS',token_type:'bearer',expires_in:3600});
    const body=JSON.parse(String(init?.body));requests.push({url:String(url),body});
    return Response.json({sku:decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1)!),status:'INVALID',submissionId:'FIXTURE',issues:[{code:'90220',message:'Missing material',attributeNames:['material'],severity:'ERROR'}]});
  }});
  t.after(()=>{service.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const target=mode==='demo'?service.enableDemo():await service.importCredentials({name:'U8',sellerId:'FIXTURE_SELLER',marketplaceId:'ATVPDKIKX0DER',region:'na',locale:'en_US',clientId:'FIXTURE_CLIENT',clientSecret:'FIXTURE_SECRET',refreshToken:'FIXTURE_REFRESH'});
  const selection={targetId:target.id,productType:'FIXTURE_TYPE',parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'} as const;
  const snapshot=demoSchema(target,selection,Date.now());
  const field=(type:string,extra:JsonObject={})=>({type:'array',minItems:1,items:{type:'object',properties:{value:{type,...extra},marketplace_id:{type:'string'}},required:['value'],additionalProperties:false}});
  snapshot.schema={type:'object',properties:{is_value_stores_item:field('boolean'),purchasable_offer:{type:'array',minItems:1,items:{type:'object',properties:{audience:{type:'string',enum:['BZR']},marketplace_id:{type:'string'}},required:['audience']}},item_name:field('string'),material:field('string'),brand:field('string')},required:['is_value_stores_item','purchasable_offer','item_name','material'],additionalProperties:false};
  const realSchema=realAmazonSchema();snapshot.schema.$defs=realSchema.schema.$defs;snapshot.metaSchema=realSchema.metaSchema;
  const real=realSchema.schema.properties as JsonObject;
  (snapshot.schema.properties as JsonObject).purchasable_offer=real.purchasable_offer;
  (snapshot.schema.properties as JsonObject).item_package_weight=real.item_package_weight;
  (snapshot.schema.properties as JsonObject).item_package_dimensions=real.item_package_dimensions;
  service.getSchema=async()=>snapshot;
  let product=store.createProduct();product=store.saveProduct({...saveInput(product),facts:[{id:randomUUID(),name:'采购币种',value:'CNY',source:'manual',sourceRef:'Offline preview fixture',state:'human_confirmed'}],variants:saveInput(product).variants.map(v=>({...v,purchasePrice:'2.4'}))});
  const draft=await service.createDraft({...selection,listingProgram:'haul',productId:product.id,variantId:product.variants[0].id});
  return{service,requests,draft};
}

test('Haul missing business fields reach VALIDATION_PREVIEW without publishing',async t=>{
  const f=await fixture(t), result=await f.service.previewDraft(f.draft);
  assert.equal(f.requests.length,1);assert.equal(new URL(f.requests[0].url).searchParams.get('mode'),'VALIDATION_PREVIEW');
  assert.equal(result.state,'BLOCKED');assert.equal(result.previewIssues[0].code,'90220');assert.equal(result.submittedAt,null);
  await assert.rejects(f.service.submitDraft(result,true),/预览/);assert.equal(f.requests.length,1);
});
test('format errors remain local and incomplete demo previews cannot pretend success',async t=>{
  const f=await fixture(t), draft=f.service.saveDraft({...f.draft,attributes:{...f.draft.attributes,material:[{value:123}]}});
  await assert.rejects(f.service.previewDraft(draft),/本地校验/);assert.equal(f.requests.length,0);
  const demo=await fixture(t,'demo'), preview=await demo.service.previewDraft(demo.draft);
  assert.equal(preview.state,'BLOCKED');assert.equal(preview.previewedAt,null);assert.ok(preview.previewIssues.some(i=>i.source==='demo'));
});
test('nested required wrappers cannot masquerade as missing business fields',async t=>{
  const f=await fixture(t), draft=f.service.saveDraft({...f.draft,attributes:{...f.draft.attributes,brand:[{}]}});
  await assert.rejects(f.service.previewDraft(draft),/本地校验/);assert.equal(f.requests.length,0);
});
