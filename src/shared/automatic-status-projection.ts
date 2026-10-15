import { sanitizeFailureReason } from './automatic-resume.ts';
import { presentRejection } from './rejection-presentation.ts';
import type { AutomaticListingItem, AutomaticQueueRow } from './automatic-listing-contracts.ts';

// Exact compatibility for the old source classifier overwriting a fixed service failure.
// This changes presentation only; arbitrary provider text must not reclassify user input.
const legacySourceServiceMessage = 'AI 服务未完成请求，请核对服务状态和调用记录';
export const legacySourceServiceReason = '历史 AI 服务处理未完成；旧分类待复核，尚未确认缺少商品资料。原始记录保留。这是历史记录，查看本提示不会重试。';
export function legacySourceServiceFailure(kind:unknown,code:unknown,message:unknown):boolean {
  return kind==='NEEDS_INPUT'&&code==='SOURCE_CONSISTENCY_NEEDS_INPUT'&&message===legacySourceServiceMessage;
}
function legacyItemSourceServiceFailure(item:AutomaticListingItem):boolean {
  return item.status==='FAILED'&&item.stage==='SOURCES'&&!item.rejection&&(!item.error||item.error===legacySourceServiceMessage)&&legacySourceServiceFailure(item.outcome?.kind,item.outcome?.code,item.outcome?.message);
}
export function automaticQueueDisplayKind(row:AutomaticQueueRow):AutomaticQueueRow['kind'] {
  return !row.noticeCode&&legacySourceServiceFailure(row.kind,row.reasonCode,row.message)?'SYSTEM_REPAIR':row.kind;
}

