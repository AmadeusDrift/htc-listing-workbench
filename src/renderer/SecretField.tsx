export function SecretField({ label, value, onChange, disabled, optional = false, maxLength = 4096 }: {
  label: string; value: string; onChange: (value: string) => void; disabled: boolean; optional?: boolean; maxLength?: number;
}) {
  return <label className="field"><span>{label}</span><input type="password" aria-label={label} autoComplete="off" spellCheck={false} required={!optional} maxLength={maxLength} value={value} disabled={disabled} onChange={event => onChange(event.target.value)} placeholder={optional ? '使用临时凭据时填写' : '粘贴密钥，保存后不回显'} /></label>;
}
