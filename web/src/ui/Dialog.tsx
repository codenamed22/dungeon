import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { useDrag, useOverlay } from "./hooks.ts";

/**
 * A modal dialog: centred on wide screens, a sheet from the bottom on narrow
 * ones, which its handle drags down to close. Pair it with useOverlay so Back
 * closes it too.
 */
export function Dialog({ open, onClose, title, children }: { open: boolean; onClose(): void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [offset, setOffset] = useState(0);
  const drag = useDrag({
    axis: "y",
    onMove: (delta) => setOffset(Math.max(0, delta)),
    onEnd: (delta, velocity) => {
      setOffset(0);
      if (delta > 90 || velocity > 0.5) onClose();
    },
  });

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={ref} className="dialog" aria-label={title}
      style={offset ? { transform: `translateY(${offset}px)`, transition: "none" } : undefined}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      {open && (
        <>
          <div className="sheet-handle" {...drag}><span /></div>
          <div className="dialog-head">
            <h2>{title}</h2>
            <button type="button" className="icon-button" aria-label="Close" title="Close" onClick={onClose}><X size={18} /></button>
          </div>
          <div className="dialog-body">{children}</div>
        </>
      )}
    </dialog>
  );
}

/**
 * A dialog that is open while it is mounted, with a history entry so Back
 * closes it. `onClose` runs however it closes.
 */
export function SheetDialog({ name, title, onClose, children }: { name: string; title: string; onClose(): void; children: ReactNode }) {
  const overlay = useOverlay(name);
  const shown = useRef(false);
  const close = useRef(onClose);
  close.current = onClose;
  const stillOpen = useRef(false);
  stillOpen.current = overlay.open;
  useEffect(() => {
    overlay.show();
    // Unmounted while open, as after a finished action: drop its history entry too.
    return () => {
      if (stillOpen.current && window.location.hash === `#${name}`) window.history.back();
    };
  }, []);
  useEffect(() => {
    if (overlay.open) shown.current = true;
    else if (shown.current) close.current();
  }, [overlay.open]);
  return <Dialog open={overlay.open} onClose={overlay.hide} title={title}>{children}</Dialog>;
}
