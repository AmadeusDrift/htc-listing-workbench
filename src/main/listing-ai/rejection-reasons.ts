import { ListingValidationError } from './validation.ts';
import type { FieldRejection } from '../../shared/rejection-presentation.ts';
/** Exact messages from the current trusted exception producer, never model/legacy text. */
const groups:Partial<Record<FieldRejection['code'],readonly string[]>>={
 FIELD_FORMAT_INVALID:['字段结构、字段名或条目格式不符合要求','字段文本不能为空','字段文本长度超出上限','字段文本包含不支持的控制字符','此属性必须为 true 或 false','字段值必须使用美国站英文','搜索关键词的 UTF-8 字节长度超出上限','字段条目数量不符合要求：要点需五条，其他字段需一条','字段包含重复条目','字段条目数量不符合当前类目要求','字段字符或字节长度不符合当前类目要求'],
 FIELD_ENUM_INVALID:['字段值不在当前类目允许的枚举选项中'],
 FIELD_EVIDENCE_CONFLICT:['分类属性与所选 SKU 或明确来源属性冲突','来源事实存在冲突，当前字段声明不能采用','文案或属性与所选 SKU 的明确年龄、刷毛硬度或动力来源冲突','材质、形状或护理字段的翻译与来源不一致'],
 FIELD_EVIDENCE_UNPARSED:['分类属性的明确来源或候选值无法解析，不能据此推断'],
 FIELD_SOURCE_ABSENT:['成分需要明确来源成分依据，不能根据商品类别推断化学配方'],
 FIELD_EVIDENCE_REJECTED:['此字段不允许产品常识推断','仅推断候选可以携带推断理由','候选缺少来源依据引用','引用的来源依据不存在于当前资料','引用属于其他 SKU，不能用于当前商品规格','分类属性需要引用其明确的 SKU 或来源属性','分类属性缺少明确来源；产品判断须标明 infer 和理由','产品判断缺少实际商品类别、材质或所选 SKU 依据','刀刃材质缺少匹配依据；金属指甲刀可凭材质和产品类别两项来源填 Metal，具体钢种仍需明确依据','适用人群缺少明确来源依据；通用人群不能推定具体年龄','主题、角色、面料、功能或配件描述缺少对应类型的来源依据','材质、形状或护理字段引用的依据类型不匹配','颜色或渐变、单色描述缺少当前 SKU 的匹配来源依据','文案中的材质缺少匹配来源依据','尺寸、重量或其他数值缺少匹配的来源数值和单位','文案中的明确分类声明缺少一致的对应来源支持','文案中的分类声明需要引用其实际 SKU 或来源属性'],
};
export function localFieldRejection(error:unknown):Exclude<FieldRejection['code'],'FIELD_CANDIDATE_ABSENT'>{
 if(error instanceof ListingValidationError)for(const [code,values] of Object.entries(groups))if(values.includes(error.validationReason))return code as Exclude<FieldRejection['code'],'FIELD_CANDIDATE_ABSENT'>;
 return 'FIELD_VALIDATION_REJECTED';
}
