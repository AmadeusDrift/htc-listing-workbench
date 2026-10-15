import type { AutomaticListingQueue, AutomaticQueueRow } from '../shared/automatic-listing-contracts.ts';
import { presentRejection } from '../shared/rejection-presentation.ts';
import { automaticQueueDisplayKind, automaticQueueReason } from './automatic-product-groups.ts';
import { automaticQueueOutcome } from '../shared/automatic-status-projection.ts';

export type QueueTab = 'all' | 'pending' | 'repair' | 'filtered' | 'submitted';
export type QueueProjection = AutomaticListingQueue['products'][number];
export function queueRowInTab(row: AutomaticQueueRow, tab: QueueTab): boolean {
  if (tab === 'all') return true;
  if (tab === 'filtered') return row.kind === 'RULE_FILTERED';
  if (tab === 'submitted') return ['SUBMITTED', 'COMPLETED'].includes(row.kind);
  if (tab === 'repair') return ['SYSTEM_REPAIR', 'NEEDS_INPUT', 'UNKNOWN', 'UNCLASSIFIED'].includes(row.kind);
  return !['RULE_FILTERED', 'SUBMITTED', 'COMPLETED'].includes(row.kind);
}
export function queueInTab(projection: QueueProjection | undefined, tab: QueueTab): boolean {
  if (!projection) return tab === 'all' || tab === 'pending';
  return tab === 'all' || Boolean(projection.inputIssue && (tab === 'pending' || tab === 'repair')) || projection.rows.some(row => queueRowInTab(row, tab));
}
export function matchesQueueSearch(title: string, projection: QueueProjection | undefined, search: string, tab: QueueTab = 'all'): boolean {
  const query = search.trim().toLocaleLowerCase();
  return !query || [title, ...(projection?.rows.filter(row => queueRowInTab(row, tab)).flatMap(row => [row.sku ?? '', row.specification, automaticQueueReason(row)]) ?? []), projection?.inputIssue && ['all', 'pending', 'repair'].includes(tab) ? presentRejection('SOURCE_INPUT_REQUIRED') : ''].join(' ').toLocaleLowerCase().includes(query);
}
export function queuePresentation(projection: QueueProjection | undefined): { label: string; tone: 'warning' | 'danger' | 'neutral' | 'success' | 'info'; reason: string } {
  if (!projection) return { label: '待核对', tone: 'neutral', reason: '选择目标店铺后核对销售配方与历史结果。' };
  const priority: [AutomaticQueueRow['kind'], string, 'warning' | 'danger' | 'neutral'][] = [
    ['UNKNOWN', '结果未知', 'warning'], ['SYSTEM_REPAIR', '系统待修复', 'danger'], ['NEEDS_INPUT', '待补资料', 'warning'], ['UNCLASSIFIED', '待核对', 'warning'],
  ];
  for (const [kind, label, tone] of priority) {
    const row = projection.rows.find(row => automaticQueueDisplayKind(row) === kind);
    if (row) return { label:automaticQueueOutcome(row)==='invalidOutput'?'已收无效输出':label, tone:automaticQueueOutcome(row)==='invalidOutput'?'warning':tone, reason: automaticQueueReason(row) };
  }
  if (projection.inputIssue) return { label: '待补资料', tone: 'warning', reason: presentRejection('SOURCE_INPUT_REQUIRED') };
  if (projection.eligibleCount) return { label: '可启动', tone: 'info', reason: `${projection.eligibleCount} 个销售 SKU 可启动，其他规格与历史成果保留。` };
  if (projection.rows.some(row => row.kind === 'SUBMITTED')) return { label: '已提交待回读', tone: 'info', reason: '平台接受提交不等于已可售，请在任务中查看回读。' };
  if (projection.rows.length && projection.rows.every(row => row.kind === 'COMPLETED')) return { label: '流程完成', tone: 'success', reason: '查看任务中的备货与标签。' };
  const filtered = projection.rows.find(row => row.kind === 'RULE_FILTERED');
  if (filtered) return { label: {profitFiltered:'利润淘汰',packagingFiltered:'包装抛重限制',notSelected:'本次未选中'}[automaticQueueOutcome(filtered) as 'profitFiltered'|'packagingFiltered'|'notSelected']??'其他规则淘汰', tone: 'neutral', reason: automaticQueueReason(filtered) };
  return { label: '待处理', tone: 'neutral', reason: '查看销售配方与任务记录，确认下一步。' };
}
