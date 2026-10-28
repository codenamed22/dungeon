import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText, SIGNED_OUT_EVENT } from "./api.ts";
import type { EventView, RunStatus, WorldView } from "./types.ts";

export interface LiveWorld {
  view: WorldView | null;
  events: EventView[];
  run: RunStatus | null;
  /** Whether the live event stream is connected. */
  live: boolean;
  error: string | null;
  /** Reloads the world's state (characters, routes, setup) now. */
  refresh(): Promise<void>;
  setView(view: WorldView): void;
}

/**
 * A world and its history, kept current: the full log is loaded once, then new
 * events arrive over server-sent events. The browser reconnects by itself and
 * the server resumes after the last event it sent.
 */
export function useWorld(worldId: string): LiveWorld {
  const [view, setView] = useState<WorldView | null>(null);
  const [events, setEvents] = useState<EventView[]>([]);
  const [run, setRun] = useState<RunStatus | null>(null);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const next = await api.world(worldId);
      setView(next);
      setRun(next.run);
    } catch (problem) {
      setError(errorText(problem));
    }
  }, [worldId]);

  useEffect(() => {
    let closed = false;
    let source: EventSource | undefined;
    // State changes come in bursts during a run; reload it once things settle.
    const refreshSoon = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void refresh(), 250);
    };
    setView(null);
    setEvents([]);
    setError(null);
    void (async () => {
      try {
        const [first, history] = await Promise.all([api.world(worldId), api.events(worldId)]);
        if (closed) return;
        setView(first);
        setRun(first.run);
        setEvents(history);
        const after = history.at(-1)?.sequence ?? 0;
        source = new EventSource(`/api/worlds/${encodeURIComponent(worldId)}/stream?after=${after}`);
        source.addEventListener("open", () => setLive(true));
        source.addEventListener("error", () => {
          setLive(false);
          // A refused reconnect (for one, a session that ended) closes the stream for good: see whether we are still signed in.
          if (source?.readyState === EventSource.CLOSED) window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
        });
        source.addEventListener("events", (message) => {
          const batch = JSON.parse((message as MessageEvent<string>).data) as EventView[];
          setEvents((current) => {
            const last = current.at(-1)?.sequence ?? 0;
            return [...current, ...batch.filter((event) => event.sequence > last)];
          });
          refreshSoon();
        });
        source.addEventListener("run", (message) => {
          setRun(JSON.parse((message as MessageEvent<string>).data) as RunStatus | null);
          refreshSoon();
        });
      } catch (problem) {
        if (!closed) setError(errorText(problem));
      }
    })();
    return () => {
      closed = true;
      clearTimeout(timer.current);
      source?.close();
      setLive(false);
    };
  }, [worldId, refresh]);

  return { view, events, run, live, error, refresh, setView };
}
