import { useEffect } from 'react';

/** One delegated light, no React rerenders or per-button listeners. */
export function useGlassLighting(reduced: boolean) {
  useEffect(() => {
    const media = matchMedia('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)');
    let active: HTMLElement | null = null;
    let frame = 0;
    let x = 50, y = 50, targetX = 50, targetY = 50;
    const clear = () => {
      cancelAnimationFrame(frame); frame = 0;
      active?.removeAttribute('data-glass-lit');
      active = null;
    };
    const tick = () => {
      frame = 0;
      if (!active?.isConnected) { clear(); return; }
      x += (targetX - x) * .32; y += (targetY - y) * .32;
      active.style.setProperty('--light-x', `${x.toFixed(2)}%`);
      active.style.setProperty('--light-y', `${y.toFixed(2)}%`);
      if (Math.abs(targetX - x) + Math.abs(targetY - y) > .15) frame = requestAnimationFrame(tick);
    };
    const move = (event: PointerEvent) => {
      if (reduced || !media.matches || event.pointerType === 'touch') { clear(); return; }
      document.documentElement.dataset.inputMode = 'pointer';
      const next = event.target instanceof Element ? event.target.closest<HTMLElement>('.button:not(:disabled), .glass-segmented, .titlebar-theme') : null;
      if (!next) { clear(); return; }
      if (next !== active) {
        clear(); active = next; x = 50; y = 50;
        active.setAttribute('data-glass-lit', '');
      }
      const bounds = active.getBoundingClientRect();
      targetX = Math.max(0, Math.min(100, (event.clientX - bounds.left) / Math.max(bounds.width, 1) * 100));
      targetY = Math.max(0, Math.min(100, (event.clientY - bounds.top) / Math.max(bounds.height, 1) * 100));
      if (!frame) frame = requestAnimationFrame(tick);
    };
    document.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('pointerleave', clear);
    window.addEventListener('blur', clear);
    window.addEventListener('keydown', clear, true);
    media.addEventListener('change', clear);
    return () => {
      clear(); document.removeEventListener('pointermove', move); document.removeEventListener('pointerleave', clear);
      window.removeEventListener('blur', clear); window.removeEventListener('keydown', clear, true); media.removeEventListener('change', clear);
    };
  }, [reduced]);
}
