import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { openDatabase } from '../src/main/database.ts';
import { normalizeDetail } from '../src/main/miaoshou/normalize.ts';
import { persistImport, getReceipt, assertMiaoshouHistory } from '../src/main/miaoshou/persistence.ts';
import { MiaoshouService } from '../src/main/miaoshou/service.ts';
import { fingerprint, validateMiaoshouReceipt } from '../src/main/miaoshou/validation.ts';
import { demoSchema, sourceAttributes } from '../src/main/amazon/demo.ts';
import { buildListingContext } from '../src/main/listing-ai/context.ts';
import { assertListingEvidence, validateListingFieldsOutput, listingFingerprint } from '../src/main/listing-ai/validation.ts';
import { currentDraftEvidenceIssues } from '../src/main/listing-ai/current-evidence.ts';
import { sourceImageMeasurements } from '../src/main/image-workflow/source-measurements.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import type { AmazonDraft, AmazonTarget, JsonObject } from '../src/shared/amazon-contracts.ts';
import type { CandidateField } from '../src/shared/listing-ai-contracts.ts';
import type { ProductDetail } from '../src/shared/contracts.ts';
import type { MiaoshouReceipt } from '../src/shared/miaoshou-contracts.ts';
import { collectionSnapshot } from './helpers/collection-fixture.ts';
import { testMiaoshouStorage } from './helpers/miaoshou-fixture.ts';

const date = '2026-10-10T00:00:00.000Z', scope = 'a'.repeat(64);
type Attribute = {name:string;value:string};
type Trace = {version:string;entries:{factId:string;attributeIndex:number;rawName:string;rawValue:string;name:string;value:string;ruleIds:string[]}[]};
const trace = (receipt:MiaoshouReceipt):Trace|undefined => (receipt as MiaoshouReceipt & {factNormalizations?:Trace}).factNormalizations;
function fixture(t:test.TestContext, attributes:Attribute[], skuCount=1) {
  mkdirSync(resolve('.test-data'),{recursive:true}); const directory=mkdtempSync(resolve('.test-data/source-attributes-'));
  const store=new WorkspaceStore(directory), db=openDatabase(directory);
  t.after(()=>{db.close();store.close();assert.ok(relative(resolve('.test-data'),directory).startsWith('source-attributes-'));rmSync(directory,{recursive:true,force:true});});
  const snapshot=normalizeDetail({result:'success',code:'success',data:{editCommonCollectBoxDetail:{commonCollectBoxDetailId:'100',title:'Synthetic source',sourceAttrs:attributes,
    sourceList:[{source:'1688',sourceItemId:'123456',sourceItemUrl:'https://detail.1688.com/offer/123456.html'}],
    skuMap:Object.fromEntries(Array.from({length:skuCount},(_,i)=>[`sku-${i}`,{}]))}}},date);
  const mapping={priceField:'none' as const,currency:'unknown' as const,skus:snapshot.skus.map(sku=>({sourceKey:sku.key,dimensions:{}}))};
  const result=persistImport(db,store,snapshot,mapping,scope,'live',date),product=store.getProduct(result.productId),receipt=getReceipt(db,product.id)!;
  return {directory,store,db,snapshot,mapping,product,receipt,again:()=>persistImport(db,store,snapshot,mapping,scope,'live',date)};
}
function listing(product:ProductDetail, attributes?:JsonObject) {
  const target:AmazonTarget={id:randomUUID(),name:'Synthetic',mode:'demo',sellerId:'DEMO',marketplaceId:'ATVPDKIKX0DER',marketplaceName:'US',region:'na',locale:'en_US',paused:false,configured:false,credentialUpdatedAt:null,lastError:null};
  const schema=demoSchema(target,{targetId:target.id,productType:'HTC_DEMO_STORAGE_BAG',parentageLevel:'NONE',requirements:'LISTING_PRODUCT_ONLY',locale:'en_US'},Date.parse(date));
  const properties=schema.schema.properties as JsonObject;
  properties.age_range_description={type:'array',items:{type:'object',properties:{value:{type:'string',enum:['Adult','Child']}},required:['value'],additionalProperties:false}};
  (schema.schema.required as string[]).push('age_range_description');
  for(const [name,units] of [['item_length',['inches','cm','mm']],['item_weight',['pounds','g','kg','oz']]] as const)
    properties[name]={type:'array',items:{type:'object',properties:{value:{type:'number'},unit:{type:'string',enum:[...units]}},required:['value','unit'],additionalProperties:false}};
  const variant=product.variants[0],mapped=sourceAttributes(product,variant,schema,target,'haul');
  const draft:AmazonDraft={id:randomUUID(),productId:product.id,productRevision:product.revision,variantId:variant.id,sku:variant.sku,targetId:target.id,targetName:target.name,sellerId:target.sellerId,marketplaceId:target.marketplaceId,mode:'demo',revision:1,schema,attributes:attributes??mapped,listingProgram:'haul',state:'DRAFT',localIssues:[],previewIssues:[],listingIssues:[],statuses:[],submissionId:null,requestId:null,previewedAt:null,submittedAt:null,checkedAt:null,createdAt:date,updatedAt:date,events:[]};
  return {draft,mapped,context:buildListingContext(draft,product,1)};
}
function assertClaim(product:ProductDetail,field:CandidateField,value:string) {
  const {context}=listing(product);
  const evidence=context.evidence.filter(e=>!['material','item_shape','care_instructions'].includes(field)||e.meaning===field);
  assertListingEvidence(validateListingFieldsOutput({kind:'amazon-fields',candidates:[{field,items:[{value,evidenceIds:evidence.map(e=>e.id),transformation:'translate'}]}],missing:[]}),context);
}
const saveInput=(product:ProductDetail)=>({id:product.id,revision:product.revision,title:product.title,sourceUrl:product.sourceUrl,description:product.description,status:product.status,facts:product.facts,variants:product.variants.map(({id,sku,originalSpec,normalizedSpec,purchasePrice,inventory})=>({id,sku,originalSpec,normalizedSpec,purchasePrice,inventory}))});

