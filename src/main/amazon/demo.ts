import { factsForVariant } from '../../shared/fact-scopes.ts';
import { sourceFieldName, sourceFactValue, selectedSkuCategoryEvidence, effectiveSourceMeasurements, confirmedMeasurements, MEASUREMENT_FIELDS, MEASUREMENT_ALIASES, SKU_DEPENDENT_SOURCE_FIELDS, parseMeasurement, selectedSkuCategoryAttributes } from './source-facts.ts';
export { sourceFieldName, sourceFactValue, selectedSkuCategoryEvidence, selectedSkuCategoryAttributes, effectiveSourceMeasurements, measurementFactName, skuDependentSourceFact } from './source-facts.ts';
import { categoryAttributeValues, categoryAttributeField, categoryAttributeSourceOptions, SCOPED_CATEGORY_FIELDS } from '../listing-ai/evidence-category-v2.ts';
export { categoryAttributeValues, categoryAttributeField, categoryAttributeSourceOptions } from '../listing-ai/evidence-category-v2.ts';
import { createHash } from 'node:crypto';
import type { AmazonSchema, AmazonTarget, JsonObject, JsonValue, ListingProgram, SchemaSelection, SourceFieldMapping } from '../../shared/amazon-contracts.ts';
import type { Fact, ProductDetail, Variant } from '../../shared/contracts.ts';
import { isObject, schemaKey } from './context.ts';
import { validateAttributes } from './schema.ts';
import { convertMeasurement, mapMeasurementFields, validateFieldValues, wrapCandidateValues } from './field-mapping.ts';
import type { ConfirmedMeasurements } from './field-mapping.ts';
import { buildFieldCatalog } from './field-catalog.ts';
import { CATEGORY_ATTRIBUTE_FIELDS } from '../../shared/listing-ai-contracts.ts';
import { currentFactAuthority } from './fact-authority.ts';

export const DEMO_TYPE = 'HTC_DEMO_STORAGE_BAG';
export function demoSchema(target: AmazonTarget, selection: SchemaSelection, now: number): AmazonSchema {
  const market: JsonObject = { type: 'string', const: target.marketplaceId, title: '演示站点', hidden: true };
  const values = (title: string, value: JsonObject, extra: JsonObject = {}): JsonObject => ({ type: 'array', title, minItems: 1, maxItems: 1, selectors: ['marketplace_id'], uniqueItems: true,
    items: { type: 'object', properties: { value, marketplace_id: market, ...extra }, required: ['value', 'marketplace_id'], additionalProperties: false } });
  const properties: JsonObject = {
    item_name: values('商品标题（演示）', { type: 'string', minLength: 1, maxUtf8ByteLength: 200 }, { language_tag: { type: 'string', const: selection.locale } }),
    product_description: values('商品描述（演示）', { type: 'string', maxUtf8ByteLength: 2000 }),
    brand: values('已确认品牌（演示）', { type: 'string', minLength: 1, maxLength: 80, editable: false }),
    color: values('已确认颜色（演示）', { type: 'string', minLength: 1, maxLength: 80 }),
    material: values('已确认材质（演示）', { type: 'string', minLength: 1 }),
    batteries_required: values('是否需要电池（演示条件）', { type: 'boolean' }),
    battery_type: values('电池类型（演示条件必填）', { type: 'string', enum: ['AA', 'AAA', 'OTHER'], enumNames: ['AA', 'AAA', '其他'] }),
    purchasable_offer: { type: 'array', title: '销售报价（演示；必须人工填写）', minItems: 1, selectors: ['marketplace_id', 'audience'], uniqueItems: true, maxUniqueItems: 2,
      items: { type: 'object', properties: { marketplace_id: market, currency: { type: 'string', enum: ['USD'], title: '币种' },
        audience: { type: 'string', enum: ['ALL', 'BZR'], enumNames: ['全部买家（示例）', 'BZR（仅演示枚举）'], title: '报价受众' },
        our_price: { type: 'array', minItems: 1, maxItems: 1, title: '销售价', items: { type: 'object', properties: {
          schedule: { type: 'array', minItems: 1, maxItems: 1, items: { type: 'object', properties: { value_with_tax: { type: 'number', exclusiveMinimum: 0, title: '含税销售价' } }, required: ['value_with_tax'], additionalProperties: false } },
        }, required: ['schedule'], additionalProperties: false } },
      }, required: ['marketplace_id', 'currency', 'audience', 'our_price'], additionalProperties: false } },
    main_product_image_locator: { type: 'array', title: '公开图片地址（演示）', maxItems: 1, items: { type: 'object', properties: { marketplace_id: market,
      media_location: { type: 'string', format: 'uri', pattern: '^https://', title: 'HTTPS 图片地址' } }, required: ['marketplace_id', 'media_location'], additionalProperties: false } },
    fulfillment_availability: { type: 'array', title: '已知库存（演示）', maxItems: 1, items: { type: 'object', properties: { quantity: { type: 'integer', minimum: 0, title: '库存数量' }, marketplace_id: market }, required: ['quantity', 'marketplace_id'], additionalProperties: false } },
  };
  for(let index=1;index<=6;index++)properties[`other_product_image_locator_${index}`]={...structuredClone(properties.main_product_image_locator as JsonObject),title:`详情图片 ${index} 地址（演示）`};
  const required = selection.requirements === 'LISTING_OFFER_ONLY' ? ['purchasable_offer'] : selection.requirements === 'LISTING_PRODUCT_ONLY' ? ['item_name', 'brand', 'color'] : ['item_name', 'brand', 'color', 'purchasable_offer'];
  const schema: JsonObject = { $schema: 'https://json-schema.org/draft/2019-09/schema', title: 'HTC 本地演示收纳袋',
    description: '此 Schema 是 HTC 自建教学演示示例，不代表 Amazon 的实际类目要求、BZR 资格或可售条件。', type: 'object', properties, required, additionalProperties: false,
    allOf: [{ if: { required: ['batteries_required'], properties: { batteries_required: { contains: { type: 'object', properties: { value: { const: true } }, required: ['value'] } } } }, then: { required: ['battery_type'] } }] };
  return { ...selection, key: schemaKey(target, selection), mode: 'demo', schema, metaSchema: {}, checksum: createHash('md5').update(JSON.stringify(schema)).digest('base64'),
    version: 'HTC-ILLUSTRATIVE-2', propertyGroups: { identity: { title: '已知商品事实（演示）', propertyNames: ['item_name', 'product_description', 'brand', 'color', 'material'] },
      offer: { title: '销售配置（演示）', propertyNames: ['purchasable_offer', 'fulfillment_availability'] }, extra: { title: '图片与条件字段（演示）', propertyNames: ['main_product_image_locator', ...Array.from({length:6},(_,index)=>`other_product_image_locator_${index+1}`), 'batteries_required', 'battery_type'] } },
    fetchedAt: new Date(now).toISOString(), expiresAt: new Date(now + 86_400_000).toISOString(), fromCache: false };
}

