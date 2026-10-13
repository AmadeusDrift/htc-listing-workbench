import { categoryAttributeValues, parseCategorySource, SCOPED_CATEGORY_FIELDS } from '../listing-ai/evidence-category-v2.ts';
import type { CategorySourceValue } from '../listing-ai/evidence-category-v2.ts';
import type { AmazonSchema, JsonValue, ListingProgram } from '../../shared/amazon-contracts.ts';
import type { Fact, ProductDetail, Variant } from '../../shared/contracts.ts';
import { isObject } from './context.ts';
import { convertMeasurement } from './field-mapping.ts';
import type { ConfirmedMeasurements, MeasurementInput, MeasurementSet } from './field-mapping.ts';
import { fieldSchema, resolveSchemaNode } from './field-catalog.ts';
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
/** A supplier's selected SKU is more specific than a product-wide Adult/Soft label. */
export function selectedSkuCategoryAttributes(variant:Variant):Record<string,string>{
  const result:Record<string,string>={};
  for(const [field,{parsed}] of Object.entries(selectedSkuCategoryEvidence(variant))){
    if(!parsed.unparsed&&parsed.values.length===1&&!parsed.excluded.includes(parsed.values[0]))result[field]=parsed.values[0];
  }
  return result;
}
/** First relevant supplier source wins even when it only excludes or cannot be parsed. */
export function selectedSkuCategoryEvidence(variant:Variant):Record<string,{raw:string;parsed:CategorySourceValue}>{
  const result:Record<string,{raw:string;parsed:CategorySourceValue}>={};
  for(const field of SCOPED_CATEGORY_FIELDS){
    for(const spec of [variant.sourceSpec,variant.originalSpec,variant.normalizedSpec]){
      if(!spec?.trim())continue;const parsed=parseCategorySource(field,spec);
      if(parsed.present){result[field]={raw:spec,parsed};break;}
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
export const MEASUREMENT_ALIASES: Record<string,string> = { 产品长度:'item.length',商品长度:'item.length',item_length:'item.length', 产品宽度:'item.width',商品宽度:'item.width',item_width:'item.width',
  产品高度:'item.height',商品高度:'item.height',item_height:'item.height', 商品重量:'item.weight',产品重量:'item.weight',净重:'item.weight',item_weight:'item.weight',
  商品深度:'item.depth',产品深度:'item.depth',item_depth:'item.depth',商品厚度:'item.thickness',产品厚度:'item.thickness',item_thickness:'item.thickness',
  包装长度:'package.length',package_length:'package.length',item_package_length:'package.length', 包装宽度:'package.width',package_width:'package.width',item_package_width:'package.width',
  包装高度:'package.height',package_height:'package.height',item_package_height:'package.height',包装深度:'package.depth',item_package_depth:'package.depth', 包装重量:'package.weight',毛重:'package.weight',package_weight:'package.weight',item_package_weight:'package.weight',
  售卖件数:'unitCount',每套件数:'unitCount',unit_count:'unitCount' };
export const MEASUREMENT_FIELDS: Record<string,string[]> = {item_dimensions:['item.length','item.width','item.height'],item_length_width:['item.length','item.width'],item_depth_width_height:['item.depth','item.width','item.height'],item_thickness:['item.thickness'],item_weight:['item.weight'],
  item_package_dimensions:['package.length','package.width','package.height'],item_package_weight:['package.weight'],unit_count:['unitCount']};
export function measurementFactName(name:string):string|undefined { return MEASUREMENT_ALIASES[name.trim()]; }
export const SKU_DEPENDENT_SOURCE_FIELDS = new Set(['color','size','number_of_items','item_package_quantity','number_of_packs',...Object.keys(MEASUREMENT_FIELDS)]);
/** Facts currently have no SKU binding. Reuse the mapping scope when selecting AI evidence. */
export function skuDependentSourceFact(name: string): boolean {
  return SKU_DEPENDENT_SOURCE_FIELDS.has(sourceFieldName(name, 'haul')) || Object.hasOwn(MEASUREMENT_ALIASES, name.trim());
}
export function parseMeasurement(text: string): MeasurementInput | null {
  const match = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*([a-zA-Z]+|厘米|毫米|米|英寸|克|千克|公斤|磅)?$/u.exec(text);
  if (!match) return null;
  const units: Record<string,string> = {厘米:'cm',毫米:'mm',米:'m',英寸:'in',克:'g',千克:'kg',公斤:'kg',磅:'lb'};
  return {value:Number(match[1]),...(match[2] ? {unit:units[match[2]] ?? match[2].toLowerCase()} : {})};
}
export function confirmedMeasurements(product: ProductDetail): ConfirmedMeasurements {
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

