import { Check, ChevronDown, CircleDashed } from 'lucide-react';
import type { EditorTab } from './utils';

const steps = [
  { id: 'info', label: '商品资料', detail: '来源与事实', tab: 'info' },
  { id: 'variants', label: 'SKU 规格', detail: '规格与采购价', tab: 'variants' },
  { id: 'assets', label: '图片整理', detail: '主图与变体图', tab: 'assets' },
  { id: 'hosting', label: '图片上传', detail: '公开图片地址', tab: 'checks' },
  { id: 'fields', label: '类目字段', detail: '店铺与属性', tab: 'checks' },
  { id: 'validation', label: '校验预览', detail: '发现并修正问题', tab: 'checks' },
  { id: 'publish', label: '正式发布', detail: '提交商品资料', tab: 'checks' },
  { id: 'readback', label: '结果回读', detail: '可售与可见状态', tab: 'checks' },
] as const;

export type WorkflowStep = typeof steps[number]['id'];
interface Props { mode: 'manual' | 'automatic'; tab?: EditorTab; step?: WorkflowStep; onSelect?: (tab: EditorTab, step: WorkflowStep) => void; busy?: boolean }
export function WorkflowRail({ mode, tab, step, onSelect, busy }: Props) {
  const active = mode === 'manual' ? (tab === 'checks' ? step ?? 'fields' : tab ?? 'info') : null;
  const content = <ol className="workflow-steps">{steps.map((step, index) => <li key={step.id} className={active === step.id ? 'current' : ''}>
    <button type="button" disabled={busy || !onSelect} aria-current={active === step.id ? 'step' : undefined} onClick={() => onSelect?.(step.tab, step.id)}>
      <span className="step-number">{String(index + 1).padStart(2, '0')}</span><span className="step-text"><strong>{step.label}</strong><small>{step.detail}</small></span>
    </button>
  </li>)}</ol>;
  return <section className={`workflow-rail ${mode}`} aria-label="完整上架工作流">
    <div className="rail-heading"><span><CircleDashed size={16} />完整上架流程</span><span>{mode === 'manual' ? '按步骤整理，确认后发布' : '启动后自动发布 · 异常转人工'}</span></div>
    <div className="workflow-wide">{content}</div>
    <details className="workflow-compact"><summary><span>{mode === 'manual' ? `当前：${steps.find(step => step.id === active)?.label ?? '商品资料'}` : '8 个阶段 · 自动连续处理'}</span><span>查看全流程<ChevronDown size={15} /></span></summary>{content}</details>
  </section>;
}

export function PreparationStep({ label, detail, available }: { label: string; detail: string; available: boolean }) {
  return <div className={`preparation-step ${available ? 'available' : ''}`}><span className="preparation-mark">{available ? <Check size={16} /> : <CircleDashed size={16} />}</span><div><strong>{label}</strong><p>{detail}</p></div><span className="quiet-pill">{available ? '已配置' : '待接通'}</span></div>;
}
