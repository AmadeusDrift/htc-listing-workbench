import { useFormGuard, useGuardedNavigation } from './FormGuard';
import { useEffect, useState } from 'react';
import { Gauge, RefreshCw } from 'lucide-react';
import { AI_DAILY_CALL_MAX, AI_DAILY_TOKEN_MAX } from '../shared/ai-contracts';
import type { AiProviderId, AiUsagePolicy, AiUsageSummary } from '../shared/ai-contracts';
import type { TaskRunner } from './amazon-ui';
import { errorText } from './utils';
import { AiConnectionSettings } from './AiConnectionSettings';
import { AiPurposeSettings } from './AiPurposeSettings';
import { AiUsageReport } from './AiUsageReport';
import { CALL_PRESETS, TOKEN_PRESETS, savedLimit, UsageLimitField } from './UsageLimitField';
import { AI_FUNCTION_NAMES, AI_VENDOR_FUNCTIONS, aiVendorFor } from '../shared/ai-connection-contracts';
import type { AiVendorId } from '../shared/ai-connection-contracts';

const names: Record<AiProviderId, string> = {
  'aliyun-ocr': '阿里云 OCR', 'aidge-segmentation': 'Aidge 图片分割',
  'aliyun-image-risk': '阿里云图片侵权风险检测',
  deepseek: 'DeepSeek 文案生成', 'deepseek-review': 'DeepSeek 文案复核',
  openrouter:'OpenRouter 文案生成','openrouter-review':'OpenRouter 文案复核',
};
function limitValue(value: string, maximum: number): number | null | undefined {
  if (value.trim() === '') return null;
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : undefined;
}
const count = (value: number) => value.toLocaleString('zh-CN');

