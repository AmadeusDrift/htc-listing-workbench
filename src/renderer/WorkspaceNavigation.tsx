import { ArrowUpRight, BarChart3, BookOpen, Boxes, ChevronRight, History, Inbox, PackageCheck, PenLine, Settings2, ShieldCheck, Sparkles, Truck, WandSparkles } from 'lucide-react';
import type { AmazonTarget } from '../shared/amazon-contracts';
import type { MainView } from './utils';

export const viewLabels: Record<MainView, string> = { inbox: '采集箱', manual: '手动上架', automatic: '自动上架', results: '上架进度', 'product-data': '商品数据', procurement: '采购备货', shipping: '发货与标签', catalog: '上架类目库', audit: '操作记录', settings: '设置' };
export const viewDescriptions: Record<MainView, string> = {
  inbox: '收集来源商品，选好再开始。', manual: '每一步都清楚，每一项都可确认。', automatic: '让流程连续运行，把注意力留给需要处理的问题。',
  results: '从提交到可售，跟进每一次上架。', audit: '资料变更与操作，始终有迹可循。', settings: '管理店铺连接、备份和本机工作区。',
  'product-data': '只跟踪本软件正式上传的新商品，查看上架状态、销量和库存。',
  procurement: '选好商品、填写数量，下载带 1688 链接的备货单。',
  shipping: '按备货单整理商品标签、箱唛与 Amazon 货件。',
  catalog: '下载站点类目，在本机查找适合商品的上架类型。',
};
const primary = [
  { id: 'inbox', icon: Inbox }, { id: 'manual', icon: PenLine }, { id: 'automatic', icon: WandSparkles }, { id: 'results', icon: PackageCheck },
  { id: 'product-data', icon: BarChart3 }, { id: 'procurement', icon: Boxes }, { id: 'shipping', icon: Truck },
] as const;
interface Props { view: MainView; busy: boolean; counts: Record<'inbox' | 'manual' | 'automatic', number>; targets: AmazonTarget[]; onNavigate: (view: MainView) => void; onExamples: () => void; onConnectionSettings: () => void }
export function WorkspaceNavigation({ view, busy, counts, targets, onNavigate, onExamples, onConnectionSettings }: Props) {
  const live = targets.some(target => target.mode === 'live' && target.configured && !target.paused);
  const demo = targets.some(target => target.mode === 'demo' && !target.paused);
  return <aside className="sidebar"><div className="brand"><span className="brand-logo">H<span /></span><div><strong>HTC<span className="brand-period">.</span></strong><span>独立上架工作台</span></div></div>
    <div className="sidebar-section-label">工作空间</div><nav className="primary-navigation" aria-label="主导航">{primary.map(({ id, icon: Icon }) => <button type="button" key={id} aria-label={viewLabels[id]} title={viewLabels[id]} aria-current={view === id ? 'page' : undefined} disabled={busy} className={view === id ? 'active' : ''} onClick={() => onNavigate(id)}><Icon size={19} /><span>{viewLabels[id]}</span>{(id === 'inbox' || id === 'manual' || id === 'automatic') && <span className="nav-count">{counts[id]}</span>}</button>)}</nav>
    <div className="sidebar-section-label management-label">管理</div><nav className="primary-navigation" aria-label="工作区管理">{([{ id: 'catalog', icon: BookOpen }, { id: 'audit', icon: History }, { id: 'settings', icon: Settings2 }] as const).map(({ id, icon: Icon }) => <button type="button" key={id} aria-label={viewLabels[id]} title={viewLabels[id]} aria-current={view === id ? 'page' : undefined} disabled={busy} className={view === id ? 'active' : ''} onClick={() => onNavigate(id)}><Icon size={19} /><span>{viewLabels[id]}</span></button>)}</nav>
    <div className="sidebar-bottom"><button type="button" className="connection-shortcut" disabled={busy} onClick={onConnectionSettings} title="管理 Amazon 连接"><span className="amazon-letter">a<span /></span><span><strong>Amazon</strong><small>{live ? '店铺已配置' : demo ? '本地演示' : '等待连接店铺'}</small></span><ChevronRight size={14} /></button><button type="button" className="sidebar-example" aria-label="载入示例商品" title="载入示例商品" disabled={busy} onClick={onExamples}><Sparkles size={16} /><span>载入示例商品</span><ArrowUpRight size={13} /></button><div className="workspace-identity"><span className="workspace-avatar">H</span><div><strong>本地工作区</strong><span>资料保存在当前电脑</span></div><ShieldCheck size={16} /></div></div>
  </aside>;
}