test('first import normalizes bounded source names and values with complete creation provenance',t=>{
  const f=fixture(t,[{name:'ｍａｔｅｒｉａｌ',value:'Ｓｉｌｉｃｏｎｅ'},{name:'ａｇｅ＿ｒａｎｇｅ＿ｄｅｓｃｒｉｐｔｉｏｎ',value:'Ａｄｕｌｔ'},{name:'是否需要电池',value:'ＦＡＬＳＥ'}]);
  assert.deepEqual(f.product.facts.map(({name,value})=>({name,value})),[{name:'material',value:'Silicone'},{name:'age_range_description',value:'Adult'},{name:'是否需要电池',value:'FALSE'}]);
  assert.deepEqual(f.receipt.snapshot,f.snapshot); assert.equal(f.receipt.fingerprint,fingerprint(f.snapshot,f.mapping,scope,'live'));
  const entries=trace(f.receipt)!.entries; assert.equal(entries.length,3);
  entries.forEach((entry,index)=>{assert.equal(entry.attributeIndex,index);assert.equal(entry.factId,f.product.facts[index].id);assert.equal(entry.rawName,f.snapshot.attributes[index].name);assert.equal(entry.rawValue,f.snapshot.attributes[index].value);assert.equal(entry.name,f.product.facts[index].name);assert.equal(entry.value,f.product.facts[index].value);assert.ok(entry.ruleIds.length);});
  assert.ok(f.product.facts.every(fact=>fact.source==='import'&&fact.state==='source_confirmed'&&fact.sourceRef===f.snapshot.sources[0].sourceItemUrl));
  const {mapped,draft,context}=listing(f.product);assert.deepEqual((mapped.material as {value:string}[]).map(x=>x.value),['Silicone']);assert.equal((mapped.batteries_required as {value:boolean}[])[0].value,false);
  assert.doesNotThrow(()=>assertClaim(f.product,'material','Silicone'));assert.throws(()=>assertClaim(f.product,'material','Cotton'));
  assert.doesNotThrow(()=>assertClaim(f.product,'age_range_description','Adult'));assert.throws(()=>assertClaim(f.product,'age_range_description','Child'));
  assert.deepEqual(currentDraftEvidenceIssues(draft,context),[]);
  assert.ok(currentDraftEvidenceIssues({...draft,attributes:{age_range_description:[{value:'Child'}]}},context).length);
});

