import { useFormGuard } from './FormGuard';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Hash, Plus, RefreshCw, Star, Trash2 } from 'lucide-react';
import { defaultSkuNamingSettings, parseSkuNamingSettings, previewSkuNaming } from '../shared/sku-naming';
import type { SkuNamingApi, SkuNamingBinding, SkuNamingSettings as NamingSettings, SkuNamingTemplate } from '../shared/sku-naming';
import type { AmazonTarget } from '../shared/amazon-contracts';
import type { TaskRunner } from './amazon-ui';
import { errorText } from './utils';
import './SkuNamingSettings.css';

interface Props { busy: boolean; run: TaskRunner; targets: AmazonTarget[]; api?: SkuNamingApi }
export function SkuNamingSettings({ busy, run, targets, api: suppliedApi }: Props) {
  const api = suppliedApi ?? window.red as typeof window.red & SkuNamingApi;
  const [settings, setSettings] = useState<NamingSettings | null>(null), [selectedId, setSelectedId] = useState('');
  const [dirty, setDirty] = useState(false), [working, setWorking] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [newStore, setNewStore] = useState(''), [newPrefix, setNewPrefix] = useState('');
  const [previewStore, setPreviewStore] = useState('U2'), [previewDate, setPreviewDate] = useState('2026-10-08'), [previewSequence, setPreviewSequence] = useState(1);
  const savedSettings = useRef<NamingSettings | null>(null);
  const selected = settings?.templates.find(template => template.id === selectedId);
  useEffect(() => {
    let active = true;
    void api.getSkuNamingSettings().then(value => { if (active) { savedSettings.current = value; setSettings(value); setSelectedId(value.defaultTemplateId); } }, cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [api]);
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);
  const validation = useMemo(() => {
    if (!settings) return '';
    try { parseSkuNamingSettings(settings); return ''; } catch (cause) { return errorText(cause); }
  }, [settings]);
  const preview = useMemo(() => {
    if (!settings || !selected) return { value: null, error: '' };
    try {
      const storeCode = Object.hasOwn(selected.prefixes, previewStore) ? previewStore : Object.keys(selected.prefixes)[0];
      return { value: previewSkuNaming({ settings, templateId: selected.id, storeCode, collectedAt: previewDate + 'T12:00:00+08:00', sequence: previewSequence, childCount: 3 }), error: '' };
    } catch (cause) { return { value: null, error: errorText(cause) }; }
  }, [settings, selected, previewStore, previewDate, previewSequence]);
  function change(next: NamingSettings) { setSettings(next); setDirty(true); setNotice(''); setError(''); }
  function editTemplate(update: Partial<SkuNamingTemplate>) {
    if (settings && selected) change({ ...settings, templates: settings.templates.map(template => template.id === selected.id ? { ...template, ...update } : template) });
  }
  function addTemplate(copy: boolean) {
    if (!settings || !selected) return;
    const template = structuredClone(copy ? selected : defaultSkuNamingSettings().templates[0]);
    template.id = crypto.randomUUID(); template.name = copy ? `${selected.name.slice(0, 70)} 副本` : '新模板';
    change({ ...settings, templates: [...settings.templates, template] }); setSelectedId(template.id); setNewStore(''); setNewPrefix('');
  }
  function setBinding(binding: SkuNamingBinding | null, match: (value: SkuNamingBinding) => boolean) {
    if (!settings) return;
    change({ ...settings, bindings: [...settings.bindings.filter(value => !match(value)), ...(binding ? [binding] : [])] });
  }
  async function reload() {
    setWorking(true); setError(''); setNotice('');
    try { const value = await api.getSkuNamingSettings(); savedSettings.current = value; setSettings(value); setSelectedId(value.defaultTemplateId); setDirty(false); }
    catch (cause) { setError(errorText(cause)); }
    finally { setWorking(false); }
  }
  async function save() {
    if (!settings || working) return false;
    let success = false;
    setWorking(true); setError(''); setNotice('');
    try {
      const valid = parseSkuNamingSettings(settings);
      await run('正在保存 SKU 命名规则…', async () => {
        try {
          const saved = await api.saveSkuNamingSettings(valid);
          savedSettings.current = saved; success = true; setSettings(saved); setDirty(false); setNotice(`规则版本 ${saved.revision} 已保存，新商品组将使用此设置。`);
        } catch (cause) { setError(errorText(cause)); throw cause; }
      });
    } catch (cause) { setError(errorText(cause)); }
    finally { setWorking(false); }
    return success;
  }
  useFormGuard({ dirty: () => dirty, save, discard: () => {
    if (savedSettings.current) { setSettings(savedSettings.current); setSelectedId(savedSettings.current.defaultTemplateId); }
    setDirty(false); setError('');
  } });
  if (!settings || !selected) return <section className="settings-section"><p role={error ? 'alert' : 'status'}>{error || '正在读取 SKU 命名规则…'}</p>{error && <button type="button" className="button secondary" onClick={() => void reload()}>重新读取</button>}</section>;
  const codes = [...new Set(settings.templates.flatMap(template => Object.keys(template.prefixes)))].sort();
  const previewCode = Object.hasOwn(selected.prefixes, previewStore) ? previewStore : Object.keys(selected.prefixes)[0];
  return <form className="settings-section sku-naming-settings" onSubmit={event => { event.preventDefault(); void save(); }}>
    <div className="settings-section-title"><Hash size={19} /><div><h3>SKU 命名规则</h3><p>按店铺和采集日期连续编号，父体、子体与独立款使用同一套规则。</p></div></div>
    <fieldset className="sku-naming-fieldset" disabled={busy || working}>
      <div className="sku-naming-toolbar">
        <label className="field"><span>命名模板</span><select value={selected.id} onChange={event => { setSelectedId(event.target.value); setNewStore(''); setNewPrefix(''); }}>{settings.templates.map(template => <option key={template.id} value={template.id}>{template.name}{settings.defaultTemplateId === template.id ? ' · 默认' : ''}</option>)}</select></label>
        <button type="button" className="button secondary" disabled={settings.templates.length >= 50} onClick={() => addTemplate(false)}><Plus size={15} />新建模板</button>
        <button type="button" className="button secondary" disabled={settings.templates.length >= 50} onClick={() => addTemplate(true)}><Copy size={15} />复制当前模板</button>
        <button type="button" className="button secondary" disabled={settings.defaultTemplateId === selected.id} onClick={() => change({ ...settings, defaultTemplateId: selected.id })}><Star size={15} />{settings.defaultTemplateId === selected.id ? '当前默认模板' : '设为默认模板'}</button>
      </div>
      <div className="sku-naming-columns">
        <div className="sku-naming-editor">
          <label className="field"><span>模板名称</span><input value={selected.name} maxLength={80} onChange={event => editTemplate({ name: event.target.value })} /></label>
          <label className="field"><span>父体与独立款模板</span><input className="sku-naming-mono" value={selected.basePattern} maxLength={120} onChange={event => editTemplate({ basePattern: event.target.value })} /></label>
          <p className="settings-help">可调整顺序和分隔符。各保留一次：{'{prefix}'} 前缀、{'{date}'} 采集日期、{'{sequence}'} 流水号。</p>
          <label className="field"><span>子体模板</span><input className="sku-naming-mono" value={selected.childPattern} maxLength={120} onChange={event => editTemplate({ childPattern: event.target.value })} /></label>
          <p className="settings-help">{'{parent}'} 为父体 SKU；{'{child}'} 按 A、B…Z、AA 递增。已分配字母不会随排序改变。</p>
          <div className="sku-naming-pair"><label className="field"><span>日期格式</span><select value={selected.dateFormat} onChange={event => editTemplate({ dateFormat: event.target.value as SkuNamingTemplate['dateFormat'] })}><option value="yymmdd">年月日 · 261008</option><option value="yyyymmdd">完整年月日 · 20261008</option><option value="yyyy-mm-dd">带连字符 · 2026-10-08</option></select></label><label className="field"><span>流水号补零位数</span><input type="number" min={1} max={9} step={1} value={Number.isNaN(selected.sequencePadding) ? '' : selected.sequencePadding} onChange={event => editTemplate({ sequencePadding: event.target.value === '' ? NaN : Number(event.target.value) })} /></label></div>
        </div>
        <aside className="sku-naming-preview" aria-label="SKU 实时预览">
          <h4>实时预览</h4><p className="settings-help">使用下方示例值，不会分配或占用号码。</p>
          <div className="sku-naming-pair"><label className="field"><span>预览店铺</span><select value={previewCode} onChange={event => setPreviewStore(event.target.value)}>{Object.keys(selected.prefixes).map(code => <option key={code}>{code}</option>)}</select></label><label className="field"><span>预览流水号</span><input type="number" min={1} max={999999999} step={1} value={Number.isNaN(previewSequence) ? '' : previewSequence} onChange={event => setPreviewSequence(event.target.value === '' ? NaN : Number(event.target.value))} /></label></div>
          <label className="field"><span>示例采集日期（北京时间）</span><input type="date" value={previewDate} onChange={event => setPreviewDate(event.target.value)} /></label>
          {preview.value ? <div className="sku-naming-samples"><span>父体或独立款</span><code aria-label="父体或独立 SKU 预览">{preview.value.baseSku}</code><span>子体</span>{preview.value.childSkus.map(sku => <code key={sku}>{sku}</code>)}</div> : <p className="settings-help">修正规则或示例值后显示预览。</p>}
          <p className="settings-help">每个 SKU 最长 40 位。第 100 个商品组之后，下一个为 101；跨采集日重新从 1 计数。</p>
        </aside>
      </div>
      <div className="settings-subsection"><h4>当前模板的店铺前缀</h4><div className="sku-naming-prefixes">{Object.entries(selected.prefixes).map(([code, prefix]) => <div className="sku-naming-prefix" key={code}><label className="field"><span>{code} 前缀</span><input value={prefix} maxLength={16} onChange={event => editTemplate({ prefixes: { ...selected.prefixes, [code]: event.target.value } })} /></label><button type="button" className="button secondary" disabled={Object.keys(selected.prefixes).length === 1 || settings.bindings.some(binding => binding.templateId === selected.id && binding.storeCode === code)} title="已绑定店铺的前缀请先解除或更改绑定" aria-label={`移除 ${code} 前缀`} onClick={() => { const prefixes = { ...selected.prefixes }; delete prefixes[code]; editTemplate({ prefixes }); }}><Trash2 size={14} /></button></div>)}</div>
        <div className="sku-naming-add"><label className="field"><span>新增店铺编号</span><input value={newStore} placeholder="例如 U9" maxLength={100} onChange={event => setNewStore(event.target.value)} /></label><label className="field"><span>新增 SKU 前缀</span><input value={newPrefix} placeholder="例如 H9" maxLength={16} onChange={event => setNewPrefix(event.target.value)} /></label><button type="button" className="button secondary" disabled={!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(newStore) || ['__proto__', 'constructor', 'prototype'].includes(newStore) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/.test(newPrefix) || Object.hasOwn(selected.prefixes, newStore) || Object.keys(selected.prefixes).length >= 100} onClick={() => { editTemplate({ prefixes: { ...selected.prefixes, [newStore]: newPrefix } }); setNewStore(''); setNewPrefix(''); }}>添加前缀</button></div>
      </div>
      <div className="settings-subsection"><h4>店铺使用的模板</h4><div className="sku-naming-prefixes">{codes.map(code => {
        const binding = settings.bindings.find(item => item.targetId === undefined && item.storeCode === code);
        return <label className="field" key={code}><span>{code} 默认使用模板</span><select value={binding?.templateId ?? ''} onChange={event => setBinding(event.target.value ? { storeCode: code, templateId: event.target.value } : null, item => item.targetId === undefined && item.storeCode === code)}><option value="">跟随默认模板</option>{settings.templates.filter(template => Object.hasOwn(template.prefixes, code)).map(template => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>;
      })}</div>
        {targets.length > 0 && <div className="sku-naming-targets">{targets.map(target => {
          const binding = settings.bindings.find(item => item.targetId === target.id), available = settings.templates.filter(template => binding && Object.hasOwn(template.prefixes, binding.storeCode));
          return <div className="sku-naming-target" key={target.id}><span className="sku-naming-target-name">{target.name}</span><label className="field"><span>{target.name} 使用店铺编号</span><select value={binding?.storeCode ?? ''} onChange={event => {
            const storeCode = event.target.value, options = settings.templates.filter(template => Object.hasOwn(template.prefixes, storeCode));
            const chosen = options.find(template => template.id === binding?.templateId) ?? options.find(template => template.id === settings.defaultTemplateId) ?? options[0];
            setBinding(storeCode && chosen ? { targetId: target.id, storeCode, templateId: chosen.id } : null, item => item.targetId === target.id);
          }}><option value="">使用商品规则中的店铺编号</option>{codes.map(code => <option key={code}>{code}</option>)}</select></label><label className="field"><span>{target.name} 使用 SKU 模板</span><select value={binding?.templateId ?? ''} disabled={!binding} onChange={event => { if (binding) setBinding({ ...binding, templateId: event.target.value }, item => item.targetId === target.id); }}><option value="" disabled>先选择店铺编号</option>{available.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label></div>;
        })}</div>}
      </div>
      <p className="settings-help">修改只影响后续新商品组。已分配的 SKU 和模板快照保留，重试沿用原号，取消后不会归还号码。</p>
      <div className="sku-naming-actions"><button type="submit" className="button primary" disabled={!dirty || !!validation}>保存 SKU 命名规则</button><button type="button" className="button secondary" onClick={() => void reload()}><RefreshCw size={15} />{dirty ? '放弃修改并重新读取' : '重新读取'}</button><span className="settings-help">{dirty ? '有未保存修改' : `当前规则版本 ${settings.revision}`}</span></div>
    </fieldset>
    {(error || validation || preview.error) && <p className="workflow-warning" role="alert">{error || validation || preview.error}</p>}
    {notice && <p className="workflow-notice" role="status">{notice}</p>}
  </form>;
}
