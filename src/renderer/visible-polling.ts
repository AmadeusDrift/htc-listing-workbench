/** Shared UI-only observation. Stopping it never cancels a business operation. */
const listeners = new Set<() => void>();
let observer: MutationObserver | undefined;
function subscribeVisibility(listener: () => void): () => void {
  if (typeof document === 'undefined') return () => {};
  const notify = () => listeners.forEach(value => value());
  if (!listeners.size) {
    document.addEventListener('visibilitychange', notifyVisibility);
    observer = new MutationObserver(notify);
    observer.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['hidden', 'style', 'class', 'open'] });
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { document.removeEventListener('visibilitychange', notifyVisibility); observer?.disconnect(); observer = undefined; }
  };
}
function notifyVisibility() { listeners.forEach(value => value()); }
export function isReadVisible(element?: Element | null): boolean {
  if (typeof document === 'undefined') return true;
  if (document.visibilityState === 'hidden') return false;
  if (!element) return true;
  if (!element.isConnected || !element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') return false;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS' && !parent.hasAttribute('open') && !parent.querySelector('summary')?.contains(element)) return false;
  }
  return true;
}
export function startVisiblePolling(read: (resumed: boolean) => Promise<number | null | void>, options: {
  element?: () => Element | null; visible?: () => boolean; subscribe?: (listener: () => void) => () => void; initialDelay?: number;
} = {}): () => void {
  let stopped = false, reading = false, resume = false, timer: ReturnType<typeof setTimeout> | undefined;
  const visible = () => isReadVisible(options.element?.()) && (options.visible?.() ?? true);
  let wasVisible = visible();
  const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const poll = async (resumed = true) => {
    clear();
    if (stopped || !visible()) return;
    if (reading) { resume = true; return; }
    reading = true;
    let delay: number | null | void = null;
    try { delay = await read(resumed); }
    finally {
      reading = false;
      if (!stopped && visible()) {
        if (resume) { resume = false; void poll(); }
        else if (typeof delay === 'number') timer = setTimeout(() => void poll(false), delay);
      }
    }
  };
  const unsubscribe = (options.subscribe ?? subscribeVisibility)(() => {
    const next = visible();
    if (next === wasVisible) return;
    wasVisible = next; clear();
    if (!next) resume = false;
    if (next) void poll();
  });
  if (wasVisible) { if (options.initialDelay) timer = setTimeout(() => void poll(), options.initialDelay); else void poll(); }
  return () => { stopped = true; resume = false; clear(); unsubscribe(); };
}