for(const [name,raw,expected,claim] of [
  ['产品长度','２．５４ ｃｍ','2.54 cm','Length 2.54 cm.'],['产品长度','2 centimeters','2 cm','Length 2 cm.'],
  ['产品长度','2 millimeters','2 mm','Length 2 mm.'],['产品长度','2 in','2 inches','Length 2 inches.'],
  ['产品重量','453.59237 grams','453.59237 g','Weight 453.59237 g.'],['产品重量','2 kilograms','2 kg','Weight 2 kg.'],
  ['产品重量','2 lb','2 pounds','Weight 2 pounds.'],['产品重量','2 ounces','2 oz','Weight 2 oz.'],
] as const)test(`new source measurement supports mapping and current v3 evidence: ${raw}`,t=>{
  const f=fixture(t,[{name,value:raw}]);assert.equal(f.product.facts[0].value,expected);assert.equal(trace(f.receipt)!.entries[0].rawValue,raw);
  const field=name==='产品重量'?'item_weight':'item_length'; assert.ok(listing(f.product).mapped[field]);
  assert.doesNotThrow(()=>assertClaim(f.product,'product_description',claim));
  assert.throws(()=>assertClaim(f.product,'product_description',claim.replace(/\d+(?:\.\d+)?/, '99')));
});

test('unknown names, model identifiers, unsupported units and bare measurements stay exact',t=>{
  const attributes=[{name:'ｍｙ＿ｃｕｓｔｏｍ',value:'ＡＢＣ Ⅳ ① ﬁ'},{name:'model_number',value:'ＡＢＣ－３５ｍｍ－Ⅳ'},{name:'焦距',value:'３５ｍｍ'},
    {name:'产品长度',value:'１２'},{name:'产品长度',value:'2 meters'},{name:'产品长度',value:'2 kg'},{name:'产品长度',value:'2 cm extra'},
    {name:'产品重量',value:'0'},{name:'是否需要电池',value:'false'},{name:'未知数量',value:'0'}];
  const f=fixture(t,attributes);assert.deepEqual(f.product.facts.map(({name,value})=>({name,value})),attributes);assert.equal(trace(f.receipt),undefined);
});

test('normalization retains distinct conflicting values and does not share global measurements with sibling SKUs',t=>{
  const f=fixture(t,[{name:'ｍａｔｅｒｉａｌ',value:'Ｓｉｌｉｃｏｎｅ'},{name:'material',value:'Ｃｏｔｔｏｎ'},{name:'产品长度',value:'２ ｃｍ'}],2);
  assert.equal(f.product.facts.length,3);assert.ok(trace(f.receipt));assert.equal(trace(f.receipt)!.entries.length,3);assert.equal(listing(f.product).mapped.material,undefined);assert.equal(listing(f.product).mapped.item_length,undefined);
  assert.ok(!listing(f.product).context.evidence.some(e=>e.name==='产品长度'));
  assert.ok(f.product.facts.every(fact=>fact.state==='source_confirmed'));
  const changed=f.store.saveProduct({...saveInput(f.product),facts:f.product.facts.map(fact=>({...fact,state:'conflicting' as const}))});
  assert.ok(currentDraftEvidenceIssues({...listing(changed).draft,attributes:{material:[{value:'Silicone'}]}},listing(changed).context).length);
  assert.doesNotThrow(()=>assertMiaoshouHistory(f.db));assert.deepEqual(getReceipt(f.db,f.product.id),f.receipt);
});

