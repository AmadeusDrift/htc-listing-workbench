import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { SetStateAction } from 'react';
export interface ProblemContext { variantId?: string; taskId?: string; imageSlot?: number }
export const NavigationMemoryContext = createContext<Map<string, unknown> | null>(null);
/** Session-only browsing state. Never persisted as business data or registered dirty. */
export function usePageState<T>(key: string, initial: T) {
  const memory = useContext(NavigationMemoryContext);
  const [value, setValue] = useState<T>(() => memory?.has(key) ? memory.get(key) as T : initial);
  const current = useRef(value); current.current = value;
  const update = useCallback((next: SetStateAction<T>) => {
    const value = typeof next === 'function' ? (next as (prior: T) => T)(current.current) : next;
    current.current = value; memory?.set(key, value); setValue(value);
  }, [key, memory]);
  return [value, update] as const;
}
