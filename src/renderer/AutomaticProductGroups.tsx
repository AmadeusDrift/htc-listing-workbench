import { ActualQuoteDetailsPanel } from './ActualQuoteDetailsPanel';
import { usePageState } from './navigation-context';
import type { ProblemContext } from './navigation-context';
import { useEffect } from 'react';
import { ArrowRight, Box, ChevronDown, Search } from 'lucide-react';
import type { AutomaticListingItem } from '../shared/automatic-listing-contracts';
import { SettingsStatusBadge as Badge } from './SettingsStatusBadge';
import { ImageSlotProgress } from './ImageSlotProgress';
import { automaticItemOutcome, automaticItemReason, filterAutomaticProductGroups } from './automatic-product-groups';
import type { AutomaticItemOutcome, AutomaticProductGroup } from './automatic-product-groups';
import { sourceLabel } from './utils';
import './automatic-product-groups.css';

const stageLabels: Record<AutomaticListingItem['stage'], string> = { PLAN: '来源规格待处理；修正后重新加入任务', SOURCES: '准备来源资料与参考图', CLASSIFY: '自动判断商品类目', DRAFT: '准备文案与草稿', IMAGES: '生成图片、IP 与文字检测', PARENT: '等待父体建档', EXECUTION: '上传图片、验证与提交', READBACK: '已提交，等待读回', LABELS: '核对平台建档结果', COMPLETE: '平台建档已完成' };
const itemLabels: Record<AutomaticItemOutcome, string> = { pending: '待执行', running: '处理中', waiting: '等待服务返回', completed: '流程完成', systemRepair: '系统待修复', unknown:'结果待核对', unclassified:'历史未分类', ruleFiltered: '其他规则淘汰', notSelected:'本次未选中', profitFiltered:'利润淘汰', needsInput: '待补资料', submittedAwaitingReadback: '已提交待回读', labels: '核对建档' };
/** A count that takes its tone colour only when it is non-zero, so problems stand out in a row of numbers. */
export function OutcomeCount({ tone, label, value, suffix = '' }: { tone: 'success' | 'info' | 'warning' | 'danger' | 'neutral'; label: string; value: number; suffix?: string }) {
  return <span className="outcome-count" data-tone={value ? tone : undefined}>{label} {value}{suffix}</span>;
}
interface Actions { busy: boolean; pending: boolean; revision: string; onManual(productId: string, draftId?: string, context?: ProblemContext): void; onShipping?: (batchId: string) => void }

function SalesItem({ item, busy, pending, revision, onManual, onShipping, memoryKey }: Actions & { item: AutomaticListingItem; memoryKey: string }) {
  const [expanded, setExpanded] = usePageState(`task:${memoryKey}:sale:${item.key}`, item.status === 'RUNNING');
  const specification = item.salesPlan?.recipe.specification;
  const outcome = automaticItemOutcome(item);
  const itemTone = outcome === 'systemRepair' ? 'danger' : ['ruleFiltered','profitFiltered','notSelected','needsInput','unknown','unclassified'].includes(outcome) ? 'warning' : outcome === 'completed' ? 'success' : outcome === 'pending' ? 'neutral' : 'info';
  return <li data-testid={`automatic-result-${item.variantId}`} data-state={item.status} data-tone={itemTone}>
    <button type="button" className="automatic-sale-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <span><strong>{item.sku}</strong>{specification && <small>{specification}</small>}<small>{stageLabels[item.stage]}{item.stage === 'READBACK' ? '；Amazon 接受提交不等于已可售。' : ''}</small></span>
      <Badge tone={itemTone}>{itemLabels[outcome]}</Badge><ChevronDown size={16} className={expanded ? 'is-expanded' : ''} />
    </button>
    {(['FAILED','SCREENED','WAITING'].includes(item.status)||['READBACK','LABELS'].includes(item.stage)&&item.status!=='DONE'||item.error)&&<p className="workflow-notice" data-tone={itemTone}>{itemLabels[outcome]}：{automaticItemReason(item)}</p>}
    {expanded && <div className="automatic-sale-body">
      <p className="small-copy">备货 {item.stockSets} 套 · 标签按销售单位生成{item.imageAttempts ? ` · 图片尝试 ${item.imageAttempts} 次` : ''}</p>
      {item.draftId&&<ActualQuoteDetailsPanel draftId={item.draftId} revision={revision}/>}
      {item.draftId && (item.imageStarted || item.stage === 'IMAGES') && <ImageSlotProgress draftId={item.draftId} revision={revision} active={item.stage === 'IMAGES' && item.status === 'RUNNING'} onLocateSlot={imageSlot => onManual(item.productId, item.draftId!, { variantId: item.variantId, imageSlot })} sku={item.sku} color={item.salesPlan?.recipe.color || specification} />}
      {item.classification && <p className="small-copy">类目：{item.classification.productType} · {item.classification.reason}</p>}
      {item.salesPlan && <p className="small-copy">每套 {item.salesPlan.recipe.totalPieces} 件 · {item.salesPlan.relationReason}</p>}
    </div>}
    <div className="workflow-actions">{(item.status === 'FAILED' || item.error) && <button type="button" className="text-button" disabled={busy || pending} title={busy?'当前有操作进行中':pending?'正在处理任务操作':undefined} onClick={() => onManual(item.productId, item.draftId ?? undefined, { variantId: item.variantId })}>查看并处理异常<ArrowRight size={14} /></button>}{item.batchId && onShipping && <button type="button" className="text-button" disabled={busy} onClick={() => onShipping(item.batchId!)}>查看备货与标签<ArrowRight size={14} /></button>}</div>
  </li>;
}

