/** Frozen first-import rules and receipt replay for source-attribute-normalization/v1.
 * These operate on sanitized snapshot attributes, never raw HTTP or stored facts. */
import type { SourceAttributeNormalizationRule } from '../../shared/miaoshou-contracts.ts';

// Deliberately independent of listing program, live schema and evolving evidence aliases.
// Chinese display names retain their existing program-specific meaning downstream.
const textNames = new Set([
  'material','材质','color','颜色','item_shape','形状','care_instructions','护理说明','清洗说明','清洁方式','洗涤说明',
  'batteries_required','是否需要电池','is_dishwasher_safe','是否可用洗碗机',
  'item_firmness_description','刷毛硬度','刷毛软硬度','软硬度','硬度','age_range_description','适用年龄','年龄范围','适用人群',
  'is_heat_sensitive','是否对热敏感','是否热敏','热敏感','power_source_type','供电方式','电源类型','动力来源',
  'material_feature','材料特性','材质特性','材料特点','is_expiration_dated_product','是否有保质期','是否有有效期','是否有到期日期',
  'item_form','物理形态','商品形态','产品形态','形态','dental_floss_type','牙线类型','牙线种类','flavor','口味','味道',
  'contains_liquid_contents','是否含液体','是否包含液体','scent','香型','香味','气味','specific_uses_for_product','适用场景','用途','使用用途',
  'surface_recommendation','适用表面','推荐表面','closure','闭合方式','闭合类型','扣合方式','department','部门','适用部门',
  'target_gender','适用性别','性别','ingredients','成分','配料','主要成分',
]);
const lengthNames = new Set([
  '产品长度','商品长度','item_length','产品宽度','商品宽度','item_width','产品高度','商品高度','item_height',
  '商品深度','产品深度','item_depth','商品厚度','产品厚度','item_thickness',
  '包装长度','package_length','item_package_length','包装宽度','package_width','item_package_width',
  '包装高度','package_height','item_package_height','包装深度','item_package_depth',
]);
const weightNames = new Set(['商品重量','产品重量','净重','item_weight','包装重量','毛重','package_weight','item_package_weight']);
// Only spellings jointly supported by the existing mapper and frozen typed evidence.
// No physical unit conversion, invented unit, generic "m" expansion or rounding.
const lengthUnits:Record<string,string> = {cm:'cm',centimeters:'cm',厘米:'cm',mm:'mm',millimeters:'mm',毫米:'mm',in:'inches',inch:'inches',inches:'inches',英寸:'inches'};
const weightUnits:Record<string,string> = {g:'g',grams:'g',克:'g',kg:'kg',kilograms:'kg',公斤:'kg',千克:'kg',lb:'pounds',lbs:'pounds',pound:'pounds',pounds:'pounds',磅:'pounds',oz:'oz',ounces:'oz'};
const width = (value:string):string => value.replace(/[\uFF01-\uFF5E]/g,char=>String.fromCharCode(char.charCodeAt(0)-0xFEE0)).replace(/\u3000/g,' ');

export function normalizeSourceAttributeV1(attribute:{name:string;value:string}):{name:string;value:string;ruleIds:SourceAttributeNormalizationRule[]} {
  const widenedName=width(attribute.name),name=widenedName.trim(),ruleIds:SourceAttributeNormalizationRule[]=[];
  const measurement=lengthNames.has(name)?lengthUnits:weightNames.has(name)?weightUnits:undefined;
  if(!measurement&&!textNames.has(name))return {...attribute,ruleIds};
  if(widenedName!==attribute.name)ruleIds.push('name-ascii-width');
  if(name!==widenedName)ruleIds.push('name-trim');
  const widenedValue=width(attribute.value),trimmed=widenedValue.trim();
  let value=trimmed;
  if(measurement){
    const match=/^([+-]?\d+(?:\.\d+)?)\s*([a-zA-Z]+|厘米|毫米|英寸|克|千克|公斤|磅)$/u.exec(trimmed);
    const unit=match?.[2].toLowerCase();
    // Bare numbers, models, mixed scopes, unsupported or wrong-kind units stay literal.
    if(!match||!unit||!Object.hasOwn(measurement,unit)||!Number.isFinite(Number(match[1])))return {name,value:attribute.value,ruleIds};
    value=`${match[1]} ${measurement[unit]}`;
    if(value.length>4000)return {name,value:attribute.value,ruleIds};
  }
  if(widenedValue!==attribute.value)ruleIds.push('value-ascii-width');
  if(trimmed!==widenedValue)ruleIds.push('value-trim');
  if(value!==trimmed)ruleIds.push('measurement-unit');
  return {name,value,ruleIds};
}