test('new receipt replay rejects altered trace while preserving old no-trace receipts',t=>{
  const f=fixture(t,[{name:'ｍａｔｅｒｉａｌ',value:'Ｓｉｌｉｃｏｎｅ'}]);assert.ok(trace(f.receipt));
  assert.deepEqual(validateMiaoshouReceipt(f.receipt),f.receipt);
  for(const mutate of [
    (r:Trace)=>r.version='source-attribute-normalization/v999', (r:Trace)=>r.entries=[],
    (r:Trace)=>r.entries[0].attributeIndex=1, (r:Trace)=>r.entries[0].rawName='material',
    (r:Trace)=>r.entries[0].rawValue='Cotton', (r:Trace)=>r.entries[0].value='Cotton',
    (r:Trace)=>r.entries[0].name='color', (r:Trace)=>r.entries[0].ruleIds=['invented-rule'],
    (r:Trace)=>r.entries[0].factId='invalid', (r:Trace)=>r.entries[0].factId=f.product.id,
    (r:Trace)=>r.entries.push(structuredClone(r.entries[0])),
  ]){const bad=structuredClone(f.receipt);mutate(trace(bad)!);assert.throws(()=>validateMiaoshouReceipt(bad));}
  const legacy=structuredClone(f.receipt) as MiaoshouReceipt & {factNormalizations?:Trace};delete legacy.factNormalizations;
  assert.equal(JSON.stringify(validateMiaoshouReceipt(legacy)),JSON.stringify(legacy));
});

test('receipt readers and duplicate import reject a trace bound to another product fact',async t=>{
  const f=fixture(t,[{name:'材质',value:'Ｓｉｌｉｃｏｎｅ'}]);
  const service=new MiaoshouService(f.directory,f.store,testMiaoshouStorage());
  try {
  assert.deepEqual(service.getReceipt(f.product.id),f.receipt);
  const other=f.store.createProduct(),factId=randomUUID();
  f.store.saveProduct({...saveInput(other),facts:[{id:factId,name:'材质',value:'Silicone',state:'human_confirmed',source:'manual',sourceRef:''}]});
  const bad=structuredClone(f.receipt);trace(bad)!.entries[0].factId=factId;
  f.db.prepare('UPDATE miaoshou_receipts SET record_json=? WHERE id=?').run(JSON.stringify(bad),f.receipt.id);
  assert.throws(()=>getReceipt(f.db,f.product.id));assert.throws(()=>service.getReceipt(f.product.id));assert.throws(()=>assertMiaoshouHistory(f.db));assert.throws(()=>f.again());
  assert.deepEqual(f.store.getProduct(f.product.id),f.product);
  } finally {await service.close();}
});

test('normalization provenance cannot reuse an extant product or variant identity outside its receipt',t=>{
  const f=fixture(t,[{name:'材质',value:'Ｓｉｌｉｃｏｎｅ'}]),other=f.store.createProduct();
  for(const factId of [other.id,other.variants[0].id]){
    const bad=structuredClone(f.receipt);trace(bad)!.entries[0].factId=factId;
    f.db.prepare('UPDATE miaoshou_receipts SET record_json=? WHERE id=?').run(JSON.stringify(bad),f.receipt.id);
    assert.throws(()=>getReceipt(f.db,f.product.id));assert.throws(()=>assertMiaoshouHistory(f.db));
  }
});

test('strict trace replay rejects omitted, reordered, duplicate, extra and unchanged entries',t=>{
  const f=fixture(t,[{name:'材质',value:'Ｓｉｌｉｃｏｎｅ'},{name:'适用年龄',value:'Ａｄｕｌｔ'},{name:'未知属性',value:'0'}]);
  for(const mutate of [
    (r:Trace)=>r.entries.pop(),(r:Trace)=>r.entries.reverse(),(r:Trace)=>r.entries[1].factId=r.entries[0].factId,
    (r:Trace)=>r.entries[0].factId=f.receipt.id,(r:Trace)=>r.entries[0].factId=f.receipt.skuMappings[0].localVariantId,
    (r:Trace)=>Object.assign(r.entries[0],{extra:true}),(r:Trace)=>Object.assign(r,{extra:true}),
    (r:Trace)=>r.entries[0].ruleIds.push(r.entries[0].ruleIds[0]),
    (r:Trace)=>r.entries.push({factId:f.product.facts[2].id,attributeIndex:2,rawName:'未知属性',rawValue:'0',name:'未知属性',value:'0',ruleIds:[]}),
  ]){const bad=structuredClone(f.receipt);mutate(trace(bad)!);assert.throws(()=>validateMiaoshouReceipt(bad));}
});

