import { useEffect, useRef, useState } from 'react';
import { ExternalLink, FileInput, RefreshCw } from 'lucide-react';
import type { ProcurementBatch } from '../shared/procurement-contracts';
import type { ShipmentDocument } from '../shared/shipment-document-contracts';
import { SettingsStatusBadge as Badge } from './SettingsStatusBadge';
import { errorText } from './utils';

export function ShipmentDocumentsPanel({ batch, busy, dirty }: { batch: ProcurementBatch; busy: boolean; dirty: boolean }) {
  const api = window.red;
  const [documents, setDocuments] = useState<ShipmentDocument[]>([]);
  const [loading, setLoading] = useState(true), [pending, setPending] = useState(false), [refresh, setRefresh] = useState(0);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true; setLoading(true);
    void api.listProcurementShipmentDocuments(batch.id).then(values => { if (active) setDocuments(values); }, cause => { if (active) setError(errorText(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, batch.id, refresh]);
  async function action(work: () => Promise<string | void>) {
    if (busy || pending) return;
    setPending(true); setError(''); setNotice('');
    try { const message = await work(); if (mounted.current && message) setNotice(message); }
    catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { if (mounted.current) setPending(false); }
  }
  return <div className="shipment-documents">
    <div className="ops-actions"><button type="button" className="button secondary" disabled={busy || pending || loading || dirty || !batch.shipment?.confirmationId.trim()} onClick={() => { void action(async () => { const value = await api.importProcurementShipmentDocument(batch.id); if (value && mounted.current) { setDocuments(values => [value, ...values.filter(row => row.id !== value.id)]); return '货件文件已关联到本备货单'; } }); }}><FileInput size={15} />导入货件 / 箱唛文件</button><button type="button" className="text-button" disabled={busy || pending || loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} />刷新附件</button></div>
    {!batch.shipment && <p className="small-copy">先保存 Amazon 货件号，再导入 Seller Central 下载的货件或箱唛文件。</p>}
    {error && <p className="workflow-notice" role="alert">{error}</p>}{notice && <p className="ops-notice" role="status">{notice}</p>}
    {loading ? <p className="small-copy" role="status">正在读取货件附件…</p> : !documents.length ? <p className="small-copy">尚未关联货件文件。</p> : <ul className="shipment-document-list">{documents.map(value => {
      const matches = value.shipmentId === batch.shipment?.confirmationId;
      return <li key={value.id}><div><strong>{value.fileName}</strong><small>{value.shipmentId} · {(value.byteSize/1024).toFixed(1)} KB · {new Date(value.createdAt).toLocaleString('zh-CN',{hour12:false})}</small><Badge tone={matches ? 'neutral' : 'warning'}>{matches ? '人工关联，未平台核验' : '历史货件附件，与当前货件号不一致'}</Badge></div><button type="button" className="button secondary" aria-label={`打开${value.fileName}`} disabled={busy || pending} onClick={() => { void action(async () => { await api.openProcurementShipmentDocument(value.id); return '已在系统中打开货件文件'; }); }}><ExternalLink size={14} />{matches ? '打开 / 打印' : '查看历史文件'}</button></li>;
    })}</ul>}
  </div>;
}
