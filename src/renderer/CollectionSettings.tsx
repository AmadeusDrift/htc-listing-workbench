import { useEffect, useState } from 'react';
import { FolderOpen, Plug, RefreshCw } from 'lucide-react';
import type { CollectionStatus } from '../shared/collection-contracts';
import type { TaskRunner } from './amazon-ui';
import { errorText } from './utils';
import { SettingsStatusBadge } from './SettingsStatusBadge';
import type { SettingsStatusTone } from './SettingsStatusBadge';

const labels: Record<CollectionStatus['state'], string> = { unprepared: '尚未准备', ready: '等待插件连接', paused: '接收已暂停', closed: '连接已关闭', unavailable: '连接不可用' };
const tones: Record<CollectionStatus['state'], SettingsStatusTone> = { unprepared: 'neutral', ready: 'info', paused: 'neutral', closed: 'neutral', unavailable: 'danger' };
async function connectionAction<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof Error && error.message === 'APP_UNAVAILABLE') throw new Error('采集连接暂时不可用。请确认测试包完整、数据文件夹可写，然后重新准备连接。');
    if (error instanceof Error && error.message === 'APP_BUSY') throw new Error('工作台正在处理数据，请稍后重试采集连接。');
    throw error;
  }
}
export function CollectionSettings({ busy, run }: { busy: boolean; run: TaskRunner }) {
  const [status, setStatus] = useState<CollectionStatus | null>(null);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { let cancelled = false; void window.red.getCollectionStatus().then(value => { if (!cancelled) setStatus(value); }, cause => { if (!cancelled) setError(errorText(cause)); }); return () => { cancelled = true; }; }, []);
  async function action(prepare: boolean) {
    if (working) return;
    setWorking(true); setNotice(''); setError('');
    try {
      const result = await run(prepare ? '正在准备采集连接…' : '正在检查采集连接…', () => connectionAction(() => prepare ? window.red.prepareCollectionConnection() : window.red.getCollectionStatus()));
      if (result) { setStatus(result); if (prepare) setNotice('连接文件已准备。打开连接文件夹，按说明运行 install.ps1 完成浏览器连接。'); }
    } finally { setWorking(false); }
  }
  return <section className="settings-section" aria-label="采集插件连接">
    <div className="settings-section-title"><Plug size={19} /><div><h3>采集插件连接</h3><p>连接浏览器插件，将商品接收到本机采集箱。</p></div></div>
    <dl className="settings-values"><div><dt>本机接收状态</dt><dd><SettingsStatusBadge tone={status ? tones[status.state] : error ? 'danger' : 'info'}>{status ? labels[status.state] : error ? '读取失败' : '正在读取…'}</SettingsStatusBadge></dd></div><div><dt>插件编号</dt><dd className="path-value">{status?.extensionId ?? '—'}</dd></div></dl>
    <div className="workflow-actions">
      <button type="button" className="button primary" disabled={busy || working} onClick={() => void action(true)}><Plug size={15} />准备采集连接</button>
      <button type="button" className="button secondary" disabled={busy || working || !status?.connectionPrepared} onClick={() => void run('正在打开连接文件夹…', () => connectionAction(() => window.red.openCollectionConnectionFolder()))}><FolderOpen size={15} />打开连接文件夹</button>
      <button type="button" className="button secondary" disabled={busy || working} onClick={() => void action(false)}><RefreshCw size={15} />刷新接收状态</button>
    </div>
    {notice && <p className="workflow-notice" role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    <p className="settings-help">首次使用请加载测试包中的采集插件，并安装本机连接组件。之后保持工作台运行，在商品页用插件读取并确认入箱。图片先保留来源链接，真实页面兼容性待联调。</p>
  </section>;
}