function SourceVariants({ group, query, memoryKey }: { group: AutomaticProductGroup; query: string; memoryKey: string }) {
  const [expanded, setExpanded] = usePageState(`task:${memoryKey}:source:${group.productId}`, Boolean(query));
  useEffect(() => { if (query) setExpanded(true); }, [query]);
  return <details className="automatic-source-variants" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>查看全部 {group.sourceVariantCount} 个来源规格 · {group.excludedCount} 个未纳入本次任务</summary>
    <p className="small-copy">来源规格完整保留，未纳入不等于失败；来源规格数与销售 SKU 数不能相减计算失败数。销售 SKU 可由组套规则组合；下表展示每个来源规格对应的本次销售 SKU。</p>
    <ul data-scroll-key={`source-variants:${group.productId}`}>{group.sourceVariants.map(({ variant, items }) => <li key={variant.id} data-testid={`automatic-source-variant-${variant.id}`} data-selected={Boolean(items.length)} data-search-match={query ? [variant.sku, variant.originalSpec, variant.normalizedSpec, variant.sourceSpec].some(value => value?.toLocaleLowerCase().includes(query)) : undefined}>
      <span><strong>{variant.normalizedSpec || variant.originalSpec || variant.sourceSpec || '未填写规格'}</strong><small>来源 SKU：{variant.sku}</small></span>
      <span>{items.length ? <><Badge tone="info">已纳入本次任务</Badge><small>销售 SKU：{items.map(item => item.sku).join('、')}</small></> : <Badge tone="neutral">未纳入本次任务</Badge>}</span>
    </li>)}</ul>
  </details>;
}

