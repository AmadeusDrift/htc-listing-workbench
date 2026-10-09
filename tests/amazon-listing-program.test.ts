import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AmazonService } from '../src/main/amazon/service.ts';
import type { AmazonPersistence } from '../src/main/amazon/persistence.ts';
import { schemaKey } from '../src/main/amazon/context.ts';
import { WorkspaceStore } from '../src/main/store.ts';
import type { JsonObject } from '../src/shared/amazon-contracts.ts';
import { realAmazonSchema, realParentAmazonSchema } from './fixtures/amazon/schema-fixture.ts';
import { sourceAttributes } from '../src/main/amazon/demo.ts';
import * as sourceMapping from '../src/main/amazon/demo.ts';
import { listingProgramIssues, programAttributes } from '../src/main/amazon/listing-program.ts';
import { validateAttributes } from '../src/main/amazon/schema.ts';
import { SkuNamingService } from '../src/main/sku-naming/service.ts';
import { buildSalesRecipes } from '../src/main/sales-plans/recipes.ts';
import { defaultListingRules } from '../src/shared/listing-rules.ts';
import { salesStoreScope } from '../src/main/sales-plans/planning.ts';
import type { SalesListingPlan } from '../src/shared/sales-plan-contracts.ts';

function fixture(t: test.TestContext) {
  const root = resolve('.test-data'); mkdirSync(root, { recursive: true }); const directory = mkdtempSync(join(root, 'listing-program-'));
  const store = new WorkspaceStore(directory);
  const service = new AmazonService(directory, id => store.getProduct(id), { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() },
    { fetch: async () => { throw new Error('Offline foundation tests must not use the network'); } });
  t.after(() => { service.close(); store.close(); assert.ok(directory.startsWith(root + '\\')); rmSync(directory, { recursive: true, force: true }); });
  const product = store.createProduct(); const target = service.enableDemo();
  const selection = { targetId: target.id, productType: 'DRINK_COASTER', parentageLevel: 'NONE', requirements: 'LISTING', locale: 'en_US' } as const;
  service.getSchema = async () => ({ ...realAmazonSchema(), ...selection, key: schemaKey(target, selection) });
  const input = { ...selection, productId: product.id, variantId: product.variants[0].id };
  const persistence = (service as unknown as { persistence: AmazonPersistence }).persistence;
  const batch = (listingProgram: string, attributes: JsonObject = {}) => ({ ...selection, listingProgram, items: [{ productId: product.id, productRevision: product.revision, variantId: product.variants[0].id, attributes }] });
  return { service, store, product, target, input, persistence, batch, directory };
}

test('real Haul parent schema has no purchasable offer and remains supported', () => {
  const schema = realParentAmazonSchema();
  assert.equal(Object.hasOwn(schema.schema.properties as JsonObject, 'purchasable_offer'), false);
  assert.equal(schema.parentageLevel, 'PARENT');
  assert.deepEqual(listingProgramIssues('haul', schema), []);
  const attrs = programAttributes('haul', 'ATVPDKIKX0DER', 'PARENT');
  assert.deepEqual(attrs, { is_value_stores_item: [{ value: true, marketplace_id: 'ATVPDKIKX0DER' }] });
  assert.deepEqual(listingProgramIssues('haul', schema, attrs), []);
});

test('Haul parents reject offer attributes while retaining Haul flag validation', () => {
  const schema = realParentAmazonSchema(), attrs = { is_value_stores_item: [{ value: true, marketplace_id: 'ATVPDKIKX0DER' }] };
  for (const audience of ['BZR', 'ALL']) {
    const issues = listingProgramIssues('haul', schema, { ...attrs, purchasable_offer: [{ audience }] });
    assert.ok(issues.some(i=>i.code==='HAUL_PARENT_OFFER_FORBIDDEN'));
  }
  assert.ok(listingProgramIssues('haul', schema, {}).some(i=>i.code==='HAUL_FLAG_REQUIRED'));
  delete (schema.schema.properties as JsonObject).is_value_stores_item;
  assert.ok(listingProgramIssues('haul', schema).some(i=>i.code==='HAUL_SCHEMA_UNSUPPORTED'));
});

