// Frozen category parser and aliases for recorded evidence.
import { CATEGORY_ATTRIBUTE_FIELDS } from '../../shared/listing-ai-contracts.ts';
import type { ListingProgram } from '../../shared/amazon-contracts.ts';
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
