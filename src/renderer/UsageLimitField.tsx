export interface LimitSetting { choice: string; value: string }
export const CALL_PRESETS = [100, 500, 1000];
export const TOKEN_PRESETS = [100000, 500000, 1000000];

export function savedLimit(value: number | null, presets: number[]): LimitSetting {
  return { choice: value === null ? 'unlimited' : presets.includes(value) ? String(value) : 'custom', value: value?.toString() ?? '' };
}

export function UsageLimitField({ label, presetLabel, inputLabel, presets, unit, setting, maximum, invalid, disabled, onChange }: {
  label: string; presetLabel: string; inputLabel: string; presets: number[]; unit: string;
  setting: LimitSetting; maximum: number; invalid: boolean; disabled: boolean; onChange(value: LimitSetting): void;
}) {
  return <div className="usage-limit-field">
    <label className="field"><span>{label}</span><select aria-label={presetLabel} value={setting.choice} disabled={disabled}
      onChange={event => { const choice = event.target.value; onChange({ choice, value: choice === 'custom' ? setting.value : choice === 'unlimited' ? '' : choice }); }}>
      <option value="unlimited">不限制</option>
      {presets.map(value => <option key={value} value={value}>{value.toLocaleString('zh-CN')} {unit} / 天</option>)}
      <option value="custom">自定义</option>
    </select></label>
    {setting.choice === 'custom' && <label className="field custom-limit"><span>自定义{unit === '次' ? '调用次数' : ' Token'}上限</span>
      <input type="text" inputMode="numeric" aria-label={inputLabel} aria-invalid={invalid} value={setting.value} disabled={disabled}
        placeholder={`0–${maximum.toLocaleString('zh-CN')}，留空不限制`} onChange={event => onChange({ choice: 'custom', value: event.target.value })} />
    </label>}
  </div>;
}