test('creating and preparing actual parent schema drafts never injects a child offer', async t => {
  const f=fixture(t), selection={...f.input,parentageLevel:'PARENT',productType:'FIGURINE'} as const;
  f.service.getSchema=async ()=>({...realParentAmazonSchema(),targetId:f.target.id,key:schemaKey(f.target,selection)});
  const draft=await f.service.createDraft({...selection,listingProgram:'haul'});
  assert.equal(draft.attributes.purchasable_offer,undefined);
  assert.deepEqual(listingProgramIssues('haul',draft.schema,draft.attributes),[]);
  const recipe=buildSalesRecipes(f.product,null,defaultListingRules())[0],naming=new SkuNamingService(f.directory);
  const group=naming.allocate({storeScope:salesStoreScope(f.target),storeCode:'U2',sourceGroupKey:`local:${f.product.id}:family:${recipe.groupKey}`,collectedAt:f.product.createdAt,childKeys:[]});
  naming.close();
  const plan:SalesListingPlan={namingGroupId:group.id,sourceGroupKey:group.sourceGroupKey,collectedAt:group.collectedAt,collectionBasis:'first_import',sku:group.baseSku,baseSku:group.baseSku,
    recipe,parentage:'PARENT',parentSku:null,variationTheme:'COLOR',relationReason:'Source color family',familyResolved:true,namingChildKey:null};
  const prepared=await f.service.prepareDrafts({...f.batch('haul'),parentageLevel:'PARENT',productType:'FIGURINE'},[plan]);
  assert.equal(prepared.items[0].error,null);
  assert.equal(prepared.items[0].draft?.attributes.purchasable_offer,undefined);
  const changed={...draft.attributes,purchasable_offer:[{audience:'BZR'}]};
  assert.throws(()=>f.service.saveDraft({id:draft.id,revision:draft.revision,attributes:changed}),/父|报价/);
  assert.equal(f.service.getDraft(draft.id).revision,draft.revision);
});

test('existing parent drafts fill missing approved declarations once while keeping copy and image locations', async t => {
  const f=fixture(t), selection={...f.input,parentageLevel:'PARENT',productType:'FIGURINE'} as const;
  f.service.getSchema=async()=>({...realParentAmazonSchema(),targetId:f.target.id,key:schemaKey(f.target,selection)});
  const created=await f.service.createDraft({...selection,listingProgram:'haul'}),record=f.persistence.record(created.id);
  const fields={batteries_required:false,country_of_origin:'CN',supplier_declared_dg_hz_regulation:'not_applicable'};
  for(const field of Object.keys(fields)){delete record.draft.attributes[field];delete record.draft.businessRules?.fields[field];}
  record.draft.attributes.item_name=[{value:'Saved parent copy',marketplace_id:f.target.marketplaceId,language_tag:'en_US'}];
  record.draft.attributes.main_product_image_locator=[{media_location:'https://images.example.test/approved.png',marketplace_id:f.target.marketplaceId}];
  record.draft.state='BLOCKED';f.persistence.putRecord(record);
  const before=structuredClone(record.draft.attributes),fixed=f.service.applyBusinessDefaults({id:created.id,revision:created.revision});
  assert.equal(fixed.revision,created.revision+1);
  for(const [field,value] of Object.entries(fields))assert.deepEqual(fixed.attributes[field],[{value,marketplace_id:f.target.marketplaceId}],field);
  assert.deepEqual(fixed.attributes.item_name,before.item_name);
  assert.deepEqual(fixed.attributes.main_product_image_locator,before.main_product_image_locator);
  assert.equal(fixed.attributes.purchasable_offer,undefined);
  assert.equal(f.service.applyBusinessDefaults({id:fixed.id,revision:fixed.revision}).revision,fixed.revision);
  assert.equal(f.service.listCalls().length,0);
});

