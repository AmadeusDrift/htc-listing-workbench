import { createHash } from 'node:crypto';
import type { AmazonSchema, AmazonTarget, JsonObject, JsonValue, ListingProgram, SchemaSelection, SourceFieldMapping } from '../../shared/amazon-contracts.ts';
import type { Fact, ProductDetail, Variant } from '../../shared/contracts.ts';
import { isObject, schemaKey } from './context.ts';
import { validateAttributes } from './schema.ts';
import { convertMeasurement, mapMeasurementFields, validateFieldValues, wrapCandidateValues } from './field-mapping.ts';
import type { ConfirmedMeasurements, MeasurementInput, MeasurementSet } from './field-mapping.ts';
import { buildFieldCatalog, fieldSchema, resolveSchemaNode } from './field-catalog.ts';
import { CATEGORY_ATTRIBUTE_FIELDS } from '../../shared/listing-ai-contracts.ts';

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
  const selected=selectedSkuCategoryAttributes(variant),confirmed = new Map<string, Set<string>>();
  for (const fact of product.facts) if (['source_confirmed', 'human_confirmed'].includes(fact.state) && fact.value.trim()) {
    const name = categoryAttributeField(fact.name,fact.value) ?? sourceFieldName(fact.name, program);
    if (!knownNames.has(name)) continue;
    if(Object.hasOwn(selected,name))continue;
    if (program === 'haul' && product.variants.length > 1 && SKU_DEPENDENT_SOURCE_FIELDS.has(name)) continue;
    const values = confirmed.get(name) ?? new Set<string>(); values.add(fact.value.trim()); confirmed.set(name, values);
  }
  for (const [name, values] of confirmed) if (values.size === 1) {
    if (program === 'haul' && product.facts.some(fact => fact.state === 'conflicting' && (categoryAttributeField(fact.name,fact.value)??sourceFieldName(fact.name, program)) === name)) continue;
    const fact = [...values][0];
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

export function sourceFieldName(name: string, program: ListingProgram): string {
  const aliases: Record<string, string> = { 品牌:'brand',颜色:'color',材质:'material',制造商:'manufacturer',原产国:'country_of_origin',是否需要电池:'batteries_required',
    刷毛硬度:'item_firmness_description',刷毛软硬度:'item_firmness_description',软硬度:'item_firmness_description',硬度:'item_firmness_description',
    适用年龄:'age_range_description',年龄范围:'age_range_description',适用人群:'age_range_description',
    是否对热敏感:'is_heat_sensitive',是否热敏:'is_heat_sensitive',热敏感:'is_heat_sensitive',
    供电方式:'power_source_type',电源类型:'power_source_type',动力来源:'power_source_type',
    材料特性:'material_feature',材质特性:'material_feature',材料特点:'material_feature',
    是否有保质期:'is_expiration_dated_product',是否有有效期:'is_expiration_dated_product',是否有到期日期:'is_expiration_dated_product',
    物理形态:'item_form',商品形态:'item_form',产品形态:'item_form',形态:'item_form',牙线类型:'dental_floss_type',牙线种类:'dental_floss_type',
    口味:'flavor',味道:'flavor',是否含液体:'contains_liquid_contents',是否包含液体:'contains_liquid_contents',香型:'scent',香味:'scent',气味:'scent',
    适用场景:'specific_uses_for_product',用途:'specific_uses_for_product',使用用途:'specific_uses_for_product',适用表面:'surface_recommendation',推荐表面:'surface_recommendation',
    闭合方式:'closure',闭合类型:'closure',扣合方式:'closure',部门:'department',适用部门:'department',适用性别:'target_gender',性别:'target_gender',
    成分:'ingredients',配料:'ingredients',主要成分:'ingredients',
    ...(program === 'haul' ? {商品标题:'item_name',商品描述:'product_description',形状:'item_shape',护理说明:'care_instructions',清洗说明:'care_instructions',清洁方式:'care_instructions',洗涤说明:'care_instructions',是否可用洗碗机:'is_dishwasher_safe',商品数量:'number_of_items',售卖件数:'number_of_items',每套件数:'number_of_items',包装数量:'item_package_quantity',包数:'number_of_packs',尺寸:'size',
      原产地:'country_of_origin',危险品法规:'supplier_declared_dg_hz_regulation',适用的产品合规证书类别:'required_product_compliance_certificate',产品合规证书:'required_product_compliance_certificate',GPSR安全声明:'gpsr_safety_attestation'} : {}) };
  return aliases[name.trim()] ?? name.trim();
}
/** Source translations only; this never chooses a value from product-category defaults. */
export function categoryAttributeValues(field:string,value:string):string[]{
  const text=value.trim(),values:string[]=[];
  if(field==='specific_uses_for_product'&&/^(?:toilet|toilet cleaning)$/iu.test(text))return ['Toilet Cleaning'];
  if(field==='dental_floss_type'&&/^(?:floss[ _-]?pick|dental[ _-]?pick|flosser)$/iu.test(text))return ['Floss Pick'];
  if(field==='flavor'&&/^(?:unflavou?red)$/iu.test(text))return ['Unflavored'];
  const match=(canonical:string,pattern:RegExp)=>{if(pattern.test(text))values.push(canonical);};
  if(field==='age_range_description'){
    match('Baby',/婴儿|婴幼儿|\b(?:baby|babies|infant|infants)\b/iu);match('Child',/儿童|小孩|幼儿|\b(?:child|children|kids?|toddler)\b/iu);match('Adult',/成人|成年|\badults?\b/iu);
  }else if(field==='item_firmness_description'){
    match('Extra Soft',/超软|极软|\b(?:extra|ultra)[ -]soft\b/iu);
    if(!values.length)match('Soft',/软毛|柔软|^软$|\bsoft\b/iu);
    match('Medium',/中毛|中等硬度|^中$|\bmedium\b/iu);match('Hard',/硬毛|硬质|^硬$|\b(?:hard|firm)\b/iu);
  }else if(field==='power_source_type'){
    match('Manual',/手动|手摇|\b(?:manual|hand[ -]powered)\b/iu);match('Battery Powered',/电池驱动|电池供电|\bbattery[ -]powered\b/iu);match('Corded Electric',/插电|有线电动|\bcorded[ -]electric\b/iu);if(!values.includes('Corded Electric'))match('Electric',/电动|\belectric\b/iu);
  }else if(field==='is_heat_sensitive'||field==='is_expiration_dated_product'||field==='contains_liquid_contents'){
    match('true',/^(?:true|yes|是|有|需要|热敏|敏感)$/iu);match('false',/^(?:false|no|否|无|不需要|不敏感|非热敏)$/iu);
  }else if(field==='material_feature'){
    const translations:Record<string,string>={'耐用':'Durable','柔韧':'Flexible','可重复使用':'Reusable','一次性':'Disposable'};
    values.push(translations[text]??text);
  }else if(field==='ingredients'){
    const components=text.split(/\s*(?:[+＋,，;；、]|\band\b)\s*/iu),translations:Record<string,string>={'洁厕剂':'Toilet Cleaner','香精':'Fragrance','水':'Water'};
    if(components.every(part=>translations[part]||/^[A-Za-z -]+$/.test(part)))values.push(components.map(part=>translations[part]??part).join(' + '));
  }else{
    const translations:Record<string,Record<string,string>>={
      item_form:{'块状':'Block','固体':'Solid','液体':'Liquid','液态':'Liquid','凝胶':'Gel','粉末':'Powder'},
      dental_floss_type:{'牙线签':'Floss Pick','牙线棒':'Floss Pick','含蜡牙线':'Waxed','无蜡牙线':'Unwaxed'},
      flavor:{'无味':'Unflavored','原味':'Unflavored','薄荷':'Mint'},scent:{'玫瑰':'Rose','薰衣草':'Lavender','无香':'Unscented','无香味':'Unscented'},
      specific_uses_for_product:{'厕所':'Toilet Cleaning','清洁厕所':'Toilet Cleaning','钥匙收纳':'Key Organization'},
      surface_recommendation:{'马桶':'Toilet','厕所':'Toilet','瓷砖':'Tile','陶瓷':'Ceramic'},
      closure:{'开口环':'Split Ring','钥匙圈':'Split Ring','龙虾扣':'Lobster Clasp'},
      department:{'通用':'Unisex','男女通用':'Unisex','男士':'Men','女士':'Women'},
      target_gender:{'通用':'Unisex','男女通用':'Unisex','中性':'Unisex','男':'Male','女':'Female','男性':'Male','女性':'Female'},
    };
    if(translations[field]?.[text])values.push(translations[field][text]);
    else if(Object.hasOwn(translations,field)&&/^[A-Za-z -]+$/.test(text))values.push(text);
  }
  return [...new Set(values)];
}
/** Supported equivalents, or a less specific category implied by the source. */
export function categoryAttributeSourceOptions(field:string,value:string):string[]{
  if(field==='item_form'&&value.toLowerCase()==='block')return ['Solid',value];
  if(field==='specific_uses_for_product'&&value.toLowerCase()==='toilet cleaning')return [value,'Toilet'];
  if(field==='dental_floss_type'&&value.toLowerCase()==='floss pick')return [value,'dental_pick','flosser'];
  return [value];
}
export function categoryAttributeField(name:string,value:string):string|undefined{
  const field=sourceFieldName(name,'haul');
  if((CATEGORY_ATTRIBUTE_FIELDS as readonly string[]).includes(field))return field;
  if(/^(?:产品类别|产品类型|商品类型|工作方式|操作方式|operation_mode|category|product[ _-]?type)$/iu.test(name.trim())&&categoryAttributeValues('power_source_type',value).length)return 'power_source_type';
  if(/^(?:功能|刷毛类型|刷毛|bristles?)$/iu.test(name.trim())&&categoryAttributeValues('item_firmness_description',value).length)return 'item_firmness_description';
  return undefined;
}
/** A supplier's selected SKU is more specific than a product-wide Adult/Soft label. */
export function selectedSkuCategoryAttributes(variant:Variant):Record<string,string>{
  const result:Record<string,string>={};
  for(const field of ['age_range_description','item_firmness_description','power_source_type']){
    for(const spec of [variant.sourceSpec,variant.originalSpec,variant.normalizedSpec]){
      if(!spec?.trim())continue;const values=categoryAttributeValues(field,spec);
      if(values.length){if(values.length===1)result[field]=values[0];break;}
    }
  }
  return result;
}
/** Translate known display labels using this field's own enum, never a global lowercase rule. */
export function sourceFactValue(snapshot: AmazonSchema, field: string, text: string): JsonValue {
  // 1688 uses these labels for an unbranded product; they are not brand names to publish.
  if (field === 'brand' && /^(?:通用|无品牌|无牌|无|generic|no[ _-]?brand|unbranded|[-—/]+|n\/?a)$/iu.test(text.trim())) return 'Generic';
  const raw = fieldSchema(snapshot, field), item = resolveSchemaNode(snapshot.schema, raw.type === 'array' ? raw.items : raw);
  const value = isObject(item.properties) && item.properties.value ? resolveSchemaNode(snapshot.schema, item.properties.value) : item;
  const translated=categoryAttributeValues(field,text);if(translated.length===1)text=translated[0];
  if (value.type === 'boolean') {
    if (/^(?:true|yes|是|需要)$/iu.test(text)) return true;
    if (/^(?:false|no|否|无|不需要|不含)$/iu.test(text)) return false;
  }
  if (['integer','number'].includes(String(value.type)) && /^\d+(?:\.\d+)?$/u.test(text)) return Number(text);
  if (Array.isArray(value.enum)) {
    const exact = value.enum.find(entry => typeof entry === 'string' && entry.toLowerCase() === text.toLowerCase());
    if (exact !== undefined) return exact;
    const index = Array.isArray(value.enumNames) ? value.enumNames.findIndex(entry => typeof entry === 'string' && entry.toLowerCase() === text.toLowerCase()) : -1;
    if (index >= 0 && index < value.enum.length) return value.enum[index];
  }
  return text;
}
const MEASUREMENT_ALIASES: Record<string,string> = { 产品长度:'item.length',商品长度:'item.length',item_length:'item.length', 产品宽度:'item.width',商品宽度:'item.width',item_width:'item.width',
  产品高度:'item.height',商品高度:'item.height',item_height:'item.height', 商品重量:'item.weight',产品重量:'item.weight',净重:'item.weight',item_weight:'item.weight',
  商品深度:'item.depth',产品深度:'item.depth',item_depth:'item.depth',商品厚度:'item.thickness',产品厚度:'item.thickness',item_thickness:'item.thickness',
  包装长度:'package.length',package_length:'package.length',item_package_length:'package.length', 包装宽度:'package.width',package_width:'package.width',item_package_width:'package.width',
  包装高度:'package.height',package_height:'package.height',item_package_height:'package.height',包装深度:'package.depth',item_package_depth:'package.depth', 包装重量:'package.weight',毛重:'package.weight',package_weight:'package.weight',item_package_weight:'package.weight',
  售卖件数:'unitCount',每套件数:'unitCount',unit_count:'unitCount' };
const MEASUREMENT_FIELDS: Record<string,string[]> = {item_dimensions:['item.length','item.width','item.height'],item_length_width:['item.length','item.width'],item_depth_width_height:['item.depth','item.width','item.height'],item_thickness:['item.thickness'],item_weight:['item.weight'],
  item_package_dimensions:['package.length','package.width','package.height'],item_package_weight:['package.weight'],unit_count:['unitCount']};
const SKU_DEPENDENT_SOURCE_FIELDS = new Set(['color','size','number_of_items','item_package_quantity','number_of_packs',...Object.keys(MEASUREMENT_FIELDS)]);
/** Facts currently have no SKU binding. Reuse the mapping scope when selecting AI evidence. */
export function skuDependentSourceFact(name: string): boolean {
  return SKU_DEPENDENT_SOURCE_FIELDS.has(sourceFieldName(name, 'haul')) || Object.hasOwn(MEASUREMENT_ALIASES, name.trim());
}
function parseMeasurement(text: string): MeasurementInput | null {
  const match = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*([a-zA-Z]+|厘米|毫米|米|英寸|克|千克|公斤|磅)?$/u.exec(text);
  if (!match) return null;
  const units: Record<string,string> = {厘米:'cm',毫米:'mm',米:'m',英寸:'in',克:'g',千克:'kg',公斤:'kg',磅:'lb'};
  return {value:Number(match[1]),...(match[2] ? {unit:units[match[2]] ?? match[2].toLowerCase()} : {})};
}
function confirmedMeasurements(product: ProductDetail): ConfirmedMeasurements {
  return effectiveSourceMeasurements(product).measurements;
}
/** Merge SKU-bound receipt data with single-SKU facts; unresolved facts block default substitution. */
export function effectiveSourceMeasurements(product: ProductDetail, receipt: ConfirmedMeasurements = {}): { measurements: ConfirmedMeasurements; blocked: Record<string,string> } {
  const measurements = structuredClone(receipt), blocked: Record<string,string> = {};
  if (product.variants.length !== 1) return { measurements, blocked };
  const groups = new Map<string,Fact[]>();
  for (const fact of product.facts) {
    const name = MEASUREMENT_ALIASES[fact.name.trim()];
    if (!name || !['source_confirmed','human_confirmed','conflicting'].includes(fact.state) && fact.source !== 'manual') continue;
    const entries = groups.get(name) ?? []; entries.push(fact); groups.set(name,entries);
  }
  for (const [name,entries] of groups) {
    const [scope,axis] = name.split('.') as ['item'|'package',keyof MeasurementSet];
    if (name === 'unitCount') delete measurements.unitCount;
    else {
      const group = measurements[scope] ?? {};
      // A present invalid value also prevents the depth→length alias from hiding an explicit conflict.
      group[axis] = { value: null }; measurements[scope] = group;
    }
    const values = new Set(entries.filter(fact => ['source_confirmed','human_confirmed'].includes(fact.state)).map(fact => fact.value.trim()).filter(Boolean));
    if (entries.some(fact => fact.state === 'conflicting') || values.size > 1) { blocked[name] = `${name} 的来源事实存在冲突`; continue; }
    if (values.size !== 1) { blocked[name] = `${name} 的人工值尚未确认`; continue; }
    const text = [...values][0];
    if (name === 'unitCount') {
      if (/^\d+$/u.test(text) && Number.isSafeInteger(Number(text)) && Number(text) > 0) measurements.unitCount = Number(text);
      else blocked[name] = '售卖件数必须是已确认的正整数';
      continue;
    }
    const parsed = parseMeasurement(text);
    if (!parsed) { blocked[name] = `${name} 的数值或单位格式无效`; continue; }
    const group = measurements[scope] ?? {}; group[axis] = parsed; measurements[scope] = group;
    const converted = convertMeasurement(parsed.value, parsed.unit, axis === 'weight' ? 'weight' : 'length');
    if (converted.status === 'needs_input') blocked[name] = `${name}：${converted.reason}`;
  }
  return { measurements, blocked };
}

/** Explain current source mapping without promoting missing or uncertain facts. */
export function sourceMappingReport(product: ProductDetail, variant: Variant, snapshot: AmazonSchema, target: AmazonTarget, program: ListingProgram = 'standard', attributes?: JsonObject, skuMeasurements: ConfirmedMeasurements = {}): SourceFieldMapping[] {
  const source = sourceAttributes(product, variant, snapshot, target, program, skuMeasurements); const current = attributes ?? source;
  const selected=selectedSkuCategoryAttributes(variant);
  const facts = new Map<string,Fact[]>(); const measurements = new Map<string,Fact[]>();
  const add = (groups: Map<string,Fact[]>, name: string, fact: Fact) => { const values = groups.get(name) ?? []; values.push(fact); groups.set(name,values); };
  for (const fact of product.facts) if (['source_confirmed','human_confirmed','conflicting'].includes(fact.state) && fact.value.trim()) {
    add(facts,categoryAttributeField(fact.name,fact.value)??sourceFieldName(fact.name,program),fact);
    const measurement = MEASUREMENT_ALIASES[fact.name.trim()]; if (measurement) add(measurements,measurement,fact);
  }
  const numeric = program === 'haul' && product.variants.length === 1 ? mapMeasurementFields(snapshot,target.marketplaceId,confirmedMeasurements(product)) : {attributes:{},needsInput:[] as string[]};
  return buildFieldCatalog(snapshot).map(card => {
    const field = card.name; const measurementNames = program === 'haul' ? MEASUREMENT_FIELDS[field] ?? [] : [];
    const groups = [facts.get(field) ?? [],...measurementNames.map(name => measurements.get(name) ?? [])];
    const related = [...new Map(groups.flat().map(fact => [fact.id,fact])).values()];
    const sourceFactIds = related.map(fact => fact.id);
    const entry = (status: SourceFieldMapping['status'], reason: string, ids = sourceFactIds): SourceFieldMapping => ({field,status,reason,sourceFactIds:ids});
    if (program === 'haul' && ['fulfillment_availability','externally_assigned_product_identifier','merchant_suggested_asin'].includes(field)) return entry('not_applicable',`Haul 不使用 ${field}，禁止从来源资料自动填入`,[]);
    if (Object.hasOwn(current,field)) {
      const fromSource = Object.hasOwn(source,field) && JSON.stringify(source[field]) === JSON.stringify(current[field]);
      if(fromSource&&Object.hasOwn(selected,field))return entry('mapped','已从所选 SKU 的明确规格映射；未沿用冲突的商品级属性',[]);
      return entry('mapped',fromSource ? (measurementNames.length && Object.keys(skuMeasurements).length ? '已结合当前 SKU 的妙手尺寸重量及单位规则映射；原始依据保留在来源快照，最终以 Schema 校验为准' : '已从可用来源映射；最终是否完整仍由当前 Schema 校验') : '当前草稿已提供此字段；最终是否完整仍由当前 Schema 校验',fromSource ? sourceFactIds.filter(id => related.find(fact=>fact.id===id)?.state !== 'conflicting') : []);
    }
    if (groups.some(group => group.some(fact=>fact.state==='conflicting') || new Set(group.map(fact=>fact.value.trim())).size > 1)) return entry('conflicting',`${field} 的来源事实存在冲突，请确认后再填入`);
    const requirement = card.requirement === 'required' ? 'Schema 必填' : card.requirement === 'conditional' ? 'Schema 条件必填，适用性由完整条件校验决定' : 'Schema 可选';
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
