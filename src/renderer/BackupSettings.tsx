import { useState } from 'react';
import { Copy, Download, LockKeyhole, RotateCcw, Shuffle } from 'lucide-react';
import type { TaskRunner } from './amazon-ui';

export function BackupSettings({ busy, run }: { busy: boolean; run: TaskRunner }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [notice, setNotice] = useState('');
  const [copying, setCopying] = useState(false);
  const disabled = busy || copying;
  const valid = password.length >= 12 && password.length <= 256;
  function generate() {
    try {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const generated = Array.from(bytes, byte => alphabet[byte & 63]).join('');
      setPassword(generated); setConfirmation(generated);
      setNotice('已生成新备份口令，可复制保存。恢复已有备份时，请填写该备份原来的口令。');
    } catch { setNotice('随机口令生成失败，请手动填写口令后重试。'); }
  }
  async function copy() {
    if (!valid || disabled) return;
    setCopying(true); setNotice('');
    try { await window.red.copyBackupPassphrase({ passphrase: password }); setNotice('口令已复制，请妥善保存。'); }
    catch { setNotice('复制失败，请重试，或手动复制填写的口令。'); }
    finally { setCopying(false); }
  }
  async function operate(restore: boolean) {
    setNotice('');
    const result = await run(restore ? '正在校验备份…' : '正在生成加密备份…', () => restore
      ? window.red.restoreWorkspaceBackup({ passphrase: password }) : window.red.createWorkspaceBackup({ passphrase: password }));
    if (!result || result.cancelled) return;
    setPassword(''); setConfirmation('');
    setNotice(restore ? '恢复完成，工作台即将重新启动。' : `已备份 ${result.productCount} 件商品、${result.assetCount} 张图片及上架记录。${result.expiresAt ? `此备份将于 ${new Date(result.expiresAt).toLocaleDateString('zh-CN')} 到期清理。` : ''}`);
  }
  return <section className="settings-section backup-settings"><div className="settings-section-title"><LockKeyhole size={19} /><div><h3>加密备份与恢复</h3><p>保存商品、图片和上架记录，便于换机或恢复资料。</p></div></div>
    <p className="settings-help">备份口令用于加密整个文件，请自行妥善保存。授权密钥不进入备份，恢复后需要重新导入店铺授权。目前支持最多 256 MB 原始数据。</p>
    <p className="settings-help">含 Amazon 资料的完整备份会随数据保留期限到期删除。工作台会在启动和“清理到期数据”时检查已登记的备份；自行复制、改名的副本需要自行按期限清理。</p>
    <div className="backup-fields"><label className="field"><span>备份口令</span><input type="password" aria-label="备份口令" autoComplete="off" minLength={12} maxLength={256} value={password} placeholder="至少 12 个字符" disabled={disabled} onChange={event => { setPassword(event.target.value); setNotice(''); }} /></label>
      <div className="workflow-actions"><button type="button" className="button secondary" disabled={disabled} onClick={generate}><Shuffle size={15} />随机生成口令</button><button type="button" className="button secondary" disabled={disabled || !valid} onClick={() => void copy()}><Copy size={15} />复制口令</button></div>
      <label className="field"><span>创建备份时确认口令</span><input type="password" aria-label="确认备份口令" autoComplete="off" maxLength={256} value={confirmation} disabled={disabled} onChange={event => setConfirmation(event.target.value)} placeholder="恢复已有备份时无需填写" /></label></div>
    <div className="workflow-actions"><button type="button" className="button secondary" disabled={disabled || !valid || password !== confirmation} onClick={() => void operate(false)}><Download size={15} />创建加密备份</button>
      <button type="button" className="button secondary" disabled={disabled || !valid} onClick={() => void operate(true)}><RotateCcw size={15} />从备份恢复</button></div>
    {notice && <p className="amazon-notice" role="status">{notice}</p>}
  </section>;
}
