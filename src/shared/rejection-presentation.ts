import { LISTING_CANDIDATE_FIELDS } from './listing-ai-contracts.ts';
import type { CandidateField, ListingFieldsOutput, ListingAiContext } from './listing-ai-contracts.ts';

export const REJECTION_VERSION = 'rejection-presentation/v1' as const;
export const OUTPUT_REJECTION_CODES = ['EMPTY_PROMPT','UNSUPPORTED_MEASUREMENT'] as const;
export type OutputRejection = {version:typeof REJECTION_VERSION;code:typeof OUTPUT_REJECTION_CODES[number] | Exclude<FieldRejection['code'],'FIELD_CANDIDATE_ABSENT'>};
export const FIELD_REJECTION_CODES = ['FIELD_CANDIDATE_ABSENT','FIELD_FORMAT_INVALID','FIELD_ENUM_INVALID','FIELD_EVIDENCE_CONFLICT','FIELD_EVIDENCE_UNPARSED','FIELD_EVIDENCE_REJECTED','FIELD_SOURCE_ABSENT','FIELD_VALIDATION_REJECTED'] as const;
export type FieldRejection = {field:CandidateField;origin:'model-missing'|'local-validation';code:typeof FIELD_REJECTION_CODES[number]};
export interface FieldRejections {version:typeof REJECTION_VERSION;entries:FieldRejection[]}
const invalid=():never=>{throw new Error('Invalid rejection presentation');};
function object(raw:unknown,names:string[]):Record<string,unknown>{
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.getPrototypeOf(raw)!==Object.prototype||Object.keys(raw).sort().join()!==names.sort().join())return invalid();return raw as Record<string,unknown>;
}
export function validateOutputRejection(raw:unknown):OutputRejection{
 const o=object(raw,['version','code']);if(o.version!==REJECTION_VERSION||![...OUTPUT_REJECTION_CODES,...FIELD_REJECTION_CODES.filter(c=>c!=='FIELD_CANDIDATE_ABSENT')].includes(o.code as never))invalid();return {version:REJECTION_VERSION,code:o.code as OutputRejection['code']};
}
export function validateFieldRejections(raw:unknown,output:ListingFieldsOutput,context:ListingAiContext):FieldRejections{
 const o=object(raw,['version','entries']);if(o.version!==REJECTION_VERSION||!Array.isArray(o.entries)||o.entries.length!==output.missing.length)invalid();
 const entries=(o.entries as unknown[]).map(raw=>{const e=object(raw,['field','origin','code']);
  if(!(context.contract?Object.hasOwn(context.fullSchema!.schema.properties as object??{},String(e.field)):LISTING_CANDIDATE_FIELDS.includes(e.field as CandidateField))||!FIELD_REJECTION_CODES.includes(e.code as FieldRejection['code'])||!['model-missing','local-validation'].includes(String(e.origin))||(e.origin==='model-missing')!==(e.code==='FIELD_CANDIDATE_ABSENT')||!output.missing.some(m=>m.field===e.field)||!(context.contract?Object.hasOwn(context.fullSchema!.schema.properties as object??{},String(e.field)):context.fields.some(f=>f.name===e.field)))invalid();
  return {field:e.field as CandidateField,origin:e.origin as FieldRejection['origin'],code:e.code as FieldRejection['code']};});
 if(new Set(entries.map(e=>e.field)).size!==entries.length)invalid();return {version:REJECTION_VERSION,entries};
}
/** Fixed local copy only. Neither arbitrary model reasons nor historical messages are inputs. */
const reasons:Record<string,string>={
 SKU_SELECTION_FILTERED:'SKU 选择规则淘汰：说明性选项或未入选每来源最多 4 个代表规格；原始资料和历史保留。',
 EMPTY_PROMPT:'图片规划缺少可用指令。请查看已保存的规划和调用记录。',
 UNSUPPORTED_MEASUREMENT:'尺寸或重量声明缺少匹配依据。请核对当前 SKU 的真实测量资料。',
 SOURCE_OBSERVATION_INSUFFICIENT:'来源图片不足以确认当前商品。请核对已关联原图和当前规格。',
 FIELD_CANDIDATE_ABSENT:'模型本次未提供可用候选；本地尚未确认具体根因。请查看该字段的来源资料。',
 FIELD_FORMAT_INVALID:'候选格式、语言、长度或条数未通过本地校验。请核对字段要求；其他合格候选已保留。',
 FIELD_ENUM_INVALID:'候选不在当前类目允许的选项中。请核对真实依据与类目选项。',
 FIELD_EVIDENCE_CONFLICT:'候选与当前 SKU 或来源依据冲突。请核对对应字段及原始资料。',
 FIELD_EVIDENCE_UNPARSED:'相关来源或候选无法明确解析。请核对原始属性，不能据此推断。',
 FIELD_EVIDENCE_REJECTED:'候选的来源引用或对应依据未通过本地校验。请核对该字段与当前 SKU 的来源。',
 FIELD_SOURCE_ABSENT:'此字段缺少明确来源资料。请补充实际依据，不填写推测值。',
 FIELD_VALIDATION_REJECTED:'候选未通过本地校验，未保存为可用候选。请核对字段要求与来源。',
 SOURCE_IDENTITY_CONFLICT:'来源身份冲突。请核对当前 SKU 与原始来源绑定。',SOURCE_STORAGE_INVALID:'来源图片存储记录无效。请检查本地来源记录。',
 SOURCE_LINKS_MISSING:'缺少原始图片链接。请补充当前 SKU 的原图。',SOURCE_BINDING_UNCONFIRMED:'原图与当前 SKU 的绑定尚未确认。请进入来源图片核对。',
 SOURCE_REFERENCE_UNUSABLE:'当前来源图片不可用。请核对原图及文件。',SOURCE_DOWNLOAD_FAILED:'来源图片下载未完成。请检查来源同步记录。',
 SOURCE_MAPPING_MISSING:'缺少来源 SKU 映射。请核对原始规格映射。',SOURCE_MAPPING_INVALID:'来源 SKU 映射无效。请修复映射记录。',
 SOURCE_CONSISTENCY_NEEDS_INPUT:'来源图与颜色、形状或图案尚未确认一致。请逐 SKU 核对原图与原始规格。',
 SOURCE_CONSISTENCY_IDENTITY_INVALID:'来源图身份或原始文件已变化。请修复来源记录。',SOURCE_CONSISTENCY_INVALID_OUTPUT:'来源观察未通过格式或记录校验。请核对已有调用记录。',
 SOURCE_CONSISTENCY_UNAVAILABLE:'来源一致性校验服务尚不可用。请检查服务配置。',SOURCE_CONSISTENCY_REQUEST_FAILED:'来源一致性观察请求未完成。请核对调用记录。',
 FACT_AUTHORITY_REQUIRED:'资料缺少可用于上架的真实依据。请补充对应原始事实或人工确认。',FACT_SOURCE_CONFLICT:'上架声明与来源资料冲突。请核对原始事实。',DECLARATION_SOURCE_CONFLICT:'安全声明与当前来源资料冲突。请核对声明依据。',
 AMAZON_BRAND_MANUAL:'品牌已为 Generic，Amazon 仍返回品牌问题，需人工处理。请查看平台具体字段及错误代码；不会自动改品牌或申请品牌批准。',
 SOURCE_INPUT_REQUIRED:'来源资料尚不完整。请进入商品资料核对。',
 CATEGORY_NO_SUITABLE:'本次候选无适用商品类型，需要人工确认类目；原调用、有效结果和费用保留，尚未获取类型 Schema 或创建草稿。',
 CATEGORY_RESULT_UNKNOWN:'类目请求结果未知，请核对或恢复原调用；原身份和费用保留，未确认前不重复发送。',
 ROI_MAX_PRICE:'已确认 ROI 规则未通过：所需价格超过上限。请核对已保存的定价规则与输入。',ROI_PROMOTION_OR_MARGIN:'已确认促销或利润规则未通过。请核对定价记录。',DIMENSIONAL_WEIGHT_LIMIT:'已确认包装抛重超过规则限制。请核对包装测量与规则。',IP_PLAN_BLOCKED:'来源图片触发 IP 风险规则。请核对已保存的风险记录。',IP_IMAGE_BLOCKED:'生成图片触发 IP 风险规则。请核对已保存的风险记录。',
 PRICING_EVIDENCE_STALE:'定价依据已变化。请重新核对实际输入与规则。',COST_CNY_UNCONFIRMED:'采购成本尚未确认。请补充当前销售单位的实际成本。',PACKAGE_MEASUREMENTS_MISSING:'缺少真实包装尺寸或重量。请补充实际测量资料。',PACKAGE_INPUT_UNCONFIRMED:'包装输入尚未确认。请核对实际包装资料。',PACKAGE_SCOPE_UNCONFIRMED:'包装资料范围尚未确认。请核对单件与销售组合。',SOURCE_QUANTITY_CONFLICT:'来源件数存在冲突。请核对销售组合的实际件数。',SOURCE_QUANTITY_UNCONFIRMED:'来源件数尚未确认。请核对实际售卖数量。',SYSTEM_FAILURE:'系统处理未完成，尚无更细的可信归因。请核对已有记录与配置。',EVIDENCE_READ_FAILED:'已保存的依据暂不可读。请检查本地记录，保留当前进度。',
 LEGACY_FAILURE:'历史记录未保存可信的结构化细因，当前无法归因。请核对已有记录。',
 ACTUAL_OFFER_INVALID:'实际报价的币种、受众、站点或价格计划无效，请核对 purchasable_offer。',
 ACTUAL_PRICE_INVALID:'实际售价无效，请填写有限正数。', ACTUAL_PRICE_CAP:'实际正常价或促销价超过售价上限，请核对实际报价。',
 ACTUAL_PRICE_ROI:'实际正常价或促销价未满足目标 ROI，请核对实际报价与费用。', ACTUAL_PRICE_MARGIN:'实际正常售价未满足已设置加价额，请核对实际报价。',
};
export function presentRejection(code:unknown,unknownResult=false):string{
 if(unknownResult||['FIELD_RESULT_UNKNOWN','IMAGE_RESULT_UNKNOWN','SUBMISSION_UNKNOWN','SOURCE_CONSISTENCY_SENT_UNKNOWN'].includes(String(code)))return '上次请求或提交结果未知，已保留记录并阻止自动重发。请核对已有调用、图片或提交记录。';
 return typeof code==='string'&&Object.hasOwn(reasons,code)?reasons[code]:reasons.LEGACY_FAILURE;
}
