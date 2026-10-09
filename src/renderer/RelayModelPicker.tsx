import { useState } from 'react';
import type { ImageModelCatalog } from '../shared/image-generation-contracts';

export function RelayModelPicker({ value, onChange, catalog, disabled, canSync, syncing, onSync }: {
  value: string; onChange: (model: string) => void; catalog: ImageModelCatalog | null; disabled: boolean; canSync: boolean; syncing: boolean; onSync: () => void;
}) {
  const [query, setQuery] = useState('');
  const [custom, setCustom] = useState(false);
  const models = catalog?.models ?? [], known = models.some(model => model.id === value);
  const filtered = models.filter(model => model.id.toLowerCase().includes(query.toLowerCase().trim()) || model.id === value);
  return <div className="field relay-model-picker">
    <span>生图模型</span>
    <div className="relay-model-search"><input type="search" aria-label="搜索生图模型" placeholder="搜索型号，如 sunburst、gemini" value={query} disabled={disabled} onChange={event => setQuery(event.target.value)} />
      <button type="button" className="button secondary" disabled={!canSync} onClick={onSync}>{syncing ? '正在同步…' : '同步模型列表'}</button></div>
    <select aria-label="生图模型" value={custom ? '__custom__' : value} disabled={disabled} onChange={event => {
      if (event.target.value === '__custom__') { setCustom(true); return; }
      setCustom(false); onChange(event.target.value);
    }}>
      {!known && value && <option value={value}>{value} · 当前填写</option>}
      {(['images', 'gemini', 'unsupported'] as const).map(protocol => <optgroup key={protocol} label={protocol === 'images' ? 'GPT / Images 生图' : protocol === 'gemini' ? 'Gemini 生图' : '其他模型（当前生图流程不支持）'}>
        {filtered.filter(model => model.protocol === protocol).map(model => <option key={model.id} value={model.id} disabled={protocol === 'unsupported'}>{model.id}</option>)}
      </optgroup>)}
      <option value="__custom__">手动填写其他型号…</option>
    </select>
    {custom && <input aria-label="自定义生图模型" value={value} maxLength={200} spellCheck={false} autoComplete="off" disabled={disabled} onChange={event => onChange(event.target.value.trim())} placeholder="填写中转站提供的完整模型 ID" />}
    <small className="image-generation-field-help">{catalog?.source === 'remote' ? `当前 API 分组共 ${models.length} 个模型；同步时间 ${new Date(catalog.fetchedAt!).toLocaleString('zh-CN')}。` : '当前为内置参考型号，保存密钥后可同步你的 API 分组。'}同步仅获取列表，不生成图片。{custom && ' 自定义型号按名称选择 Gemini 或 Images 协议，实际权限由中转站验证。'}</small>
  </div>;
}
