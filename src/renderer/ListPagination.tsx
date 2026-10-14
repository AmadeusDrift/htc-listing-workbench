import { useEffect, useState } from 'react';
import { normalizePageSize, PAGE_SIZES } from './list-pagination';
export function useListPageSize(key: string) {
  const storageKey = `htc:list-page-size:${key}`;
  const [size, setSize] = useState(() => { try { return normalizePageSize(localStorage.getItem(storageKey)); } catch { return 20; } });
  useEffect(() => { try { localStorage.setItem(storageKey, String(size)); } catch { /* Preferences must not block list controls. */ } }, [storageKey, size]);
  return [size, (value: number) => setSize(normalizePageSize(value))] as const;
}
export function PageSizeSelect({ label, value, onChange, disabled = false }: { label: string; value: number; onChange(value: number): void; disabled?: boolean }) {
  return <label className="list-page-size">每页 <select disabled={disabled} aria-label={label} value={value} onChange={event => onChange(Number(event.target.value))}>{PAGE_SIZES.map(size => <option key={size} value={size}>{size}</option>)}</select> 条</label>;
}
