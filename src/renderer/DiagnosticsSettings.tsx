import { useState } from 'react';
import { Download, ScanSearch, Stethoscope } from 'lucide-react';
import type { DiagnosticAssetKind, DiagnosticAssetStatus, DiagnosticErrorCode, LocalDiagnosticReport } from '../shared/diagnostic-contracts';
import type { TaskRunner } from './amazon-ui';
import { formatDate } from './utils';
import { SettingsStatusBadge } from './SettingsStatusBadge';
import type { SettingsStatusTone } from './SettingsStatusBadge';

const statusLabels: Record<DiagnosticAssetStatus, string> = {
  VERIFIED: '完整性已验证', READABLE_UNVERIFIED: '可读取，完整性未验证', MISSING: '文件缺失',
  CONTENT_MISMATCH: '文件与记录不一致', INVALID_RECORD: '记录无效', UNSAFE_PATH: '路径需核对',
  IO_ERROR: '读取失败', CHANGED_DURING_READ: '检查时文件发生变化',
  SKIPPED_FILE_LIMIT: '文件过大，未检查', SKIPPED_BYTE_LIMIT: '达到读取限额，未检查',
};
const kindLabels: Record<DiagnosticAssetKind, string> = {
  ASSET_ORIGINAL: '原图', ASSET_PREVIEW: '原图预览', IMAGE_VERSION_ORIGINAL: '图片成果', IMAGE_VERSION_PREVIEW: '成果预览',
};
const statusTones: Record<DiagnosticAssetStatus, SettingsStatusTone> = {
  VERIFIED: 'success', READABLE_UNVERIFIED: 'warning', MISSING: 'danger', CONTENT_MISMATCH: 'danger',
  INVALID_RECORD: 'danger', UNSAFE_PATH: 'warning', IO_ERROR: 'danger', CHANGED_DURING_READ: 'warning',
  SKIPPED_FILE_LIMIT: 'warning', SKIPPED_BYTE_LIMIT: 'warning',
};
const errorLabels: Record<DiagnosticErrorCode, string> = {
  DATABASE_MISSING: '数据库缺失', DATABASE_UNAVAILABLE: '无法读取数据库', DATABASE_BUSY: '数据库正被占用',
  DATABASE_CORRUPT: '数据库检查未通过', DATABASE_SCHEMA_UNSUPPORTED: '数据格式版本不受支持',
  INVALID_RECORD: '存在无效记录', UNSAFE_PATH: '数据路径需核对', IO_ERROR: '读取数据失败',
};
const count = (value: number | null) => value === null ? '未能读取' : value.toLocaleString('zh-CN');
const operationErrors: Record<string, string> = {
  DIAGNOSTIC_FAILED: '本地检查未完成，请稍后重试。',
  DIAGNOSTIC_EXPORT_DESTINATION: '请选择工作区数据文件夹以外的 JSON 文件位置。',
  DIAGNOSTIC_EXPORT_FAILED: '诊断报告未能保存，请检查所选文件夹和写入权限。',
  DIAGNOSTIC_EXPORT_NO_SPACE: '磁盘空间不足，诊断报告未保存。请腾出空间后重试。',
};
async function diagnosticAction<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof Error && Object.hasOwn(operationErrors, error.message)) throw new Error(operationErrors[error.message]);
    throw error;
  }
}