/** Seed only known facts into fields whose current schema accepts their shape. */
export function sourceAttributes(product: ProductDetail, variant: Variant, snapshot: AmazonSchema, target: AmazonTarget, program: ListingProgram = 'standard', skuMeasurements: ConfirmedMeasurements = {}): JsonObject {
  product={...product,facts:factsForVariant(product,variant.id)};
  const schema = snapshot.schema; const fields = isObject(schema.properties) ? schema.properties : {}; const attributes: JsonObject = {};
  function add(name: string, value: JsonValue): void {
    const field = fields[name]; if (!isObject(field)) return;
    if (program === 'haul') {
      const options=typeof value==='string'?categoryAttributeSourceOptions(name,value):[value];
      const accepted=options.find(option=>validateFieldValues(snapshot,target.marketplaceId,name,[option],attributes).length===0);
      if(accepted!==undefined)attributes[name]=wrapCandidateValues(snapshot,target.marketplaceId,name,[accepted]);
      return;
    }
    let candidate: JsonValue = value;
    if (field.type === 'array' && isObject(field.items) && isObject(field.items.properties)) {
      const properties = field.items.properties; const wrapped: JsonObject = {};
      const valueKey = 'value' in properties ? 'value' : name === 'fulfillment_availability' && 'quantity' in properties ? 'quantity' : null;
      if (!valueKey) return;
      wrapped[valueKey] = value;
      if ('marketplace_id' in properties) wrapped.marketplace_id = target.marketplaceId;
      if ('language_tag' in properties) wrapped.language_tag = snapshot.locale;
      candidate = [wrapped];
    }
    const isolated: JsonObject = { ...(schema.$schema ? { $schema: schema.$schema } : {}), ...(schema.$defs ? { $defs: schema.$defs } : {}), type: 'object', properties: { [name]: field } };
    if (validateAttributes(isolated, { [name]: candidate }, snapshot.metaSchema).length === 0) attributes[name] = candidate;
  }
  if (program === 'standard' && product.title.trim()) add('item_name', product.title);
  if (program === 'standard' && product.description.trim()) add('product_description', product.description);
  const knownNames = new Set(['brand', 'color', 'material', 'manufacturer', 'country_of_origin', 'batteries_required', 'battery_type', 'size', 'model_name', 'model_number', ...CATEGORY_ATTRIBUTE_FIELDS]);
  if (program === 'haul') for (const name of ['item_name','product_description','item_shape','care_instructions','is_dishwasher_safe','number_of_items','item_package_quantity','number_of_packs',
    'part_number','condition_type','gpsr_safety_attestation','supplier_declared_dg_hz_regulation','required_product_compliance_certificate']) knownNames.add(name);
  const selected=selectedSkuCategoryAttributes(variant),selectedSources=selectedSkuCategoryEvidence(variant),confirmed = new Map<string, Set<string>>();
  for (const fact of product.facts) if (['source_confirmed', 'human_confirmed'].includes(fact.state) && fact.value.trim()) {
    const name = categoryAttributeField(fact.name,fact.value) ?? sourceFieldName(fact.name, program);
    if (!knownNames.has(name)) continue;
    if(Object.hasOwn(selectedSources,name))continue;
    if (program === 'haul' && product.variants.length > 1 && fact.scope===undefined && SKU_DEPENDENT_SOURCE_FIELDS.has(name)) continue;
    const values = confirmed.get(name) ?? new Set<string>(); values.add(fact.value.trim()); confirmed.set(name, values);
  }
  for (const [name, values] of confirmed) if (values.size === 1) {
    if (program === 'haul' && product.facts.some(fact => fact.state === 'conflicting' && (categoryAttributeField(fact.name,fact.value)??sourceFieldName(fact.name, program)) === name)) continue;
    const fact = [...values][0];
    // These bounded roles cannot seed either an excluded value or unparsed raw
    // text into a canonical attribute. Other free-text source mappings are unchanged.
    if((SCOPED_CATEGORY_FIELDS as readonly string[]).includes(name)&&categoryAttributeValues(name,fact).length!==1)continue;
    const value = (program === 'haul'||(CATEGORY_ATTRIBUTE_FIELDS as readonly string[]).includes(name)) && Object.hasOwn(fields, name) ? sourceFactValue(snapshot, name, fact)
      : ['batteries_required','is_dishwasher_safe'].includes(name) && ['true', 'false'].includes(fact) ? fact === 'true'
      : ['number_of_items','item_package_quantity','number_of_packs'].includes(name) && /^\d+$/u.test(fact) && Number(fact) > 0 ? Number(fact) : fact;
    add(name, value);
  }
  for(const [name,value] of Object.entries(selected))if(Object.hasOwn(fields,name))add(name,sourceFactValue(snapshot,name,value));
  // Facts have no variant binding. Global dimensions/counts cannot identify the
  // selected size or pack, even when the product-level fact is confirmed.
  if (program === 'haul') {
    const { measurements } = effectiveSourceMeasurements(product, skuMeasurements);
    Object.assign(attributes, mapMeasurementFields(snapshot, target.marketplaceId, measurements).attributes);
  }
  if (program !== 'haul' && variant.inventory !== null) add('fulfillment_availability', variant.inventory);
  return attributes;
}

