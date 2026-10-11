import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/listing-ai.ts';
import { buildListingContext } from '../src/main/listing-ai/context.ts';
import { imageListingContextsMatch } from '../src/main/image-workflow/context-compatibility.ts';

test('Haul image compatibility ignores proven listing rules and cleanup, retaining actual product boundaries',async t=>{
  const f=await fixture(t),base=buildListingContext(f.draft,f.product,0);base.listingProgram='haul';
  base.currentAttributes!.merchant_suggested_asin=[];
  const next=structuredClone(base);delete next.currentAttributes!.merchant_suggested_asin;
  for(const field of ['manufacturer','item_package_weight','model_number']){next.currentAttributes![field]=[{value:field==='item_package_weight'?0.22:'RULE'}];next.businessValues![field]=structuredClone(next.currentAttributes![field]);}
  const before=JSON.stringify([base,next]);assert.equal(imageListingContextsMatch(base,next),true);assert.equal(JSON.stringify([base,next]),before);
  const equalOld=structuredClone(base);equalOld.currentAttributes!.manufacturer=next.currentAttributes!.manufacturer;
  assert.equal(imageListingContextsMatch(equalOld,next),true,'unchanged attribute need not have an old default report');
  for(const field of ['color','material','number_of_items','unit_count']){
    const changed=structuredClone(next);changed.currentAttributes![field]=[{value:'changed'}];changed.businessValues![field]=changed.currentAttributes![field];assert.equal(imageListingContextsMatch(base,changed),false,field);
  }
  const manual=structuredClone(base);manual.currentAttributes!.model_number=[{value:'MANUAL'}];assert.equal(imageListingContextsMatch(manual,next),false);
  const changedSource=structuredClone(next);changedSource.sourceProduct!.title='Other source';assert.equal(imageListingContextsMatch(base,changedSource),false);
  const changedSchema=structuredClone(next);changedSchema.schemaSha256='a'.repeat(64);assert.equal(imageListingContextsMatch(base,changedSchema),false);
  assert.equal(imageListingContextsMatch({...base,listingProgram:'standard'},{...next,listingProgram:'standard'}),false);
});

test('captured Amazon schemas accept hosted main and gallery locator structures in slot order',async()=>{
  const {realAmazonSchema,realParentAmazonSchema}=await import('./fixtures/amazon/schema-fixture.ts');
  const {hostedAttributes}=await import('../src/main/execution/images.ts');
  const {validateAttributes}=await import('../src/main/amazon/schema.ts');
  for(const [schema,count] of [[realAmazonSchema(),7],[realParentAmazonSchema(),1]] as const){
    const assets=Array.from({length:count},(_,i)=>({id:`asset-${i}`,sha256:String(i).repeat(64)}));
    const uploads=assets.map((a,i)=>({assetId:a.id,sha256:a.sha256,publicUrl:`https://images.example.test/hosted/${i}.png`}));
    const draft={schema,marketplaceId:'ATVPDKIKX0DER',attributes:{}} as any;
    const attributes=hostedAttributes(draft,{assets,uploads} as any);
    for(let i=0;i<count;i++){const field=i===0?'main_product_image_locator':`other_product_image_locator_${i}`;assert.deepEqual(attributes[field],[{marketplace_id:draft.marketplaceId,media_location:uploads[i].publicUrl}]);}
    assert.deepEqual(validateAttributes(schema.schema,attributes,schema.metaSchema).filter(i=>i.attributeNames.some(name=>name.includes('image_locator'))),[]);
    assert.throws(()=>hostedAttributes(draft,{assets,uploads:uploads.slice(1)} as any),/托管/);
  }
});

test('every supported dimension field participates in proven business-default image reuse',async t=>{
  const {DIMENSION_FIELDS}=await import('../src/main/amazon/field-mapping.ts');
  const f=await fixture(t),base=buildListingContext(f.draft,f.product,0);base.listingProgram='haul';
  for(const field of DIMENSION_FIELDS){const next=structuredClone(base);next.currentAttributes![field]=[{value:1.97,unit:'inches'}];next.businessValues![field]=next.currentAttributes![field];assert.equal(imageListingContextsMatch(base,next),true,field);}
});
