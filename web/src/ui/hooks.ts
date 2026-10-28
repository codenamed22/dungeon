import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

export const NARROW = "(max-width: 760px)";

/** Whether a media query matches, kept current. */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export interface Overlay {
  open: boolean;
  show(): void;
  hide(): void;
}

/**
 * Something that opens over the page, such as a panel or a sheet. Opening it
 * adds a #name history entry, so Back (or the back gesture) closes it, as on a
 * phone it should; closing it any other way removes the entry again.
 */
export function useOverlay(name: string): Overlay {
  const [open, setOpen] = useState(false);
  const pushed = useRef(false);
  const hash = `#${name}`;

  // A reload on #name starts closed, without the entry.
  useEffect(() => {
    if (window.location.hash === hash) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, [hash]);
  useEffect(() => {
    if (!open) return;
    const pop = () => {
      if (window.location.hash === hash) return;
      pushed.current = false;
      setOpen(false);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [open, hash]);

  const show = useCallback(() => {
    setOpen(true);
    if (window.location.hash !== hash) {
      window.history.pushState(null, "", hash);
      pushed.current = true;
    }
  }, [hash]);
  const hide = useCallback(() => {
    setOpen(false);
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
    }
  }, []);
  return { open, show, hide };
}

export interface DragOptions {
  axis: "x" | "y";
  /** Called once the gesture is known to be along the axis. */
  onStart?(): void;
  /** The distance moved along the axis so far. */
  onMove(delta: number): void;
  /** The final distance, and its speed in pixels per millisecond. */
  onEnd(delta: number, velocity: number): void;
  /** Pointer downs inside these elements are not drags. */
  ignore?: string;
}

/**
 * Pointer handlers for dragging along one axis, after traveller's bottom sheet:
 * the gesture locks to an axis after 8px, and the caller decides where to rest
 * from the distance and speed (a flick is faster than 0.5 px/ms).
 */
export function useDrag(options: DragOptions) {
  const latest = useRef(options);
  latest.current = options;
  const start = useRef<{ x: number; y: number; time: number; axis?: "x" | "y" } | null>(null);
  const along = (event: ReactPointerEvent, origin: { x: number; y: number }) => (
    latest.current.axis === "x" ? event.clientX - origin.x : event.clientY - origin.y
  );
  return {
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      const { ignore } = latest.current;
      if (event.button !== 0 || (ignore && (event.target as HTMLElement).closest(ignore))) return;
      start.current = { x: event.clientX, y: event.clientY, time: event.timeStamp };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      const origin = start.current;
      if (!origin) return;
      const dx = event.clientX - origin.x;
      const dy = event.clientY - origin.y;
      if (!origin.axis && Math.hypot(dx, dy) > 8) {
        origin.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        if (origin.axis === latest.current.axis) latest.current.onStart?.();
      }
      if (origin.axis === latest.current.axis) latest.current.onMove(along(event, origin));
    },
    onPointerUp(event: ReactPointerEvent<HTMLElement>) {
      const origin = start.current;
      start.current = null;
      if (origin?.axis !== latest.current.axis) return;
      const delta = along(event, origin);
      latest.current.onEnd(delta, delta / Math.max(1, event.timeStamp - origin.time));
    },
    onPointerCancel() {
      const origin = start.current;
      start.current = null;
      if (origin?.axis === latest.current.axis) latest.current.onEnd(0, 0);
    },
  };
}

/** A value saved in this browser only, for conveniences such as a chosen theme. */
export function useStored<T extends string>(key: string, fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      return (window.localStorage.getItem(key) as T | null) ?? fallback;
    } catch {
      return fallback;
    }
  });
  const store = useCallback((next: T) => {
    setValue(next);
    try {
      window.localStorage.setItem(key, next);
    } catch {
      // Storage may be unavailable, as in a private window; the choice lasts until reload.
    }
  }, [key]);
  return [value, store];
}