test('duplicate imports leave historical JSON, facts and saved context fingerprints unchanged',t=>{
  const f=fixture(t,[{name:'ｍａｔｅｒｉａｌ',value:'Ｓｉｌｉｃｏｎｅ'}]);
  const legacy=structuredClone(f.receipt) as MiaoshouReceipt & {factNormalizations?:Trace};delete legacy.factNormalizations;
  f.db.prepare('UPDATE facts SET name=?,value=? WHERE id=?').run(f.snapshot.attributes[0].name,f.snapshot.attributes[0].value,f.product.facts[0].id);
  const oldJson=JSON.stringify(legacy,null,2);f.db.prepare('UPDATE miaoshou_receipts SET record_json=? WHERE id=?').run(oldJson,legacy.id);
  const before=f.store.getProduct(f.product.id),{context,draft}=listing(before),sha=listingFingerprint(context);
  assert.equal(f.again().duplicate,true);assert.equal(f.db.prepare('SELECT record_json FROM miaoshou_receipts WHERE id=?').get(legacy.id)!.record_json,oldJson);
  assert.deepEqual(f.store.getProduct(before.id),before);assert.deepEqual(getReceipt(f.db,before.id),legacy);assert.equal(listingFingerprint(buildListingContext(draft,f.store.getProduct(before.id),1)),sha);
  assert.equal(trace(getReceipt(f.db,before.id)!),undefined);
});

test('creation provenance survives later manual edits, fact deletion, restart and encrypted restore',async t=>{
  const f=fixture(t,[{name:'材质',value:'Ｓｉｌｉｃｏｎｅ'},{name:'适用年龄',value:'Ａｄｕｌｔ'}]);
  const saved=f.store.saveProduct({...saveInput(f.product),facts:[{...f.product.facts[0],value:'Cotton',state:'human_confirmed',source:'manual',sourceRef:'Manual correction'}]});
  const receiptJson=f.db.prepare('SELECT record_json FROM miaoshou_receipts WHERE id=?').get(f.receipt.id)!.record_json;
  assert.doesNotThrow(()=>assertMiaoshouHistory(f.db));assert.equal(f.again().duplicate,true);assert.deepEqual(f.store.getProduct(saved.id),saved);
  const reopened=new WorkspaceStore(f.directory),second=openDatabase(f.directory);
  try{assert.deepEqual(reopened.getProduct(saved.id),saved);assert.deepEqual(getReceipt(second,saved.id),f.receipt);}finally{second.close();reopened.close();}
  const archive=join(f.directory,'roundtrip.htcbackup'),target=join(f.directory,'restored');
  await createWorkspaceBackup(f.directory,archive,'test-backup-password');
  const prepared=await prepareWorkspaceRestore(target,archive,'test-backup-password');await commitWorkspaceRestore(target,prepared);
  const restored=new WorkspaceStore(target),restoredDb=openDatabase(target);
  try{assert.deepEqual(restored.getProduct(saved.id),saved);assert.deepEqual(getReceipt(restoredDb,saved.id),f.receipt);assert.equal(restoredDb.prepare('SELECT record_json FROM miaoshou_receipts WHERE id=?').get(f.receipt.id)!.record_json,receiptJson);assert.doesNotThrow(()=>assertMiaoshouHistory(restoredDb));}
  finally{restoredDb.close();restored.close();}
});

test('source snapshot measurement projection and its hash remain independent of new fact trace',t=>{
  const f=fixture(t,[{name:'产品长度',value:'２ ｃｍ'},{name:'产品宽度',value:'3 cm'}]),{draft}=listing(f.product);
  const legacy=structuredClone(f.receipt) as MiaoshouReceipt & {factNormalizations?:Trace};delete legacy.factNormalizations;
  const before=sourceImageMeasurements(legacy,draft),after=sourceImageMeasurements(f.receipt,draft);
  assert.ok(after.length);assert.deepEqual(after,before);assert.ok(!after.some(e=>e.name==='商品长度'));
  const sha=listingFingerprint({snapshot:f.snapshot,mapping:f.mapping,skuMappings:f.receipt.skuMappings});assert.ok(after.every(e=>e.sourceSha256===sha));
  assert.ok(listing(f.product).mapped.item_length);assert.doesNotThrow(()=>assertClaim(f.product,'product_description','Length 2 cm.'));
});

