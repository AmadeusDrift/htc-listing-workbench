// Date.toLocaleString defaults include both date and time. Cache the formatter
// rather than allocating one per option on every render of a large task list.
const formatter = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false });

export function formatAutomaticTaskDate(value: string): string {
  const date = new Date(value);
  // Persisted tasks validate timestamps, but preserve the old display fallback
  // if a malformed response ever reaches the renderer.
  return Number.isNaN(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : formatter.format(date);
}
