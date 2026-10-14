import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticItemReason, summarizeAutomaticItems } from '../src/renderer/automatic-product-groups.ts';
import type { AutomaticListingItem } from '../src/shared/automatic-listing-contracts.ts';
const row=(patch:Partial<AutomaticListingItem>)=>({status:'PENDING',stage:'DRAFT',error:null,...patch} as AutomaticListingItem);
test('every current sales SKU belongs to exactly one summary bucket across all states',()=>{
 const rows=[row({status:'DONE',stage:'COMPLETE'}),row({status:'WAITING',stage:'READBACK'}),row({status:'RUNNING',stage:'LABELS'}),row({status:'RUNNING'}),row({status:'WAITING'}),row({}),...(['RULE_FILTERED','NEEDS_INPUT','SYSTEM_REPAIR','UNKNOWN','UNCLASSIFIED'] as const).map(kind=>row({status:kind==='RULE_FILTERED'?'SCREENED':'FAILED',outcome:{kind} as any}))];
 rows.push(row({status:'SCREENED',outcome:{kind:'RULE_FILTERED',code:'SKU_SELECTION_FILTERED'} as any}),row({status:'SCREENED',outcome:{kind:'RULE_FILTERED',code:'ROI_MAX_PRICE',pricingReport:{}} as any}));
 const before=structuredClone(rows),counts=summarizeAutomaticItems(rows);
 assert.equal(Object.values(counts).reduce((sum,n)=>sum+n,0),rows.length);
 assert.deepEqual(Object.values(counts),Array(13).fill(1));assert.deepEqual(rows,before);
});
test('waiting and failure reasons identify the actual step without leaking raw errors',()=>{
 for(const [patch,text] of [
  [{status:'WAITING',stage:'READBACK'},'等待 Amazon 回读'],
  [{status:'WAITING',stage:'LABELS'},'平台建档结果待核对'],
  [{status:'WAITING',stage:'DRAFT'},'等待字段处理'],
  [{status:'FAILED',outcome:{kind:'UNKNOWN',code:'FIELD_RESULT_UNKNOWN'}},'字段请求结果未知'],
  [{status:'FAILED',outcome:{kind:'UNKNOWN',code:'IMAGE_RESULT_UNKNOWN'}},'图片请求结果未知'],
  [{status:'FAILED',outcome:{kind:'UNKNOWN',code:'SUBMISSION_UNKNOWN'}},'禁止自动重发'],
  [{status:'FAILED',outcome:{kind:'NEEDS_INPUT',code:'READBACK_BRAND_REQUIRES_MANUAL'}},'Generic'],
  [{status:'SCREENED',outcome:{kind:'RULE_FILTERED',code:'SKU_SELECTION_FILTERED'}},'SKU 选择规则淘汰'],
 ] as const){ const reason=automaticItemReason(row({...patch,error:patch.stage==='READBACK'?null:'secret raw service response'} as Partial<AutomaticListingItem>));assert.ok(reason.includes(text),reason);assert.ok(!reason.includes('secret')); }
});

test('readback preserves the explicit 24-hour expiry detail from saved followup',()=>{
 const reason=automaticItemReason(row({status:'FAILED',stage:'READBACK',error:'原提交已满 24 小时，仍未确认处理完成；可继续查询，禁止重复提交',outcome:{kind:'SYSTEM_REPAIR',code:'READBACK_FAILED'} as any}));
 assert.match(reason,/24 小时/);assert.match(reason,/禁止重复提交/);
});

test('typed rule evidence wins over arbitrary raw failure text, while ordinary failures retain sanitized detail',()=>{
 for(const status of ['SCREENED','FAILED'] as const){const reason=automaticItemReason(row({status,error:'secret raw service response',outcome:{kind:'RULE_FILTERED',code:'SKU_SELECTION_FILTERED',message:'untrusted secret fallback'} as any}));assert.match(reason,/SKU 选择规则淘汰/);assert.doesNotMatch(reason,/secret/);}
 const reason=automaticItemReason(row({status:'FAILED',stage:'IMAGES',error:'图位 2 下载超时 https://private.invalid?key=SECRET api_key=PRIVATE',outcome:{kind:'SYSTEM_REPAIR',code:'SYSTEM_FAILURE'} as any}));
 assert.match(reason,/图位 2 下载超时/);assert.doesNotMatch(reason,/private.invalid|SECRET|PRIVATE/);
});
