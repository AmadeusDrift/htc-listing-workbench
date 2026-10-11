import { Check, Monitor, Moon, Palette, Sun } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import type { AppearanceController } from './useAppearance';

function Segmented<T extends string>({ label, value, options, disabled, saving, onChange }: {
  label: string; value: T; options: { value: T; label: string; icon?: ReactNode }[]; disabled: boolean; saving: boolean; onChange: (value: T) => void;
}) {
  const index = Math.max(0, options.findIndex(option => option.value === value));
  return <div className="glass-segmented" role="radiogroup" aria-label={label} aria-busy={saving} style={{ '--segments': options.length, '--selected': index } as CSSProperties}>
    <span className="glass-segmented-indicator" aria-hidden="true" />
    {options.map((option, i) => <button type="button" role="radio" key={option.value} aria-checked={option.value === value} disabled={disabled} aria-disabled={saving || undefined} tabIndex={i === index ? 0 : -1}
      onClick={() => { if (!saving) onChange(option.value); }} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        if (saving) return;
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (i + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + options.length) % options.length;
        (event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next])?.focus();
        onChange(options[next].value);
      }}>{option.icon}<span>{option.label}</span></button>)}
  </div>;
}

export function AppearanceSettings({ appearance }: { appearance: AppearanceController }) {
  const { preferences, loading, saving, error, update } = appearance;
  const disabled = loading;
  return <section className="settings-section appearance-settings" aria-label="外观与交互">
    <div className="settings-section-title"><Palette size={20} /><div><h3>外观与交互</h3><p>同一套工作流，两种光线。设置自动保存在本机。</p></div></div>
    <div className="appearance-row"><div><h4>界面主题</h4><p>日间雾白与夜间石墨，保持清晰的文字和状态。</p></div><Segmented label="界面主题" value={preferences.theme} disabled={disabled} saving={saving} onChange={theme => { void update({ theme }); }} options={[{ value: 'light', label: '日间', icon: <Sun size={16} /> }, { value: 'dark', label: '夜间', icon: <Moon size={16} /> }, { value: 'system', label: '跟随系统', icon: <Monitor size={16} /> }]} /></div>
    <div className="appearance-row"><div><h4>信息密度</h4><p>紧凑模式缩小列表间距，在一屏内查看更多商品。</p></div><Segmented label="信息密度" value={preferences.density} disabled={disabled} saving={saving} onChange={density => { void update({ density }); }} options={[{ value: 'comfortable', label: '舒适' }, { value: 'compact', label: '紧凑' }]} /></div>
    <div className="appearance-row"><div><h4>动态效果</h4><p>标准模式保留轻微的颜色过渡与操作反馈。始终尊重系统的减少动态效果设置。</p></div><Segmented label="动态效果" value={preferences.motion} disabled={disabled} saving={saving} onChange={motion => { void update({ motion }); }} options={[{ value: 'full', label: '标准' }, { value: 'reduced', label: '减少动态' }]} /></div>
    <div className="appearance-save-state" role="status"><Check size={15} />{loading ? '读取外观设置…' : saving ? '正在保存…' : error ? '外观设置未保存' : '外观设置已保存到本机'}</div>
    {error && <p className="workflow-error" role="alert">{error}<button type="button" className="text-button" disabled={disabled} onClick={() => { void appearance.retry(); }}>重试保存</button></p>}
  </section>;
}

export function DesktopTitleBar({ version, appearance }: { version: string; appearance: AppearanceController }) {
  const dark = appearance.resolvedTheme === 'dark';
  return <header className="desktop-titlebar"><div className="titlebar-identity"><span className="titlebar-mark">H<span>·</span></span><strong>HTC</strong><span className="titlebar-product">独立上架工作台</span><span className="titlebar-version">{version ? `v${version}` : '正在读取版本'}</span></div>
    <div className="titlebar-actions"><span className="titlebar-workspace"><i />本地工作区</span><button type="button" className="titlebar-theme" aria-label={dark ? '切换到日间模式' : '切换到夜间模式'} title={dark ? '切换到日间模式' : '切换到夜间模式'} disabled={appearance.loading} aria-disabled={appearance.saving || undefined} onClick={() => { if (appearance.saving) return; void appearance.update({ theme: dark ? 'light' : 'dark' }); }}>{dark ? <Sun size={15} /> : <Moon size={15} />}</button></div>
  </header>;
}