export function AiUsageSettings({ busy, run }: { busy: boolean; run: TaskRunner }) {
  const api = window.red;
  const guarded = useGuardedNavigation();
  const [provider, setProvider] = useState<AiProviderId>('openrouter');
  const vendor = aiVendorFor(provider);
  const selectVendor = (id: AiVendorId) => guarded(() => setProvider(AI_VENDOR_FUNCTIONS[id][0]));
  const [summary, setSummary] = useState<AiUsageSummary | null>(null);
  const [calls, setCalls] = useState(() => savedLimit(null, CALL_PRESETS));
  const [tokens, setTokens] = useState(() => savedLimit(null, TOKEN_PRESETS));
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState('');
  const [loadError, setLoadError] = useState('');
  const textProvider = provider === 'deepseek' || provider === 'deepseek-review' || provider.startsWith('openrouter');
  const callLimit = limitValue(calls.value, AI_DAILY_CALL_MAX);
  const tokenLimit = textProvider ? limitValue(tokens.value, AI_DAILY_TOKEN_MAX) : null;
  const valid = callLimit !== undefined && tokenLimit !== undefined;
  const disabled = busy || loading || working;
  const dirty = summary !== null && (callLimit !== summary.policy.dailyCallLimit || tokenLimit !== summary.policy.dailyTokenLimit);

  function apply(value: AiUsageSummary) {
    setSummary(value); setCalls(savedLimit(value.policy.dailyCallLimit, CALL_PRESETS));
    setTokens(savedLimit(value.policy.dailyTokenLimit, TOKEN_PRESETS));
  }
  useEffect(() => {
    let active = true;
    setLoading(true); setSummary(null); setNotice(''); setLoadError('');
    void api.getAiUsageSummary(provider).then(value => { if (active) apply(value); })
      .catch(error => { if (active) setLoadError(errorText(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, provider]);

  async function refresh() {
    if (working) return;
    setWorking(true);
    try {
      await run('正在读取 AI 用量…', async () => {
        const value = await api.getAiUsageSummary(provider);
        // Refresh usage without discarding an unsaved limit edit.
        if (summary) setSummary(value); else apply(value);
        setLoadError(''); setNotice('用量已刷新。');
      });
    } finally { setWorking(false); }
  }
  async function save() {
    if (!valid || working || !summary) return false;
    let success = false;
    const policy: AiUsagePolicy = { providerId: provider, dailyCallLimit: callLimit, dailyTokenLimit: tokenLimit };
    setWorking(true);
    try {
      await run('正在保存 AI 用量上限…', async () => {
        await api.setAiUsagePolicy(policy);
        apply(await api.getAiUsageSummary(provider)); success = true;
        setNotice(`${names[provider]}的用量上限已保存，将用于后续请求。`);
      });
    } finally { setWorking(false); }
    return success;
  }

  useFormGuard({ dirty: () => dirty, save, discard: () => { if (summary) apply(summary); } });
  return <section className="settings-section ai-settings" aria-label="AI 用量与上限">
    <div className="settings-section-title"><Gauge size={19} /><div><h3>AI 连接、用量与上限</h3><p>每家供应商只填一次密钥；功能、模型和用量上限分别设置。</p></div></div>
    <div className="ai-service-selector">
      <label className="field"><span>供应商</span><select aria-label="AI 连接供应商" value={vendor} disabled={disabled} onChange={event => selectVendor(event.target.value as AiVendorId)}><option value="openrouter">OpenRouter</option><option value="deepseek">DeepSeek</option><option value="aliyun">阿里云</option></select></label>
    </div>
    <div className="ai-settings-columns">
    <div className="ai-connection-column"><AiConnectionSettings key={vendor} vendor={vendor} busy={disabled} run={run} onVendorChange={selectVendor} /></div>
    <section className="ai-usage-column" aria-label="AI 用量管理">
    <div className="credential-heading"><h4>用量与上限</h4><button type="button" className="button secondary" disabled={disabled} onClick={() => void refresh()}><RefreshCw size={15} />刷新 AI 用量</button></div>
    <label className="field"><span>统计功能</span><select aria-label="AI 用量服务" value={provider} disabled={disabled} onChange={event => { const next = event.target.value as AiProviderId; guarded(() => setProvider(next)); }}>{AI_VENDOR_FUNCTIONS[vendor].map(id => <option key={id} value={id}>{AI_FUNCTION_NAMES[id]}</option>)}</select></label>
    <p className="settings-help">这里只统计所选功能；共用密钥后，各功能已有的用量和上限仍分别保留。</p>
    <p className="settings-help">每天按 UTC 00:00（北京时间 08:00）重新计算额度。默认不限制；自定义为 0 时不允许新的调用。失败或中断的发送尝试也会计入次数。</p>
    {loading && <p className="small-copy" role="status">正在读取用量…</p>}
    {loadError && <p className="workflow-warning" role="alert">{loadError}</p>}
    {summary && <>
      <dl className="settings-values" aria-label="当前 AI 用量">
        <div><dt>统计日期</dt><dd>{summary.day} · UTC</dd></div>
        <div><dt>发送尝试</dt><dd>{count(summary.attempts)} 次{summary.policy.dailyCallLimit !== null ? ` / 上限 ${count(summary.policy.dailyCallLimit)} 次` : ' · 未设上限'}</dd></div>
        <div><dt>请求状态</dt><dd>进行中 {count(summary.pendingCalls)} 次 · 用量未确认 {count(summary.unknownCalls)} 次</dd></div>
        {textProvider ? <>
          <div><dt>Token 已占用</dt><dd>{summary.usedTokens === null ? '未知（含旧调用）' : count(summary.usedTokens)}{summary.policy.dailyTokenLimit !== null ? ` / 上限 ${count(summary.policy.dailyTokenLimit)}` : ' · 未设上限'}</dd></div>
          <div><dt>用量构成</dt><dd>已报告 {count(summary.reportedTokens)} · 保留预占 {count(summary.reservedTokens)}</dd></div>
        </> : <div><dt>已报告图片</dt><dd>{count(summary.processedImages)} 张</dd></div>}
      </dl>
      <div className="usage-limit-fields">
        <UsageLimitField label="每日调用次数上限" presetLabel="每日调用次数预设" inputLabel="AI 每日调用次数上限" presets={CALL_PRESETS} unit="次" setting={calls} maximum={AI_DAILY_CALL_MAX} invalid={callLimit === undefined} disabled={disabled} onChange={setCalls} />
        {textProvider && <UsageLimitField label="每日 Token 上限" presetLabel="每日 Token 预设" inputLabel="AI 每日 Token 上限" presets={TOKEN_PRESETS} unit="Token" setting={tokens} maximum={AI_DAILY_TOKEN_MAX} invalid={tokenLimit === undefined} disabled={disabled} onChange={setTokens} />}
      </div>
      <p className="settings-help">{textProvider ? '发送前会为输入和最大输出预占 Token；收到有效用量后结算。无法确认用量的请求保留预占。这里统计本机调用，不代表供应商账单或账号总额度。' : '图片接口按调用次数限制；处理图片数量以供应商返回为准。'}</p>
      {textProvider && summary.unboundedCalls > 0 && <p className="workflow-warning" role="status">有 {count(summary.unboundedCalls)} 次旧调用无法确定 Token 用量；当日设置 Token 上限后，会阻止新的文本请求。</p>}
      {!valid && <p className="workflow-warning" role="alert">请填写范围内的非负整数，或清空表示不限制。</p>}
      <div className="workflow-actions"><button type="button" className="button secondary" disabled={disabled || !valid || !dirty} onClick={() => void save()}>保存 AI 用量上限</button>{dirty && <span className="small-copy">上限尚未保存</span>}</div>
    </>}
    {notice && <p className="workflow-notice" role="status">{notice}</p>}
    </section>
    </div>
    <AiPurposeSettings busy={busy}/>
    <AiUsageReport/>
  </section>;
}
