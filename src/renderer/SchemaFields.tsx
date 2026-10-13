import { useEffect, useId, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { JsonObject, JsonValue } from '../shared/amazon-contracts';
import { displaySchema, fieldPath, objectValue, setJsonPath } from './schema-form';

export function SchemaFields({ schema, attributes, disabled, onChange, locate, onLocateError }: { locate?: { path: string; token: number }; onLocateError?: (message: string) => void; schema: JsonObject; attributes: JsonObject; disabled: boolean; onChange: (value: JsonObject) => void }) {
  const [filter, setFilter] = useState('');
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => { if (locate) setFilter(''); }, [locate]);
  useEffect(() => {
    if (!locate || filter) return;
    const target = [...(container.current?.querySelectorAll<HTMLElement>('[data-field-path]') ?? [])].find(element => (locate.path.startsWith('/') ? element.dataset.fieldPointer : element.dataset.fieldPath) === locate.path);
    if (!target) { onLocateError?.('目标字段或数组行已不存在于当前 Schema/草稿，请核对属性 JSON；未跳到其他字段。'); return; }
    for (let parent = target.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
    target.scrollIntoView({ block: 'center' });
    (target.querySelector<HTMLElement>('input:not(:disabled),select:not(:disabled),textarea:not(:disabled)') ?? target).focus({ preventScroll: true });
  }, [locate, filter]);
  const root = displaySchema(schema, schema);
  const fields = Object.entries(objectValue(root.properties));
  const required = new Set(Array.isArray(root.required) ? root.required : []);
  return <div ref={container} className="schema-fields">
    <p className="small-copy">条件字段一并显示；填写后运行本地校验，查看当前商品的必填项与取值要求。复杂组合可切换属性 JSON。</p>
    <label className="field schema-search"><span>查找类目字段</span><input value={filter} onChange={event => setFilter(event.target.value)} placeholder="字段名称或代码" /></label>
    {fields.filter(([name, node]) => `${name} ${objectValue(node).title ?? ''}`.toLowerCase().includes(filter.toLowerCase())).map(([name, node]) =>
      <SchemaField key={name} node={objectValue(node)} root={schema} path={[name]} value={attributes[name]} required={required.has(name)} disabled={disabled} depth={0}
        onChange={(path, value) => onChange(setJsonPath(attributes, path, value))} />)}
    {!fields.length && <p className="small-copy">此类目使用复合字段结构，请在“属性 JSON”中编辑；保存后运行本地校验查看完整要求。</p>}
  </div>;
}

interface FieldProps {
  node: JsonObject; root: JsonObject; path: (string | number)[]; value: JsonValue | undefined;
  required?: boolean; disabled: boolean; depth: number;
  onChange: (path: (string | number)[], value: JsonValue | undefined) => void;
}
function SchemaField({ node, root, path, value, required, disabled, depth, onChange }: FieldProps) {
  const id = useId();
  const shape = displaySchema(node, root);
  const code = fieldPath(path);
  const pointer = '/' + path.map(part => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/');
  const title = typeof shape.title === 'string' ? shape.title : String(path[path.length - 1]);
  const description = typeof shape.description === 'string' ? shape.description : '';
  const type = typeof shape.type === 'string' ? shape.type : shape.properties ? 'object' : shape.items ? 'array' : 'string';
  const label = <span>{title}{required && <b className="required-mark" title="此类目必填"> *</b>}<small>{code}</small></span>;
  if (depth > 8) return <p className="small-copy">{code} 的结构较深，请使用属性 JSON 编辑。</p>;
  if (type === 'array') {
    const values = Array.isArray(value) ? value : [];
    const item = objectValue(shape.items);
    const limit = typeof shape.maxItems === 'number' ? Math.min(shape.maxItems, 200) : 200;
    return <fieldset data-field-path={code} data-field-pointer={pointer} tabIndex={-1} className="schema-group" disabled={disabled}>
      <legend>{label}</legend>{description && <p className="schema-description">{description}</p>}
      {values.map((entry, index) => <div className="schema-array-entry" key={index}><div className="schema-array-tools"><span>第 {index + 1} 项</span><button type="button" className="icon-button" aria-label={`移除字段 ${code}[${index}]`} onClick={() => onChange(path, values.filter((_, i) => i !== index))}><Trash2 size={15} /></button></div>
        <SchemaField node={item} root={root} path={[...path, index]} value={entry} disabled={disabled} depth={depth + 1} onChange={onChange} />
      </div>)}
      <button type="button" className="button secondary small-button" disabled={disabled || values.length >= limit} onClick={() => {
        const itemShape = displaySchema(item, root);
        const empty = itemShape.const ?? (itemShape.type === 'object' || itemShape.properties ? {} : itemShape.type === 'array' ? [] : itemShape.type === 'string' ? '' : null);
        onChange(path, [...values, empty]);
      }}><Plus size={14} />添加 {title}</button>
    </fieldset>;
  }
  if (type === 'object') {
    const properties = Object.entries(objectValue(shape.properties));
    const data = objectValue(value);
    const requiredChildren = new Set(Array.isArray(shape.required) ? shape.required : []);
    return <fieldset data-field-path={code} data-field-pointer={pointer} tabIndex={-1} className={`schema-group schema-object ${depth > 0 ? 'nested' : ''}`} disabled={disabled}>
      <legend>{label}</legend>{description && <p className="schema-description">{description}</p>}
      <div className="schema-object-grid">{properties.map(([key, child]) => <SchemaField key={key} node={objectValue(child)} root={root} path={[...path, key]} value={data[key]} required={requiredChildren.has(key)} disabled={disabled} depth={depth + 1} onChange={onChange} />)}</div>
      {!properties.length && <p className="small-copy">此对象的内容请在属性 JSON 中填写。</p>}
    </fieldset>;
  }
  const choices = Array.isArray(shape.enum) ? shape.enum : 'const' in shape ? [shape.const] : undefined;
  const captions = Array.isArray(shape.enumNames) ? shape.enumNames : [];
  return <label data-field-path={code} data-field-pointer={pointer} tabIndex={-1} className="field schema-leaf" htmlFor={id}>{label}
    {choices ? <select id={id} aria-label={`Amazon 字段 ${code}`} disabled={disabled} value={value === undefined ? '' : JSON.stringify(value)} onChange={event => onChange(path, event.target.value === '' ? undefined : JSON.parse(event.target.value))}>
      <option value="">请选择</option>{choices.map((choice, index) => <option key={JSON.stringify(choice)} value={JSON.stringify(choice)}>{String(captions[index] ?? choice)}</option>)}
    </select> : type === 'boolean' ? <select id={id} aria-label={`Amazon 字段 ${code}`} disabled={disabled} value={value === undefined || value === null ? '' : String(value)} onChange={event => onChange(path, event.target.value === '' ? undefined : event.target.value === 'true')}><option value="">未填写</option><option value="true">是</option><option value="false">否</option></select>
      : <input id={id} aria-label={`Amazon 字段 ${code}`} disabled={disabled} type={type === 'number' || type === 'integer' ? 'number' : 'text'} step={type === 'integer' ? 1 : 'any'}
        value={typeof value === 'string' || typeof value === 'number' ? value : ''} placeholder="按已确认的商品资料填写" onChange={event => {
          const raw = event.target.value;
          onChange(path, raw === '' ? undefined : type === 'number' || type === 'integer' ? Number(raw) : raw);
        }} />}
    {description && <span className="schema-description">{description}</span>}
    {shape.editable === false && <small className="small-copy">已有 Listing 的该字段可能不允许修改</small>}
  </label>;
}