export function DiagnosticsSettings({ busy, run }: { busy: boolean; run: TaskRunner }) {
  const [report, setReport] = useState<LocalDiagnosticReport | null>(null);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState('');
  const disabled = busy || working;
  const verified = report?.assets.items.filter(item => item.status === 'VERIFIED').length ?? 0;
  const unhashed = report?.assets.items.filter(item => item.status === 'READABLE_UNVERIFIED').length ?? 0;
  const issues = report?.assets.items.filter(item => !['VERIFIED', 'READABLE_UNVERIFIED'].includes(item.status)) ?? [];
  const recoveryIssues = report?.recovery.items.filter(item => item.state === 'WRITING' || item.state === 'NEEDS_ATTENTION') ?? [];

  async function inspect() {
    if (working) return;
    setWorking(true); setNotice('');
    try {
      const value = await run('正在检查本地数据…', () => diagnosticAction(() => window.red.getLocalDiagnostics()));
      if (value) { setReport(value); setNotice('本地检查完成，结果如下。'); }
    } finally { setWorking(false); }
  }
  async function exportReport() {
    if (working) return;
    setWorking(true); setNotice('');
    try {
      const result = await run('正在生成诊断报告…', () => diagnosticAction(() => window.red.exportLocalDiagnostics()));
      if (result && !result.cancelled) setNotice('诊断报告已保存。');
    } finally { setWorking(false); }
  }

  return <section className="settings-section diagnostics-settings" aria-label="本地诊断">
    <div className="settings-section-title"><Stethoscope size={19} /><div><h3>本地诊断</h3><p>检查素材和恢复状态，导出排查问题所需的报告。</p></div></div>
    <div className="workflow-actions">
      <button type="button" className="button secondary" disabled={disabled} onClick={() => void inspect()}><ScanSearch size={15} />检查本地数据</button>
      <button type="button" className="button secondary" disabled={disabled} onClick={() => void exportReport()}><Download size={15} />导出诊断报告</button>
    </div>
    <p className="settings-help">检查只读取本地资料。每次最多核对 100 份文件、读取 64 MB；超出范围会标明未检查。报告不包含商品文案、密钥、图片链接或本机路径。导出时请选工作区数据文件夹以外的位置。</p>
    {notice && <p className="workflow-notice" role="status">{notice}</p>}
    {report && <>
      <dl className="settings-values" aria-label="本地检查结果">
        <div><dt>检查时间</dt><dd>{formatDate(report.generatedAt)}</dd></div>
        <div><dt>应用与数据</dt><dd>HTC {report.appVersion ?? '版本未确认'} · 数据格式 {report.schemaVersion ?? '未确认'}</dd></div>
        <div><dt>资料数量</dt><dd>{count(report.counts.products)} 件商品 · {count(report.counts.assets)} 张原图 · {count(report.counts.imageVersions)} 份图片成果</dd></div>
        <div><dt>服务状态</dt><dd className="settings-status-list"><SettingsStatusBadge tone={report.services.aiBusy ? 'info' : 'neutral'}>AI {report.services.aiBusy ? '处理中' : '空闲'}</SettingsStatusBadge><SettingsStatusBadge tone={report.services.imageWritesBusy ? 'info' : 'neutral'}>图片保存 {report.services.imageWritesBusy ? '处理中' : '空闲'}</SettingsStatusBadge><SettingsStatusBadge tone={report.services.executionBusy ? 'info' : 'neutral'}>自动任务 {report.services.executionBusy ? '处理中' : '空闲'}</SettingsStatusBadge></dd></div>
        <div><dt>素材检查</dt><dd>已检查 {count(report.assets.inspected)} / {count(report.assets.total)} 份文件 · 完整性通过 {verified} 份 · 待核对或未检查 {issues.length} 份</dd></div>
        <div><dt>预览图说明</dt><dd>{unhashed} 份可读取，但没有历史哈希可供比对，完整性未验证。</dd></div>
        <div><dt>近期写入记录</dt><dd>已读取 {count(report.recovery.inspected)} / {count(report.recovery.total)} 条 · 待处理 {recoveryIssues.length} 条 · 无效 {report.recovery.invalid} 条</dd></div>
      </dl>
      {report.truncated && <p className="workflow-warning" role="status">本次为受限检查，仍有记录或文件未检查。此结果不能代表全部素材已通过。</p>}
      {report.errors.length > 0 && <p className="workflow-warning" role="alert">{report.errors.map(code => `${errorLabels[code]}（${code}）`).join('；')}。可导出报告用于排查。</p>}
      {issues.length > 0 && <details className="diagnostic-details"><summary>查看待核对文件（{issues.length}）</summary>
        <dl className="settings-values">{issues.map((item, index) => <div key={`${item.kind}-${item.recordId}-${index}`}><dt>{kindLabels[item.kind]}</dt><dd className="path-value"><SettingsStatusBadge tone={statusTones[item.status]}>{statusLabels[item.status]}</SettingsStatusBadge> · {item.recordId ?? '无有效记录编号'}</dd></div>)}</dl>
      </details>}
      {recoveryIssues.length > 0 && <details className="diagnostic-details"><summary>查看待处理写入（{recoveryIssues.length}）</summary>
        <dl className="settings-values">{recoveryIssues.map(item => <div key={item.operationId}><dt><SettingsStatusBadge tone={item.state === 'WRITING' ? 'info' : 'warning'}>{item.state === 'WRITING' ? '尚未结束' : '需要处理'}</SettingsStatusBadge></dt><dd className="path-value">{item.code} · {item.operationId}</dd></div>)}</dl>
      </details>}
    </>}
  </section>;
}
