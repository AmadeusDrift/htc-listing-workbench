import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function InboxDialog({ label, className, onClose, children }: { label: string; className?: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const scrollPositions: { element: HTMLElement; top: number; left: number }[] = [];
    for (let element = opener?.parentElement; element; element = element.parentElement) {
      scrollPositions.push({ element, top: element.scrollTop, left: element.scrollLeft });
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      for (const position of scrollPositions) {
        position.element.scrollTop = position.top;
        position.element.scrollLeft = position.left;
      }
    };
  }, []);
  return createPortal(<dialog ref={dialog} className={`inbox-dialog ${className ?? ''}`} aria-label={label} aria-modal="true" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
  }}>{children}</dialog>, document.body);
}
