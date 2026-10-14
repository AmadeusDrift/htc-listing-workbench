import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import type { AutomaticQueueRow } from '../src/shared/automatic-listing-contracts.ts';

test('queue view preserves mixed SKU membership and prioritizes unknown over repair', async () => {
  assert.ok(existsSync('src/renderer/automatic-queue-view.ts'), 'Shared queue presentation must exist');
  const { queueInTab, queuePresentation, matchesQueueSearch } = await import('../src/renderer/automatic-queue-view.ts');
  const row = (kind: AutomaticQueueRow['kind'], eligible = false): AutomaticQueueRow => ({ key: kind, productId: 'p', recipeKey: kind, specification: '蓝色 2件装', sku: 'SKU-002', kind, eligible, message: 'untrusted secret', reconsideration: null, taskId: null });
  const rows = [row('UNKNOWN'), row('SYSTEM_REPAIR'), row('PENDING', true), row('COMPLETED')];
  const projection = { productId: 'p', title: '商品', eligibleCount: 1, pendingCount: 1, filteredCount: 0, rows };
  assert.equal(queueInTab(projection, 'pending'), true);
  assert.equal(queueInTab(projection, 'repair'), true);
  assert.equal(queueInTab(projection, 'submitted'), true);
  assert.equal(queueInTab(projection, 'filtered'), false);
  assert.equal(queuePresentation(projection).label, '结果未知');
  assert.equal(queuePresentation({ ...projection, rows: [row('SYSTEM_REPAIR')] }).tone, 'danger');
  assert.equal(matchesQueueSearch('厨房收纳盒', projection, '收纳'), true);
  assert.equal(matchesQueueSearch('厨房收纳盒', projection, 'sku-002'), true);
  assert.equal(matchesQueueSearch('厨房收纳盒', projection, 'secret'), false, 'Raw model/service errors must not enter search presentation');
  assert.equal(matchesQueueSearch('厨房收纳盒', projection, '不存在'), false);
  const mixed = { ...projection, rows: [{ ...row('RULE_FILTERED'), sku: 'ROI-FILTERED' }, { ...row('SYSTEM_REPAIR'), sku: 'REPAIR-002' }] };
  assert.equal(matchesQueueSearch('厨房收纳盒', mixed, 'ROI-FILTERED', 'repair'), false);
  assert.equal(matchesQueueSearch('厨房收纳盒', mixed, 'REPAIR-002', 'repair'), true);
  assert.equal(matchesQueueSearch('厨房收纳盒', mixed, 'ROI-FILTERED', 'filtered'), true);
  assert.equal(queueInTab({ ...projection, rows: [], inputIssue: 'secret' }, 'repair'), true);
  assert.equal(queueInTab(undefined, 'all'), true);
  assert.equal(queueInTab(undefined, 'pending'), true);
  assert.equal(queueInTab(undefined, 'repair'), false);
  assert.equal(queuePresentation(undefined).label, '待核对');
});

test('legacy service display is consistent in queue without changing eligibility or raw outcome',async()=>{
 const {queuePresentation}=await import('../src/renderer/automatic-queue-view.ts'),{automaticQueueReason}=await import('../src/renderer/automatic-product-groups.ts');
 const row:AutomaticQueueRow={key:'legacy',productId:'p',recipeKey:'r',specification:'蓝色',sku:'S1',kind:'NEEDS_INPUT',reasonCode:'SOURCE_CONSISTENCY_NEEDS_INPUT',eligible:false,message:'AI 服务未完成请求，请核对服务状态和调用记录',reconsideration:null,taskId:'t1'};
 const before=structuredClone(row),projection={productId:'p',title:'商品',eligibleCount:0,pendingCount:1,filteredCount:0,rows:[row]};
 assert.equal(queuePresentation(projection).label,'系统待修复');assert.match(automaticQueueReason(row),/这是历史记录，查看本提示不会重试/);assert.deepEqual(row,before);
 for(const patch of [{message:'缺少来源原图'},{message:row.message+'。'},{reasonCode:'SOURCE_INPUT_REQUIRED'}])assert.equal(queuePresentation({...projection,rows:[{...row,...patch}]}).label,'待补资料');
 assert.equal(queuePresentation({...projection,rows:[{...row,kind:'UNKNOWN'}]}).label,'结果未知');
});