test('offline real fixture preserves 106 fields and Haul conditional structure with distinct provenance hashes', () => {
  const s = realAmazonSchema(); const manifest = JSON.parse(readFileSync(new URL('./fixtures/amazon/drink-coaster-us/manifest.json', import.meta.url), 'utf8'));
  assert.equal(Object.keys(s.schema.properties as JsonObject).length, 106); assert.equal(manifest.groupNameCount, 119);
  assert.notEqual(manifest.sha256.schema.original, manifest.sha256.schema.fixture);
  const bytes = readFileSync(new URL('./fixtures/amazon/drink-coaster-us/schema.json', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sha256.schema.fixture);
  assert.match(JSON.stringify((s.schema.allOf as JsonObject[])[13]), /is_value_stores_item.*true.*fulfillment_availability/);
  assert.match(JSON.stringify(s.schema), /FIXTURE-SHIPPING-TEMPLATE-1/);
});

test('legacy program defaults standard and old persisted records normalize to standard', async t => {
  const f = fixture(t); const d = await f.service.createDraft(f.input);
  assert.equal(Reflect.get(d, 'listingProgram'), 'standard');
  const r = f.persistence.record(d.id); Reflect.deleteProperty(r.draft, 'listingProgram');
  f.persistence.db.prepare('UPDATE listing_drafts SET record_json=? WHERE id=?').run(JSON.stringify(r), d.id);
  assert.equal(Reflect.get(f.service.getDraft(d.id), 'listingProgram'), 'standard');
  assert.equal(Reflect.get(f.service.listDrafts(f.product.id)[0], 'listingProgram'), 'standard');
});

test('Haul creates true boolean flag with BZR offer and never imports source inventory', async t => {
  const f = fixture(t); const d = await f.service.createDraft({ ...f.input, listingProgram: 'haul' });
  assert.equal(Reflect.get(d, 'listingProgram'), 'haul');
  assert.deepEqual(d.attributes.is_value_stores_item, [{ value: true, marketplace_id: f.target.marketplaceId }]);
  assert.deepEqual(d.attributes.purchasable_offer, [{ audience: 'BZR', marketplace_id: f.target.marketplaceId }]);
  assert.equal('fulfillment_availability' in d.attributes, false);
});

test('Haul schema must actually support true boolean and BZR without standard fallback', async t => {
  for (const capability of ['flag', 'audience']) {
    const f = fixture(t); const original = f.service.getSchema;
    f.service.getSchema = async input => { const s = await original(input); const props = s.schema.properties as JsonObject;
      if (capability === 'flag') delete props.is_value_stores_item;
      else (((props.purchasable_offer as JsonObject).items as JsonObject).properties as JsonObject).audience = { type: 'string', enum: ['ALL'] };
      return s; };
    await assert.rejects(f.service.createDraft({ ...f.input, listingProgram: 'haul' }), /Haul|BZR/);
    await assert.rejects(f.service.prepareDrafts(f.batch('haul')), /Haul|BZR/);
    assert.equal(f.service.listDrafts(f.product.id).length, 0);
  }
});

test('Haul capability follows internal references at the attribute, item and scalar levels', () => {
  for (const location of ['flag', 'flag-items', 'flag-value', 'offer', 'offer-items', 'audience']) {
    const snapshot = realAmazonSchema(); const original = snapshot.schema.properties as JsonObject;
    snapshot.schema = { $schema:snapshot.schema.$schema, type:'object', $defs:snapshot.schema.$defs,
      properties:{is_value_stores_item:original.is_value_stores_item,purchasable_offer:original.purchasable_offer}, required:['is_value_stores_item','purchasable_offer'],additionalProperties:false };
    const properties = snapshot.schema.properties as JsonObject; const defs = snapshot.schema.$defs as JsonObject;
    const flag = properties.is_value_stores_item as JsonObject; const offer = properties.purchasable_offer as JsonObject;
    const owners: Record<string,[JsonObject,string]> = {flag:[properties,'is_value_stores_item'],'flag-items':[flag,'items'],
      'flag-value':[(flag.items as JsonObject).properties as JsonObject,'value'],offer:[properties,'purchasable_offer'],
      'offer-items':[offer,'items'],audience:[(offer.items as JsonObject).properties as JsonObject,'audience']};
    const [owner,key] = owners[location]; defs.factored = owner[key]; owner[key] = {$ref:'#/$defs/factored'};
    const attrs = programAttributes('haul','ATVPDKIKX0DER');
    assert.deepEqual(validateAttributes(snapshot.schema,attrs,snapshot.metaSchema),[],`${location}: full schema accepts Haul values`);
    assert.deepEqual(listingProgramIssues('haul',snapshot,attrs),[],`${location}: referenced schema must remain Haul capable`);
  }
});

test('Haul capability keeps ref sibling and allOf restrictions instead of choosing one branch', () => {
  const snapshot = realAmazonSchema(); const properties = snapshot.schema.properties as JsonObject; const defs = snapshot.schema.$defs as JsonObject;
  defs.flag = properties.is_value_stores_item;
  properties.is_value_stores_item = {allOf:[{$ref:'#/$defs/flag'},{items:{properties:{value:{enum:[true]}}}}]};
  defs.offerItem = (properties.purchasable_offer as JsonObject).items;
  (properties.purchasable_offer as JsonObject).items = {allOf:[{$ref:'#/$defs/offerItem'},{properties:{audience:{enum:['BZR']}}}]};
  assert.deepEqual(listingProgramIssues('haul',snapshot),[]);
  (properties.is_value_stores_item as JsonObject).allOf = [{$ref:'#/$defs/flag'},{items:{properties:{value:{enum:[false]}}}}];
  assert.ok(listingProgramIssues('haul',snapshot).some(issue => issue.attributeNames.includes('is_value_stores_item')));
  properties.is_value_stores_item = {$ref:'#/$defs/flag'};
  (properties.purchasable_offer as JsonObject).items = {$ref:'#/$defs/offerItem',properties:{audience:{enum:['ALL']}}};
  assert.ok(listingProgramIssues('haul',snapshot).some(issue => issue.attributeNames.includes('purchasable_offer')));
});

test('Haul capability fails closed on unsafe, unresolved and circular internal references', () => {
  for (const reference of ['https://example.invalid/schema','#/$defs/missing','#/$defs/cycle']) {
    const snapshot = realAmazonSchema(); (snapshot.schema.$defs as JsonObject).cycle = {$ref:'#/$defs/cycle'};
    (snapshot.schema.properties as JsonObject).is_value_stores_item = {$ref:reference};
    assert.ok(listingProgramIssues('haul',snapshot).some(issue => issue.code === 'HAUL_SCHEMA_UNSUPPORTED'));
  }
});

test('program is immutable through save and invalid program names fail', async t => {
  const f = fixture(t); const d = await f.service.createDraft({ ...f.input, listingProgram: 'haul' });
  assert.throws(() => f.service.saveDraft({ id: d.id, revision: d.revision, listingProgram: 'standard', attributes: d.attributes }), /项目|program|Haul|类型/);
  await assert.rejects(f.service.createDraft({ ...f.input, listingProgram: 'HAUL' }), /项目|program|类型/);
});

test('Haul preparation identity separates programs and reuses only matching program', async t => {
  const f = fixture(t); const standard = await f.service.prepareDrafts(f.batch('standard'));
  const haul = await f.service.prepareDrafts(f.batch('haul')); const again = await f.service.prepareDrafts(f.batch('haul'));
  assert.equal(standard.items[0].disposition, 'CREATED'); assert.equal(haul.items[0].disposition, 'CREATED');
  assert.notEqual(standard.items[0].draft!.id, haul.items[0].draft!.id);
  assert.equal(again.items[0].disposition, 'REUSED'); assert.equal(again.items[0].draft!.id, haul.items[0].draft!.id);
});

test('Haul rejects forbidden JSON on save and preparation', async t => {
  const invalid: JsonObject[] = [
    { fulfillment_availability: [] }, { externally_assigned_product_identifier: [] }, { merchant_suggested_asin: [] },
    { purchasable_offer: [{ audience: 'ALL' }] }, { purchasable_offer: [] }, { is_value_stores_item: [{ value: 'true' }] }, { is_value_stores_item: [{ value: false }] },
  ];
  for (const patch of invalid) {
    const f = fixture(t); const d = await f.service.createDraft({ ...f.input, listingProgram: 'haul' });
    assert.throws(() => f.service.saveDraft({ id: d.id, revision: d.revision, attributes: { ...d.attributes, ...patch } }), /Haul|BZR/);
    const result = await f.service.prepareDrafts(f.batch('haul', patch)); assert.equal(result.items[0].disposition, 'REJECTED');
  }
});

test('tampered persisted Haul JSON is blocked in validation, preview and submit before any API', async t => {
  const f = fixture(t); const d = await f.service.createDraft({ ...f.input, listingProgram: 'haul' });
  const record = f.persistence.record(d.id); record.draft.attributes.fulfillment_availability = []; f.persistence.putRecord(record);
  const validated = await f.service.validateDraft(d); assert.ok(validated.localIssues.some(issue => issue.code === 'HAUL_FORBIDDEN_ATTRIBUTE'));
  await assert.rejects(f.service.previewDraft(validated), /校验|Haul/);
  await assert.rejects(f.service.submitDraft(validated, true), /预览|Haul/);
  assert.equal(f.service.listCalls().filter(call => /ListingsItem/.test(call.operation)).length, 0);
});

test('Haul source mapping uses confirmed measured item/package facts and leaves unverified copy, brand and inventory out', t => {
  const f = fixture(t); const product = structuredClone(f.product); product.title = 'Unverified supplier title'; product.description = 'Unverified source claims';
  product.facts = [
    {name:'产品长度',value:'10 cm',state:'human_confirmed'}, {name:'产品宽度',value:'10 cm',state:'source_confirmed'}, {name:'产品高度',value:'2 mm',state:'human_confirmed'},
    {name:'包装长度',value:'12 cm',state:'human_confirmed'}, {name:'包装宽度',value:'12 cm',state:'human_confirmed'}, {name:'包装高度',value:'1 cm',state:'human_confirmed'},
    {name:'商品重量',value:'100 g',state:'human_confirmed'}, {name:'包装重量',value:'120 g',state:'human_confirmed'}, {name:'售卖件数',value:'4',state:'human_confirmed'},
    {name:'材质',value:'Customblend',state:'human_confirmed'}, {name:'品牌',value:'Guessed Brand',state:'ai_suggested'}, {name:'是否需要电池',value:'false',state:'ai_suggested'},
  ].map((fact,index) => ({...fact,id:`fixture-fact-${index}`,source:'manual' as const,sourceRef:'Fixture source',state:fact.state as 'human_confirmed'|'source_confirmed'|'ai_suggested'}));
  const variant = {...product.variants[0],inventory:77}; const snapshot = realAmazonSchema();
  const attributes = sourceAttributes(product,variant,snapshot,f.target,'haul');
  for (const name of ['item_name','product_description','brand','batteries_required','fulfillment_availability']) assert.equal(name in attributes,false,name);
  assert.equal(((attributes.item_dimensions as JsonObject[])[0].length as JsonObject).value,3.94);
  assert.equal(((attributes.item_package_dimensions as JsonObject[])[0].length as JsonObject).value,4.72);
  assert.equal((attributes.item_weight as JsonObject[])[0].value,.22);
  assert.equal(((attributes.unit_count as JsonObject[])[0].type as JsonObject).value,'Count');
  assert.equal((attributes.material as JsonObject[])[0].value,'Customblend');
  const standard = sourceAttributes(product,variant,snapshot,f.target);
  assert.ok('item_name' in standard); assert.ok('product_description' in standard);
});

test('Haul source measurements never guess missing units, mix ambiguous dimensions or use unconfirmed/contradictory facts', t => {
  const f=fixture(t); const product=structuredClone(f.product);
  product.facts = [
    {name:'产品长度',value:'10',state:'human_confirmed'}, {name:'产品宽度',value:'10 cm',state:'human_confirmed'},
    {name:'产品高度',value:'2 mm',state:'ai_suggested'}, {name:'包装重量',value:'100 g',state:'human_confirmed'},
    {name:'包装重量',value:'200 g',state:'human_confirmed'}, {name:'库存',value:'77',state:'human_confirmed'}, {name:'尺寸',value:'10x10 cm',state:'human_confirmed'},
  ].map((fact,index) => ({...fact,id:`fixture-fact-${index}`,source:'manual' as const,sourceRef:'Fixture source',state:fact.state as 'human_confirmed'|'ai_suggested'}));
  const attrs=sourceAttributes(product,product.variants[0],realAmazonSchema(),f.target,'haul');
  for(const name of ['item_dimensions','item_length_width','item_package_dimensions','item_weight','item_package_weight','unit_count']) assert.equal(name in attrs,false,name);
});

test('creating a Haul draft for one of multiple SKUs never imports product-level color or size', async t => {
  const f = fixture(t); const first = f.product.variants[0]; const redId = randomUUID();
  const product = f.store.saveProduct({id:f.product.id,revision:f.product.revision,title:'Two colors',sourceUrl:'',description:'',status:'draft',
    variants:[{id:first.id,sku:first.sku,originalSpec:'Blue Large',normalizedSpec:'Blue Large',purchasePrice:'1',inventory:5},
      {id:redId,sku:`${first.sku}-RED`,originalSpec:'Red Small',normalizedSpec:'Red Small',purchasePrice:'1',inventory:5}],
    facts:[{id:randomUUID(),name:'color',value:'Blue',state:'human_confirmed',source:'manual',sourceRef:'Product-level label'},
      {id:randomUUID(),name:'size',value:'Large',state:'human_confirmed',source:'manual',sourceRef:'Product-level label'}]});
  const haul = await f.service.createDraft({...f.input,variantId:redId,listingProgram:'haul'});
  assert.equal('color' in haul.attributes,false); assert.equal('size' in haul.attributes,false);
  const standard = await f.service.createDraft({...f.input,variantId:redId,listingProgram:'standard'});
  assert.equal((standard.attributes.color as JsonObject[])[0].value,'Blue'); assert.equal((standard.attributes.size as JsonObject[])[0].value,'Large');
  const variant = product.variants.find(value => value.id === redId)!;
  const single = {...product,variants:[variant]};
  assert.equal((sourceAttributes(single,variant,realAmazonSchema(),f.target,'haul').color as JsonObject[])[0].value,'Blue');
});

test('source mapping report covers only actual fields and identifies mapped facts, alias conflicts, units and forbidden fields', t => {
  const report = Reflect.get(sourceMapping,'sourceMappingReport'); assert.equal(typeof report,'function','sourceMappingReport must be exported');
  const f=fixture(t); const product=structuredClone(f.product);
  product.facts = [
    {id:'material-en',name:'material',value:'Cork'}, {id:'material-cn',name:'材质',value:'Silicone'},
    {id:'color-fact',name:'颜色',value:'Red'}, {id:'length-fact',name:'产品长度',value:'10'},
    {id:'width-fact',name:'产品宽度',value:'10 cm'}, {id:'height-fact',name:'产品高度',value:'2 mm'},
  ].map(fact => ({...fact,state:'human_confirmed' as const,source:'manual' as const,sourceRef:'Fixture label'}));
  const snapshot=realAmazonSchema();
  type Entry={field:string;status:string;reason:string;sourceFactIds:string[]};
  const entries:Entry[]=report(product,product.variants[0],snapshot,f.target,'haul');
  assert.equal(entries.length,106); assert.equal(entries.some(entry=>entry.field==='variation_theme'),false);
  const material=entries.find(entry=>entry.field==='material')!; assert.equal(material.status,'conflicting'); assert.deepEqual(material.sourceFactIds,['material-en','material-cn']);
  const color=entries.find(entry=>entry.field==='color')!; assert.equal(color.status,'mapped'); assert.deepEqual(color.sourceFactIds,['color-fact']);
  for(const field of ['item_dimensions','item_length_width']) {const entry=entries.find(entry=>entry.field===field)!;assert.equal(entry.status,'needs_input');assert.match(entry.reason,/单位/);assert.ok(entry.reason.includes(field));assert.ok(entry.sourceFactIds.includes('length-fact'));}
  for(const field of ['fulfillment_availability','externally_assigned_product_identifier','merchant_suggested_asin']) assert.equal(entries.find(entry=>entry.field===field)!.status,'not_applicable');
  assert.match(entries.find(entry=>entry.field==='item_name')!.reason,/必填/);
  assert.match(entries.find(entry=>entry.field==='condition_type')!.reason,/条件/);
  assert.match(entries.find(entry=>entry.field==='color')!.reason,/已|映射/);
  assert.match(entries.find(entry=>entry.field==='main_product_image_locator')!.reason,/可选/);
  const provided:Entry[]=report(product,product.variants[0],snapshot,f.target,'haul',{item_name:[{value:'Explicit draft title',language_tag:'en_US',marketplace_id:f.target.marketplaceId}]});
  assert.equal(provided.find(entry=>entry.field==='item_name')!.status,'mapped'); assert.deepEqual(provided.find(entry=>entry.field==='item_name')!.sourceFactIds,[]);
});

test('source mapping report explains multi-SKU ambiguity and invalid numeric source units without claiming mappings', t => {
  const report=Reflect.get(sourceMapping,'sourceMappingReport');assert.equal(typeof report,'function');
  const f=fixture(t); const product=structuredClone(f.product); product.variants.push({...product.variants[0],id:'selected-red',sku:'RED',originalSpec:'Red',normalizedSpec:'Red'});
  product.facts=[{id:'color',name:'color',value:'Blue'},{id:'package-weight',name:'包装重量',value:'100 foot'},{id:'count',name:'售卖件数',value:'four'}]
    .map(fact=>({...fact,state:'human_confirmed' as const,source:'manual' as const,sourceRef:'Fixture'}));
  type Entry={field:string;status:string;reason:string;sourceFactIds:string[]};
  const entries:Entry[]=report(product,product.variants[1],realAmazonSchema(),f.target,'haul');
  const color=entries.find(entry=>entry.field==='color')!;assert.equal(color.status,'needs_input');assert.match(color.reason,/SKU/);
  const single:Entry[]=report({...product,variants:[product.variants[1]]},product.variants[1],realAmazonSchema(),f.target,'haul');
  for(const field of ['item_package_weight','unit_count']) {const entry=single.find(entry=>entry.field===field)!;assert.equal(entry.status,'needs_input');assert.ok(entry.reason.includes(field));assert.match(entry.reason,/单位|数字|整数|数值/);}
});

test('Haul create and prepare keep multi-SKU global facts out and attribute approved fallbacks', async t => {
  const f=fixture(t); const first=f.product.variants[0]; const largeId=randomUUID();
  const factValues=[['产品长度','10 cm'],['产品宽度','10 cm'],['产品高度','2 mm'],['商品重量','100 g'],
    ['包装长度','12 cm'],['包装宽度','12 cm'],['包装高度','1 cm'],['包装重量','120 g'],
    ['售卖件数','4'],['商品数量','4'],['包装数量','1'],['包数','1'],['品牌','Confirmed Brand']];
  const product=f.store.saveProduct({id:f.product.id,revision:f.product.revision,title:'Source coaster',sourceUrl:'',description:'',status:'draft',
    variants:[{id:first.id,sku:first.sku,originalSpec:'S 10 cm 4 pcs',normalizedSpec:'S 10 cm 4 pcs',purchasePrice:'1',inventory:5},
      {id:largeId,sku:`${first.sku}-L`,originalSpec:'L 20 cm 8 pcs',normalizedSpec:'L 20 cm 8 pcs',purchasePrice:'2',inventory:5}],
    facts:factValues.map(([name,value])=>({id:randomUUID(),name,value,state:'human_confirmed' as const,source:'manual' as const,sourceRef:'Product-level facts'}))});
  const numericFields=['item_dimensions','item_length_width','item_weight','item_package_dimensions','item_package_weight','unit_count','number_of_items','item_package_quantity','number_of_packs'];
  const haul=await f.service.createDraft({...f.input,variantId:largeId,listingProgram:'haul'});
  const checkFallbacks = (draft: typeof haul) => {
    for (const field of ['item_dimensions','item_length_width','item_package_dimensions']) {
      const value = (draft.attributes[field] as JsonObject[])[0];
      for (const axis of ['length','width','height']) if (value[axis]) assert.equal((value[axis] as JsonObject).value,1.97);
      assert.match(draft.businessRules!.fields[field].reason,/业务默认/);
      const mapping = draft.sourceMapping!.find(entry => entry.field === field)!;
      assert.match(mapping.reason,/业务规则.*业务默认/); assert.deepEqual(mapping.sourceFactIds,[]);
    }
    assert.equal((draft.attributes.item_package_weight as JsonObject[])[0].value,.22);
    assert.match(draft.businessRules!.fields.item_package_weight.reason,/业务默认/);
    for (const field of ['item_weight','item_package_quantity','number_of_packs']) assert.equal(field in draft.attributes,false,`must not inherit global ${field}`);
    for (const field of ['unit_count','number_of_items']) assert.equal((draft.attributes[field] as JsonObject[])[0].value,8,`${field} comes from the selected 8 pcs spec, not the product's 4-piece fact`);
  };
  checkFallbacks(haul);
  const prepared=await f.service.prepareDrafts({...f.batch('haul'),items:[{productId:product.id,productRevision:product.revision,variantId:largeId,attributes:{}}]});
  assert.equal(prepared.items[0].disposition,'REUSED');
  checkFallbacks(prepared.items[0].draft!);
  const report=Reflect.get(sourceMapping,'sourceMappingReport');const entries:{field:string;status:string;reason:string;sourceFactIds:string[]}[]=report(product,product.variants[1],realAmazonSchema(),f.target,'haul');
  for(const field of numericFields.filter(name=>Object.hasOwn(realAmazonSchema().schema.properties as JsonObject,name))) {
    const entry=entries.find(value=>value.field===field)!;assert.equal(entry.status,'needs_input',field);assert.match(entry.reason,/SKU/);assert.ok(entry.sourceFactIds.length>0,`${field} retains source provenance`);
  }
  assert.equal((haul.attributes.brand as JsonObject[])[0].value,'Confirmed Brand');
  const standard=await f.service.createDraft({...f.input,variantId:largeId,listingProgram:'standard'});
  assert.equal((standard.attributes.item_name as JsonObject[])[0].value,'Source coaster');assert.equal((standard.attributes.brand as JsonObject[])[0].value,'Confirmed Brand');
  for(const field of numericFields) assert.equal(field in standard.attributes,false);
});
