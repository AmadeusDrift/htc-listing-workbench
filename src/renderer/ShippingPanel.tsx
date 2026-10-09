import { useState } from 'react';
import { Download, Save } from 'lucide-react';
import type { ProcurementBatch } from '../shared/procurement-contracts';
import type { TaskRunner } from './amazon-ui';
import { SettingsStatusBadge as Badge } from './SettingsStatusBadge';
import { ItemLabelsPanel } from './ItemLabelsPanel';
import { ShipmentDocumentsPanel } from './ShipmentDocumentsPanel';

interface Props {
  batch: ProcurementBatch; busy: boolean; dirty: boolean; run: TaskRunner;
  onChange(batch: ProcurementBatch): void; onSave(): Promise<boolean>;
}
export function ShippingPanel({ batch, busy, dirty, run, onChange, onSave }: Props) {
  const [notice, setNotice] = useState('');
  return <div className="shipping-workspace">
    <div className="ops-panel"><div className="ops-actions"><div className="ops-grow"><h2>{batch.name}</h2><p>{batch.code} · {batch.lines.length} 个 SKU · {batch.mode === 'demo' ? '本地演示' : '正式备货'}</p></div>
      <button type="button" className="button secondary" disabled={busy || dirty} onClick={() => { void run('正在导出备货单…', async () => { const result = await window.red.exportProcurementBatch({ id:batch.id,format:'html' }); if (!result.cancelled) setNotice('备货单已导出'); }); }}><Download size={15} />下载对应备货单</button></div>
      <p>先在“采购备货”填写采购数量和发往 Amazon 的数量，再按这张备货单对应商品与标签。已填写备货数量：{batch.lines.filter(line => line.stockQuantity !== null).length} / {batch.lines.length} 个 SKU。</p>
      {notice && <p className="ops-notice" role="status">{notice}</p>}
    </div>
    <ItemLabelsPanel key={batch.id} batch={batch} busy={busy} dirty={dirty} />
    <section className="ops-panel" aria-label="货件与箱唛"><h2>货件与外箱标签（箱唛）</h2><p>在 Seller Central 创建货件并确认装箱信息，下载对应文件后关联到这张备货单。</p>
      <div className="ops-actions"><label className="ops-grow">Amazon 货件号<input aria-label="Amazon 货件号" value={batch.shipment?.confirmationId ?? ''} disabled={busy} maxLength={100} placeholder="例如 FBA…" onChange={event => onChange({ ...batch,shipment:event.target.value ? { confirmationId:event.target.value,status:'LINKED_UNVERIFIED',linkedAt:batch.shipment?.linkedAt ?? new Date().toISOString() } : null })} /></label><button type="button" className="button primary" disabled={busy || !dirty} onClick={() => { void onSave(); }}><Save size={15} />保存货件号</button></div>
      <Badge tone={dirty ? 'warning' : 'neutral'}>{dirty ? '修改尚未保存' : batch.shipment ? '人工关联，未平台核验' : '还没记录货件号'}</Badge>
      <p>Amazon 入口：管理商品 → 选择商品 → 发／补货 → Send to Amazon。</p><p className="ops-hint">保存的货件号和附件是本地关联记录，不代表 Amazon 已确认发货。商品标签和外箱标签请分别使用。</p>
      <ShipmentDocumentsPanel batch={batch} busy={busy} dirty={dirty} />
    </section>
  </div>;
}