/** Explain current source mapping without promoting missing or uncertain facts. */
export function sourceMappingReport(product: ProductDetail, variant: Variant, snapshot: AmazonSchema, target: AmazonTarget, program: ListingProgram = 'standard', attributes?: JsonObject, skuMeasurements: ConfirmedMeasurements = {}): SourceFieldMapping[] {
  product={...product,facts:factsForVariant(product,variant.id)};
  const source = sourceAttributes(product, variant, snapshot, target, program, skuMeasurements); const current = attributes ?? source;
  const authority = program === 'haul' ? currentFactAuthority(product,snapshot,target,current,skuMeasurements) : undefined;
  const selected=selectedSkuCategoryAttributes(variant),selectedSources=selectedSkuCategoryEvidence(variant);
  const facts = new Map<string,Fact[]>(); const measurements = new Map<string,Fact[]>();
  const add = (groups: Map<string,Fact[]>, name: string, fact: Fact) => { const values = groups.get(name) ?? []; values.push(fact); groups.set(name,values); };
  for (const fact of product.facts) if (['source_confirmed','human_confirmed','conflicting'].includes(fact.state) && fact.value.trim()) {
    add(facts,categoryAttributeField(fact.name,fact.value)??sourceFieldName(fact.name,program),fact);
    const measurement = MEASUREMENT_ALIASES[fact.name.trim()]; if (measurement) add(measurements,measurement,fact);
  }
  const numeric = program === 'haul' ? mapMeasurementFields(snapshot,target.marketplaceId,confirmedMeasurements(product)) : {attributes:{},needsInput:[] as string[]};
  return buildFieldCatalog(snapshot).map(card => {
    const field = card.name; const measurementNames = program === 'haul' ? MEASUREMENT_FIELDS[field] ?? [] : [];
    const groups = [facts.get(field) ?? [],...measurementNames.map(name => measurements.get(name) ?? [])];
    const related = [...new Map(groups.flat().map(fact => [fact.id,fact])).values()];
    const sourceFactIds = related.map(fact => fact.id);
    const entry = (status: SourceFieldMapping['status'], reason: string, ids = sourceFactIds): SourceFieldMapping => ({field,status,reason,sourceFactIds:ids});
    if (program === 'haul' && ['fulfillment_availability','externally_assigned_product_identifier','merchant_suggested_asin'].includes(field)) return entry('not_applicable',`Haul 不使用 ${field}，禁止从来源资料自动填入`,[]);
    if (Object.hasOwn(current,field)) {
      const support=authority?.fields.get(field);
      if(support)return entry(support.conflicting?'conflicting':support.supported?'mapped':'needs_input',support.supported?'当前已填分量有匹配来源依据；字段完整性仍由 Schema 校验':'当前已填分量需要核对事实依据；已匹配的来源 ID 保留',support.sourceFactIds);
      const fromSource = Object.hasOwn(source,field) && JSON.stringify(source[field]) === JSON.stringify(current[field]);
      if(fromSource&&Object.hasOwn(selected,field))return entry('mapped','已从所选 SKU 的明确规格映射；未沿用冲突的商品级属性',[]);
      return entry('mapped',fromSource ? (measurementNames.length && Object.keys(skuMeasurements).length ? '已结合当前 SKU 的妙手尺寸重量及单位规则映射；原始依据保留在来源快照，最终以 Schema 校验为准' : '已从可用来源映射；最终是否完整仍由当前 Schema 校验') : '当前草稿已提供此字段；最终是否完整仍由当前 Schema 校验',fromSource ? sourceFactIds.filter(id => related.find(fact=>fact.id===id)?.state !== 'conflicting') : []);
    }
    if (groups.some(group => group.some(fact=>fact.state==='conflicting') || new Set(group.map(fact=>fact.value.trim())).size > 1)) return entry('conflicting',`${field} 的来源事实存在冲突，请确认后再填入`);
    const requirement = card.requirement === 'required' ? 'Schema 必填' : card.requirement === 'conditional' ? 'Schema 条件必填，适用性由完整条件校验决定' : 'Schema 可选';
    if(Object.hasOwn(selectedSources,field)&&!Object.hasOwn(selected,field))return entry('needs_input',`${requirement}；所选 SKU 的来源仅排除某些值或尚无法解析，不能据此填入 ${field}`,[]);
    if (program === 'haul' && product.variants.length > 1 && SKU_DEPENDENT_SOURCE_FIELDS.has(field)) return entry('needs_input',`${requirement}；商品包含多个 SKU，商品级 ${field} 尚未绑定所选 SKU，请确认该 SKU 的专属值后填入`);
    const problems: string[] = [];
    for (const name of measurementNames) {
      const values = measurements.get(name) ?? [];
      if (!values.length) { problems.push(`缺少已确认的 ${name}`); continue; }
      const text = values[0].value.trim();
      if (name === 'unitCount') {
        if (!/^\d+$/u.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) <= 0) problems.push('售卖件数必须是已确认的正整数');
      } else {
        const input = parseMeasurement(text);
        if (!input) problems.push(`${name} 的数值或单位格式无效`);
        else { const converted = convertMeasurement(input.value,input.unit,name.endsWith('.weight') ? 'weight' : 'length'); if (converted.status === 'needs_input') problems.push(`${name}：${converted.reason}`); }
      }
    }
    if (numeric.needsInput.includes(field)) problems.push('转换结果未通过当前 Schema 约束');
    for (const name of numeric.needsInput) if (measurementNames.includes(name) && !problems.some(problem=>problem.includes(name))) problems.push(`${name} 需要确认数值和单位`);
    if (problems.length) return entry('needs_input',`${requirement}；${field}：${problems.join('；')}`);
    return entry('needs_input',`${requirement}；${field} ${sourceFactIds.length ? '已有确认来源但尚未映射，请按当前 Schema 补全或核对' : '缺少已确认的来源资料，需要人工补充'}`);
  });
}
