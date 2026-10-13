import type { DraftGuard } from './amazon-ui';

/** Explicit-save forms only. Search, filtering and selection never register here. */
export function createFormGuardRegistry() {
  const forms = new Map<string, DraftGuard>();
  return {
    register(id: string, guard: DraftGuard) {
      forms.set(id, guard);
      return () => { if (forms.get(id) === guard) forms.delete(id); };
    },
    dirty: () => [...forms.values()].some(form => form.dirty()),
    async save() {
      for (const form of forms.values()) if (form.dirty() && !await form.save()) return false;
      return true;
    },
    discard() { for (const form of forms.values()) if (form.dirty()) form.discard(); },
  };
}
