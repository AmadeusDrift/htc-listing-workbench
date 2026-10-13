import { ArrowUpRight, Database, FolderOpen, History, RefreshCw, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AppSettings, AuditEvent, ProductSummary } from '../shared/contracts';
import { formatDate } from './utils';
import { AmazonSettings } from './AmazonSettings';
import { BackupSettings } from './BackupSettings';
import { AiUsageSettings } from './AiUsageSettings';
import { DiagnosticsSettings } from './DiagnosticsSettings';
import { MiaoshouSettings } from './MiaoshouSettings';
import type { AmazonTarget } from '../shared/amazon-contracts';
import type { TaskRunner } from './amazon-ui';
import { ListingRulesSettings } from './ListingRulesSettings';
import { AppearanceSettings } from './AppearanceSettings';
import type { AppearanceController } from './useAppearance';
import { ImageGenerationSettings } from './ImageGenerationSettings';
import { settingsModules, type SettingsModule } from './settings-navigation';
import { HostingSettings } from './HostingSettings';
import { ItemLabelSettings } from './ItemLabelSettings';
import { SkuNamingSettings } from './SkuNamingSettings';

export function AuditView({ events, products, busy, onRefresh }: { events: AuditEvent[]; products: ProductSummary[]; busy: boolean; onRefresh: () => void }) {
  return <section className="utility-panel"><div className="section-heading"><div><h2>操作记录</h2><p>查看商品资料、导入导出和图片关联的本地操作记录。</p></div><button type="button" className="button secondary" disabled={busy} onClick={onRefresh}><RefreshCw size={15} />刷新记录</button></div>
    {events.length === 0 ? <div className="asset-empty"><div className="empty-icon"><History size={32} strokeWidth={1.3} /></div><h3>还没有操作记录</h3><p>创建、保存或导入商品后，记录会出现在这里。</p></div> : <div className="audit-table-wrap"><table className="audit-table"><thead><tr><th>时间</th><th>操作内容</th><th>关联商品</th></tr></thead><tbody>{events.map((event) => <tr key={event.id}><td className="audit-time" data-label="时间">{formatDate(event.createdAt)}</td><td data-label="操作内容"><span className="audit-event-dot" />{event.summary}</td><td data-label="关联商品">{event.productId ? products.find((product) => product.id === event.productId)?.title || `商品 ${event.productId.slice(0, 8)}` : <span className="muted">工作区</span>}</td></tr>)}</tbody></table></div>}
    <div className="utility-footer"><ShieldCheck size={14} />共 {events.length} 条已读取记录</div>
  </section>;
}

export function SettingsView({ settings, busy, onOpenFolder, targets, run, onTargetsChanged, appearance, request, guarded }: { settings: AppSettings; busy: boolean; onOpenFolder: () => void; targets: AmazonTarget[]; run: TaskRunner; onTargetsChanged: () => Promise<void>; appearance: AppearanceController; request: { module: SettingsModule; token: number }; guarded: (action: () => void) => void }) {
  const modules = settingsModules;
  const [selected, setSelected] = useState<string>(request.module);
  useEffect(() => { setSelected(request.module); }, [request]);
  return <section className="utility-panel settings-panel"><div className="section-heading"><div><h2>工作区设置</h2><p>按模块管理连接、商品规则与本地数据。</p></div><span className="version-badge">HTC <span>{settings.appVersion}</span></span></div>
    <div className="settings-layout"><nav className="settings-nav" aria-label="设置模块">{modules.map(([id,label]) => <button type="button" id={`settings-nav-${id}`} key={id} aria-current={selected === id ? 'page' : undefined} onClick={() => guarded(() => setSelected(id))}>{label}</button>)}</nav>
    <label className="field settings-module-select"><span>设置模块</span><select value={selected} onChange={event => { const next = event.target.value; guarded(() => setSelected(next)); }}>{modules.map(([id,label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    <div className="settings-module-content">
    <div hidden={selected !== 'appearance'} aria-label="外观设置"><AppearanceSettings appearance={appearance} /></div>
    <div hidden={selected !== 'images'} aria-label="图片接口设置"><ImageGenerationSettings visible={selected === 'images'} busy={busy} onAiSettings={() => guarded(() => setSelected('ai'))} /></div>
    {selected === 'hosting' && <div aria-label="图片托管设置"><HostingSettings busy={busy} /></div>}
    {selected === 'labels' && <div aria-label="商品标签设置"><ItemLabelSettings busy={busy} /></div>}
    {selected === 'sku' && <div aria-label="SKU 命名设置"><SkuNamingSettings targets={targets} busy={busy} run={run} /></div>}
    <div hidden={selected !== 'data'} aria-label="本地数据与备份">
    <section className="settings-section"><div className="settings-section-title"><Database size={19} /><div><h3>本地数据</h3><p>商品资料和导入的图片保存在以下位置。</p></div><button type="button" className="button secondary" onClick={onOpenFolder} disabled={busy}><FolderOpen size={15} />打开数据文件夹<ArrowUpRight size={13} /></button></div>
      <dl className="settings-values"><div><dt>数据文件夹</dt><dd className="path-value">{settings.dataDirectory}</dd></div><div><dt>商品数据库</dt><dd className="path-value">{settings.databasePath}</dd></div><div><dt>图片文件夹</dt><dd className="path-value">{settings.assetDirectory}</dd></div><div><dt>资料数量</dt><dd>{settings.productCount} 件商品 <span className="settings-separator">/</span> {settings.assetCount} 张图片</dd></div><div><dt>数据格式版本</dt><dd>{settings.schemaVersion}</dd></div></dl>
    </section>
    <BackupSettings busy={busy} run={run} />
    </div>
    <div hidden={selected !== 'ai'} aria-label="AI 连接与用量"><AiUsageSettings busy={busy} run={run} /></div>
    <div hidden={selected !== 'diagnostics'} aria-label="诊断与关于"><DiagnosticsSettings busy={busy} run={run} /><section className="settings-section"><h3>关于 HTC</h3><dl className="settings-values"><div><dt>应用版本</dt><dd>{settings.appVersion}</dd></div><div><dt>数据格式</dt><dd>{settings.schemaVersion}</dd></div></dl></section></div>
    <div hidden={selected !== 'collection'} aria-label="采集连接"><MiaoshouSettings busy={busy} /></div>
    <div hidden={selected !== 'amazon'} aria-label="店铺连接"><AmazonSettings targets={targets} busy={busy} run={run} onTargetsChanged={onTargetsChanged} /></div>
    <div hidden={selected !== 'product' && selected !== 'pricing'} aria-label="商品与定价规则"><ListingRulesSettings section={selected === 'pricing' ? 'pricing' : 'product'} targets={targets} busy={busy} run={run} /></div>
    </div></div>
  </section>;
}
