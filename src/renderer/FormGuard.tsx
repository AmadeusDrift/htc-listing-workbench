import { createContext, useContext, useEffect, useId, useRef } from 'react';
import type { DraftGuard } from './amazon-ui';
import type { createFormGuardRegistry } from './form-guard-registry';

export const FormGuardContext = createContext<ReturnType<typeof createFormGuardRegistry> | null>(null);
export function useFormGuard(guard: DraftGuard) {
  const registry = useContext(FormGuardContext), id = useId(), latest = useRef(guard);
  latest.current = guard;
  useEffect(() => registry?.register(id, {
    dirty: () => latest.current.dirty(),
    save: () => latest.current.save(),
    discard: () => latest.current.discard(),
  }), [id, registry]);
}
