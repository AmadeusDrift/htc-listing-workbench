export interface ScrollPosition { key: string; top: number; left: number }
/** Snapshot only stable, named containers, including the page viewport. */
export function captureScroll(root: HTMLElement): ScrollPosition[] {
  return [{ key: '', top: root.scrollTop, left: root.scrollLeft }, ...Array.from(root.querySelectorAll<HTMLElement>('[data-scroll-key]'), element => ({ key: element.dataset.scrollKey!, top: element.scrollTop, left: element.scrollLeft }))];
}
/** Async task/source/image reads can grow several nested scroll areas after mount. */
export function restoreScroll(root: HTMLElement, positions: ScrollPosition[]): () => void {
  let stopped = false;
  const restore = () => {
    if (stopped) return;
    for (const position of positions) {
      const element = position.key ? [...root.querySelectorAll<HTMLElement>('[data-scroll-key]')].find(node => node.dataset.scrollKey === position.key) : root;
      if (element) { element.scrollTop = position.top; element.scrollLeft = position.left; }
    }
  };
  const stop = () => {
    stopped = true; root.removeEventListener('load', restore, true); observer.disconnect(); resize.disconnect(); clearTimeout(timeout);
    for (const event of ['wheel', 'pointerdown', 'keydown', 'touchstart']) root.removeEventListener(event, stop, true);
  };
  const observer = new MutationObserver(restore);
  const resize = new ResizeObserver(restore);
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
  resize.observe(root);
  // Image and layout completion may change content extent without replacing nodes.
  root.addEventListener('load', restore, true);
  for (const event of ['wheel', 'pointerdown', 'keydown', 'touchstart']) root.addEventListener(event, stop, true);
  const timeout = setTimeout(stop, 15000);
  restore();
  return () => { stop(); root.removeEventListener('load', restore, true); };
}