test('primitive source attribute types remain strict, while string zero and false remain present',t=>{
  for(const value of [0,false])assert.throws(()=>normalizeDetail({result:'success',code:'success',data:{editCommonCollectBoxDetail:{commonCollectBoxDetailId:'100',sourceAttrs:[{name:'是否需要电池',value}]}}},date));
  const f=fixture(t,[{name:'是否需要电池',value:'false'},{name:'产品长度',value:'0'}]);
  assert.deepEqual(f.product.facts.map(fact=>fact.value),['false','0']);assert.equal(trace(f.receipt),undefined);assert.equal((listing(f.product).mapped.batteries_required as {value:boolean}[])[0].value,false);assert.equal(listing(f.product).mapped.item_length,undefined);
});

test('native 1688 SKU attributes remain receipt-local and never create shared product facts',t=>{
  const f=fixture(t,[]),snapshot=collectionSnapshot();snapshot.skus[0].attributes.push({name:'ｍａｔｅｒｉａｌ',value:'Ｓｉｌｉｃｏｎｅ'});
  const result=f.store.receiveCollectionSnapshot(randomUUID(),snapshot);
  assert.deepEqual(f.store.getProduct(result.productId).facts,[]);assert.deepEqual(f.store.getCollectionReceipt(result.productId)!.snapshot.skus,snapshot.skus);
});

test('expanded normalization trace honors the existing 4 MiB receipt limit atomically',t=>{
  const f=fixture(t,[]),urls=Array.from({length:150},(_,i)=>`https://images.example.com/${i}/`+'x'.repeat(1990));
  const raw={result:'success',code:'success',data:{editCommonCollectBoxDetail:{commonCollectBoxDetailId:'101',sourceAttrs:Array.from({length:100},()=>({name:'材质',value:'中'.repeat(3999)+'Ａ'})),imgUrls:urls,colorMap:{c:{name:'Blue',imgUrls:urls}},sizeMap:{s:{name:'Small',imgUrls:urls}},skuMap:{sku:{}}}}};
  assert.ok(Buffer.byteLength(JSON.stringify(raw))<4*1024*1024);
  const snapshot=normalizeDetail(raw,date),mapping={priceField:'none' as const,currency:'unknown' as const,skus:[{sourceKey:'sku',dimensions:{color:'c',size:'s'}}]};
  const counts=()=>['products','variants','facts','product_workspaces','miaoshou_receipts','audit_events'].map(table=>f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n),before=counts();
  assert.throws(()=>persistImport(f.db,f.store,snapshot,mapping,scope,'live',date),(error:unknown)=>(error as {code:string}).code==='TOO_LARGE');
  assert.deepEqual(counts(),before);assert.doesNotThrow(()=>assertMiaoshouHistory(f.db));
});

test('bounded width conversion preserves negation and never folds compatibility numerals or ligatures',t=>{
  const f=fixture(t,[{name:'适用年龄',value:'Ｎｏｔ　Ａｄｕｌｔ'},{name:'材质',value:'Ｐｌａｓｔｉｃ Ⅳ ① ﬁ'}]);
  assert.deepEqual(f.product.facts.map(f=>f.value),['Not Adult','Plastic Ⅳ ① ﬁ']);
  assert.equal(listing(f.product).mapped.age_range_description,undefined);assert.throws(()=>assertClaim(f.product,'age_range_description','Adult'));
  const {draft,context}=listing(f.product);assert.ok(currentDraftEvidenceIssues({...draft,attributes:{age_range_description:[{value:'Adult'}]}},context).length);
});

test('finite unit spellings retain their original number and map to jointly supported source evidence',t=>{
  for(const [name,unit,canonical] of [
    ...['cm','centimeters','厘米'].map(unit=>['产品长度',unit,'cm']),...['mm','millimeters','毫米'].map(unit=>['产品长度',unit,'mm']),
    ...['in','inch','inches','英寸'].map(unit=>['产品长度',unit,'inches']),...['g','grams','克'].map(unit=>['产品重量',unit,'g']),
    ...['kg','kilograms','公斤','千克'].map(unit=>['产品重量',unit,'kg']),...['lb','lbs','pound','pounds','磅'].map(unit=>['产品重量',unit,'pounds']),
    ...['oz','ounces'].map(unit=>['产品重量',unit,'oz']),
  ]){
    const f=fixture(t,[{name,value:`02.00${unit}`}]);assert.equal(f.product.facts[0].value,`02.00 ${canonical}`);
    assert.ok(listing(f.product).mapped[name==='产品长度'?'item_length':'item_weight']);
    assert.doesNotThrow(()=>assertClaim(f.product,'product_description',`Measured 2 ${canonical}.`));
  }
});