export function AutomaticProductGroups({ groups, sourceErrors, loadingSources, memoryKey = 'current', ...actions }: Actions & { memoryKey?: string; groups: AutomaticProductGroup[]; sourceErrors: Record<string, string>; loadingSources: boolean }) {
  const [expandedIds, setExpandedIds] = usePageState<string[]>(`task:${memoryKey}:expanded`, []);
  const [search, setSearch] = usePageState(`task:${memoryKey}:search`, '');
  const [collapsedSearchIds, setCollapsedSearchIds] = usePageState<string[]>(`task:${memoryKey}:collapsed`, []);
  const visible = filterAutomaticProductGroups(groups, search);
  const query = search.trim().toLocaleLowerCase();
  return <div className="automatic-source-groups">
    <div className="automatic-group-toolbar">
      <label className="automatic-group-search"><Search size={16} /><input type="search" aria-label="搜索任务商品或 SKU" placeholder="搜索商品、颜色、来源或销售 SKU" value={search} onChange={event => { setSearch(event.target.value); setCollapsedSearchIds([]); }} /></label>
      <button type="button" className="text-button" onClick={() => { setExpandedIds(visible.map(group => group.productId)); setCollapsedSearchIds([]); }}>展开全部商品</button>
      <button type="button" className="text-button" onClick={() => { setExpandedIds([]); setSearch(''); }}>收起全部商品</button>
    </div>
    <p className="small-copy">按来源商品链接汇总；展开查看同款销售组、实际父 SKU 和子 SKU。来源链接与 Amazon 父体分别显示。</p>
    {!visible.length && <p className="small-copy" role="status">没有匹配的商品或 SKU。</p>}
    {visible.map(group => {
      const expanded = expandedIds.includes(group.productId) || Boolean(query) && !collapsedSearchIds.includes(group.productId);
      const status = group.statusCounts;
      const outcomes = group.outcomeCounts;
      const groupTone = outcomes.systemRepair ? 'danger' : outcomes.needsInput || outcomes.profitFiltered || outcomes.notSelected || outcomes.ruleFiltered || outcomes.unknown || outcomes.unclassified ? 'warning' : status.DONE === group.items.length ? 'success' : status.RUNNING || outcomes.submittedAwaitingReadback ? 'info' : 'neutral';
      return <article className="automatic-source-group" key={group.productId} data-tone={groupTone} data-testid={`automatic-product-group-${group.productId}`}>
        <button type="button" className="automatic-source-toggle" aria-label={`${expanded ? '收起' : '展开'}来源商品 ${group.title}`} aria-expanded={expanded} aria-controls={`automatic-group-body-${group.productId}`} onClick={() => { setExpandedIds(values => expanded ? values.filter(id => id !== group.productId) : [...values, group.productId]); if (query) setCollapsedSearchIds(values => expanded ? [...values, group.productId] : values.filter(id => id !== group.productId)); }}>
          <span className="workspace-thumb">{group.coverUrl ? <img src={group.coverUrl} alt="来源商品图片" loading="lazy" /> : <Box size={24} strokeWidth={1.35} />}</span>
          <span className="automatic-source-identity"><strong>{group.title}</strong><small>{group.sourceUrl ? sourceLabel(group.sourceUrl) : '来源链接未保存'} · 来源规格 {group.sourceVariantCount ?? (loadingSources ? '读取中' : '未读取')} · 本次销售 SKU {group.items.length}</small><small><OutcomeCount tone="success" label="流程完成" value={outcomes.completed} /> · <OutcomeCount tone="info" label="已提交待回读" value={outcomes.submittedAwaitingReadback} /> · <OutcomeCount tone="info" label="处理中" value={outcomes.running + outcomes.labels} /> · <OutcomeCount tone="info" label="等待服务" value={outcomes.waiting} /> · 待执行 {outcomes.pending}{group.excludedCount !== null ? ` · 未纳入本次 ${group.excludedCount}` : ''}</small>{Boolean(status.FAILED+status.SCREENED) && <small><OutcomeCount tone="warning" label="本次未选中" value={outcomes.notSelected} /> · <OutcomeCount tone="warning" label="利润淘汰" value={outcomes.profitFiltered} /> · <OutcomeCount tone="warning" label="其他规则淘汰" value={outcomes.ruleFiltered} /> · <OutcomeCount tone="warning" label="待补资料" value={outcomes.needsInput} /> · <OutcomeCount tone="danger" label="系统待修复" value={outcomes.systemRepair} /> · <OutcomeCount tone="warning" label="结果待核对" value={outcomes.unknown} /> · <OutcomeCount tone="warning" label="历史未分类" value={outcomes.unclassified} /></small>}</span>
          <Badge tone={groupTone}>{outcomes.systemRepair ? `${outcomes.systemRepair} 个系统待修复` : outcomes.unknown ? `${outcomes.unknown} 个结果待核对` : outcomes.unclassified ? `${outcomes.unclassified} 个历史未分类` : outcomes.needsInput ? `${outcomes.needsInput} 个待补资料` : outcomes.profitFiltered ? `${outcomes.profitFiltered} 个利润淘汰` : outcomes.notSelected ? `${outcomes.notSelected} 个本次未选中` : outcomes.ruleFiltered ? `${outcomes.ruleFiltered} 个规则淘汰` : status.DONE === group.items.length ? '流程全部完成' : outcomes.submittedAwaitingReadback ? `${outcomes.submittedAwaitingReadback} 个已提交待回读` : status.RUNNING ? '处理中' : status.WAITING ? '等待返回' : '待执行'}</Badge>
          <ChevronDown size={17} className={expanded ? 'is-expanded' : ''} />
        </button>
        {expanded && <div className="automatic-source-body" id={`automatic-group-body-${group.productId}`}>
          {sourceErrors[group.productId] && <p className="workflow-notice" role="alert">来源规格读取失败：{sourceErrors[group.productId]}。任务进度仍可查看；请点击“刷新任务”重试。</p>}
          {group.families.map(family => <section className="automatic-sales-family" key={family.key} aria-label={family.parentSku ? `父 SKU ${family.parentSku}` : '销售组'}>
            <div className="automatic-family-heading"><strong>{family.label}</strong><span className="small-copy">{family.items.length} 个销售 SKU{!family.parentSku ? family.items.every(item => item.salesPlan?.familyResolved && item.salesPlan.parentage === 'NONE') ? ' · 独立销售，无 Amazon 父体' : ' · 尚未确认 Amazon 父体' : ' · 已有父 SKU 关系'}</span></div>
            <ul className="automatic-task-items">{family.items.map(item => <SalesItem memoryKey={memoryKey} key={item.key} item={item} {...actions} />)}</ul>
          </section>)}
          {group.sourceVariantCount !== null && <SourceVariants memoryKey={memoryKey} group={group} query={query} />}
        </div>}
      </article>;
    })}
  </div>;
}
