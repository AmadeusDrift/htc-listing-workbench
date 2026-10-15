import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/listing-ai.ts';
import { buildListingContext } from '../src/main/listing-ai/context.ts';
import { imageListingContextsMatch } from '../src/main/image-workflow/context-compatibility.ts';
import { imageListingContextChanges } from '../src/main/image-workflow/context-compatibility.ts';
import { generalObservationEvidence } from '../src/main/listing-ai/general-observations.ts';
import { randomUUID } from 'node:crypto';

for(const count of [3,4])test(`same original assessment permits only its ${count} general observation projection entries`,async t=>{
  const f=await fixture(t),base=buildListingContext(f.draft,f.product,0);
  const source={version:'source-image-consistency/v2' as const,variantId:base.variantId,assessmentId:randomUUID(),sourceFields:[],conflicts:[],reasons:[],images:[{
    assetId:randomUUID(),quality:'clear' as const,visibility:'complete' as const,lighting:'uncertain' as const,presentation:'single-product' as const,contentPurpose:'product' as const,colors:['Blue'],appearance:[],claims:[],
    observations:Array.from({length:count},(_,i)=>({name:`Feature ${i}`,values:[`visible feature ${i}`],visibility:'visible' as const}))
  }]};
  base.sourceProduct!.observations=[source];base.evidence.push(...generalObservationEvidence(source));
  const filtered=structuredClone(base);filtered.evidence=filtered.evidence.filter(e=>e.source!=='image_observation');
  const before=JSON.stringify([base,filtered]);assert.equal(imageListingContextsMatch(base,filtered),true);assert.equal(imageListingContextsMatch(filtered,base),true);
  const reversed=structuredClone(base);reversed.evidence.reverse();
  // Reordering general entries alone cannot change the original context/hash.
  reversed.evidence=[...base.evidence.filter(e=>e.source!=='image_observation'),...base.evidence.filter(e=>e.source==='image_observation').reverse()];
  assert.equal(imageListingContextsMatch(base,reversed),true);assert.equal(JSON.stringify([base,filtered]),before);
  for(const change of ['assessment','image','observation','attribute','fact','schema','seller','forged-evidence'] as const){
    const next=structuredClone(filtered);
    if(change==='assessment')next.sourceProduct!.observations![0].assessmentId=randomUUID();
    if(change==='image')next.sourceProduct!.observations![0].images[0].assetId=randomUUID();
    if(change==='observation')next.sourceProduct!.observations![0].images[0].observations![0].values=['changed'];
    if(change==='attribute')next.currentAttributes!.color=[{value:'Red'}];
    if(change==='fact')next.sourceProduct!.facts.push({id:randomUUID(),name:'Manual fact',value:'changed'} as any);
    if(change==='schema')next.schemaSha256='b'.repeat(64);
    if(change==='seller')next.targetGeneration++;
    if(change==='forged-evidence')next.evidence.push({...base.evidence.find(e=>e.source==='image_observation')!,value:'forged'});
    assert.equal(imageListingContextsMatch(base,next),false,change);
  }
  const color=structuredClone(source);color.images[0].observations=[{name:'color',values:['Blue'],visibility:'visible'}];
  assert.deepEqual(generalObservationEvidence(color),[],'uncertain lighting never grants color evidence');
  const changedSchema=structuredClone(filtered);changedSchema.schemaSha256='a'.repeat(64);
  assert.ok(imageListingContextChanges(base,changedSchema).includes('Schema'));
  assert.equal(imageListingContextChanges(base,changedSchema).includes('颜色依据'),false);
});

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