test('new Miaoshou selected dimension text stays SKU-local and unchanged',t=>{
  const f=fixture(t,[]),snapshot=normalizeDetail({result:'success',code:'success',data:{editCommonCollectBoxDetail:{commonCollectBoxDetailId:'101',sourceAttrs:[],
    colorPropName:'材质',colorMap:{a:{name:'Ｓｉｌｉｃｏｎｅ'},b:{name:'Ｃｏｔｔｏｎ'}},skuMap:{a:{},b:{}}}}},date);
  const mapping={priceField:'none' as const,currency:'unknown' as const,skus:[{sourceKey:'a',dimensions:{color:'a'}},{sourceKey:'b',dimensions:{color:'b'}}]};
  const result=persistImport(f.db,f.store,snapshot,mapping,scope,'live',date),product=f.store.getProduct(result.productId),receipt=getReceipt(f.db,product.id)!;
  assert.deepEqual(product.facts,[]);assert.deepEqual(receipt.snapshot,snapshot);assert.equal(trace(receipt),undefined);
  assert.deepEqual(product.variants.map(v=>v.sourceSpec),['材质: Ｓｉｌｉｃｏｎｅ','材质: Ｃｏｔｔｏｎ']);
});

test('backup rejects a forged trace and known cross-product identity association',async t=>{
  const f=fixture(t,[{name:'材质',value:'Ｓｉｌｉｃｏｎｅ'}]),other=f.store.createProduct();
  for(const [index,mutate] of [
    (r:Trace)=>r.entries[0].rawValue='Cotton',
    (r:Trace)=>r.entries[0].factId=other.id,
  ].entries()){
    const bad=structuredClone(f.receipt);mutate(trace(bad)!);f.db.prepare('UPDATE miaoshou_receipts SET record_json=? WHERE id=?').run(JSON.stringify(bad),f.receipt.id);
    await assert.rejects(createWorkspaceBackup(f.directory,join(f.directory,`bad-${index}.htcbackup`),'test-backup-password'));
  }
});

test('failure after fact insertion rolls back facts, trace, product and audit as one transaction',t=>{
  const f=fixture(t,[]),snapshot={...f.snapshot,remoteId:'101',attributes:[{name:'材质',value:'Ｓｉｌｉｃｏｎｅ'}]};
  const counts=()=>['products','variants','facts','product_workspaces','miaoshou_receipts','audit_events'].map(table=>f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n),before=counts();
  f.db.exec("CREATE TRIGGER reject_new_source_receipt BEFORE INSERT ON miaoshou_receipts BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");
  assert.throws(()=>persistImport(f.db,f.store,snapshot,f.mapping,scope,'live',date));assert.deepEqual(counts(),before);
});

test('different original names normalizing to one category field retain both facts and conflict decisions',t=>{
  const f=fixture(t,[{name:'ａｇｅ＿ｒａｎｇｅ＿ｄｅｓｃｒｉｐｔｉｏｎ',value:'Ａｄｕｌｔ'},{name:'age_range_description',value:'Ｃｈｉｌｄ'}]);
  assert.deepEqual(f.product.facts.map(({name,value,state})=>({name,value,state})),[{name:'age_range_description',value:'Adult',state:'source_confirmed'},{name:'age_range_description',value:'Child',state:'source_confirmed'}]);
  assert.equal(trace(f.receipt)!.entries.length,2);assert.notEqual(f.product.facts[0].id,f.product.facts[1].id);
  assert.equal(listing(f.product).mapped.age_range_description,undefined);assert.throws(()=>assertClaim(f.product,'age_range_description','Adult'));
  const {draft,context}=listing(f.product);assert.ok(currentDraftEvidenceIssues({...draft,attributes:{age_range_description:[{value:'Adult'}]}},context).length);
});