export function automaticItemReason(item:AutomaticListingItem):string{return sanitizeFailureReason(itemReason(item));}
function itemReason(item: AutomaticListingItem): string {
  if(legacyItemSourceServiceFailure(item))return legacySourceServiceReason;
  const code = item.outcome?.kind === 'RULE_FILTERED' ? item.outcome.code : item.rejection?.detail.code ?? item.outcome?.code;
  const reasons: Record<string, string> = {
    FIELD_RESULT_UNKNOWN: '字段请求结果未知，请查看已保存的字段调用记录与恢复进度。',
    IMAGE_RESULT_UNKNOWN: '图片请求结果未知，请查看已保存的图片调用记录与恢复进度；已完成图片保留。',
    SOURCE_CONSISTENCY_SENT_UNKNOWN: '来源观察请求结果未知，请查看已保存的来源调用记录与恢复进度。',
    SOURCE_CONSISTENCY_INVALID_OUTPUT: '来源观察已收到完整响应，但输出无法采用；请核对原调用记录。显示修正不会增加重试许可，原次数、费用和发送保护保留。',
    AI_RECEIVED_INVALID_OUTPUT: '请求已收到完整响应，但输出无法采用；请核对原回执和具体校验原因。费用、次数及有界修复条件继续保留。',
    SUBMISSION_UNKNOWN: 'Amazon 正式提交结果未知，禁止自动重发。请查询原提交结果。',
    READBACK_BRAND_REQUIRES_MANUAL: '品牌已为 Generic，Amazon 仍返回品牌问题，需人工处理；请查看平台字段及错误代码。',
    LABELS_FAILED: '商品标签处理失败，请查看备货与标签中的具体原因；已提交商品和已保存文件保留。',
  };
  // Active state is not a new failure. Keep saved rejection evidence explicitly historical;
  // UNKNOWN evidence still uses the safety explanation below, never a normal-state fallback.
  if (['PENDING','RUNNING','DONE'].includes(item.status) && !['READBACK','LABELS'].includes(item.stage)
    && item.outcome?.kind !== 'UNKNOWN' && !(code && /UNKNOWN/u.test(code))) {
    const state = item.status === 'DONE' ? '流程已完成。' : item.status === 'RUNNING' ? '正在处理当前步骤。' : '等待执行当前步骤。';
    const history = item.error || item.outcome?.message || (code ? presentRejection(code) : '');
    return state + (history ? `历史记录（不代表本次失败）：${history}` : '');
  }
  // Typed rule and safety dispositions must not be replaced by provider text.
  if(item.outcome?.kind==='RULE_FILTERED')return presentRejection(code);
  if (code && Object.hasOwn(reasons, code)) return reasons[code];
  if (item.outcome?.kind === 'UNKNOWN') return '结果待核对，请查看当前步骤已保存的调用与恢复记录；正式提交结果未知时禁止自动重发。';
  if(item.status==='FAILED'&&(item.error||item.outcome?.message))return sanitizeFailureReason(item.error||item.outcome!.message);
  if (item.stage === 'READBACK' && (!['DONE', 'FAILED', 'SCREENED'].includes(item.status) || code === 'READBACK_FAILED')) return item.error || item.outcome?.message || '已提交，等待 Amazon 回读确认；接受提交不等于已可售。';
  if (['FAILED', 'SCREENED'].includes(item.status)) return presentRejection(code);
  if (item.stage === 'LABELS') return '平台建档结果待核对，请查看备货与标签中的进度；已提交商品保留。';
  const waiting: Record<AutomaticListingItem['stage'], string> = {
    PLAN: '等待销售规格处理。', SOURCES: '等待来源资料与参考图处理。', CLASSIFY: '等待商品类目判断返回。',
    DRAFT: '等待字段处理返回。', IMAGES: '等待图片生成或检测返回；已完成图片保留。', PARENT: '等待父体建档结果。',
    EXECUTION: '等待图片上传、验证或正式提交处理结果。', READBACK: '', LABELS: '', COMPLETE: '流程已完成。',
  };
  return item.status === 'WAITING' ? waiting[item.stage] : presentRejection(code);
}
export type AutomaticItemOutcome = 'completed' | 'submittedAwaitingReadback' | 'labels' | 'running' | 'waiting' | 'pending' | 'ruleFiltered' | 'notSelected' | 'profitFiltered' | 'packagingFiltered' | 'invalidOutput' | 'needsInput' | 'systemRepair' | 'unknown' | 'unclassified';
/** Presentation only. A pricing report is evidence, not a reason category. */
export function automaticRuleOutcome(code:string|undefined):'notSelected'|'profitFiltered'|'packagingFiltered'|'ruleFiltered' {
  if(code==='SKU_SELECTION_FILTERED')return 'notSelected';
  if(code==='DIMENSIONAL_WEIGHT_LIMIT')return 'packagingFiltered';
  if(['ROI_MAX_PRICE','ROI_PROMOTION_OR_MARGIN','ACTUAL_PRICE_CAP','ACTUAL_PRICE_ROI','ACTUAL_PRICE_MARGIN'].includes(code??''))return 'profitFiltered';
  return 'ruleFiltered';
}
function receivedInvalidCode(code:string|undefined):boolean {
  // Domain codes establish rejected output; generic OUTPUT_INVALID can also mean
  // an incomplete transport and must first be resolved by its domain owner.
  return code==='SOURCE_CONSISTENCY_INVALID_OUTPUT'||code==='AI_RECEIVED_INVALID_OUTPUT';
}
export function automaticQueueOutcome(row:AutomaticQueueRow):AutomaticItemOutcome {
  const kind=automaticQueueDisplayKind(row);
  if(kind==='RULE_FILTERED')return automaticRuleOutcome(row.reasonCode);
  if(kind==='SYSTEM_REPAIR'&&receivedInvalidCode(row.reasonCode))return 'invalidOutput';
  return {SYSTEM_REPAIR:'systemRepair',NEEDS_INPUT:'needsInput',UNKNOWN:'unknown',UNCLASSIFIED:'unclassified',PENDING:'pending',SUBMITTED:'submittedAwaitingReadback',COMPLETED:'completed'}[kind] as AutomaticItemOutcome;
}
export function automaticItemOutcome(item: AutomaticListingItem): AutomaticItemOutcome {
  if(legacyItemSourceServiceFailure(item))return 'systemRepair';
  if (item.status === 'FAILED'||item.status==='SCREENED') {
    if(item.outcome?.kind==='RULE_FILTERED'){
      return automaticRuleOutcome(item.outcome.code);
    }
    if(item.outcome?.kind==='SYSTEM_REPAIR'&&receivedInvalidCode(item.outcome.code))return 'invalidOutput';
    return item.outcome?({RULE_FILTERED:'ruleFiltered',SYSTEM_REPAIR:'systemRepair',NEEDS_INPUT:'needsInput',UNKNOWN:'unknown',UNCLASSIFIED:'unclassified'} as const)[item.outcome.kind]:'unclassified';
  }
  if (item.status === 'DONE') return 'completed';
  if (item.stage === 'READBACK') return 'submittedAwaitingReadback';
  if (item.stage === 'LABELS') return 'labels';
  return item.status === 'RUNNING' ? 'running' : item.status === 'WAITING' ? 'waiting' : 'pending';
}
export function summarizeAutomaticItems(items: AutomaticListingItem[]): Record<AutomaticItemOutcome, number> {
  const counts: Record<AutomaticItemOutcome, number> = { completed: 0, submittedAwaitingReadback: 0, labels: 0, running: 0, waiting: 0, pending: 0, ruleFiltered: 0, notSelected:0, profitFiltered:0, packagingFiltered:0, invalidOutput:0, needsInput: 0, systemRepair: 0, unknown:0,unclassified:0 };
  for (const item of items) counts[automaticItemOutcome(item)]++;
  return counts;
}

