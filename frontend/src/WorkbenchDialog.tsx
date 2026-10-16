import { useEffect, useRef, type ReactNode } from 'react';

export function WorkbenchDialog({ label, className, onClose, children }: { label: string; className: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]') ?? []).filter((item) => item.getClientRects().length > 0);
    (focusable()[0] ?? ref.current)?.focus();
    const key = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key === 'Tab') {
        const items = focusable(); const first = items[0]; const last = items[items.length - 1];
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || !ref.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !ref.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    };
    // Keep canvas shortcuts from acting behind the dialog.
    ref.current?.addEventListener('keydown', key);
    const element = ref.current;
    return () => { element?.removeEventListener('keydown', key); document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  return <div className="workbench-overlay"><div ref={ref} tabIndex={-1} className={className} role="dialog" aria-modal="true" aria-label={label}>{children}</div></div>;
}
