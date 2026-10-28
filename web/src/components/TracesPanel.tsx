import { useEffect, useState } from "react";
import { api, errorText } from "../api.ts";
import { credits } from "../format.ts";
import type { TraceRecord } from "../types.ts";

const FAILED = /^(invalid_|provider_error|ruling_failed)/;

/** Every model call, newest first, with the exact request and response. */
export function TracesPanel({ worldId, revision }: { worldId: string; revision: number }) {
  const [traces, setTraces] = useState<TraceRecord[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api.traces(worldId, 100)
      .then((next) => { if (current) { setTraces([...next].reverse()); setError(null); } })
      .catch((problem) => { if (current) setError(errorText(problem)); });
    return () => { current = false; };
  }, [worldId, revision]);

  if (error) return <p className="error small">{error}</p>;
  if (!traces) return <p className="muted small">Loading…</p>;
  if (traces.length === 0) return <p className="muted small">No model calls yet.</p>;
  return (
    <div className="stack">
      <p className="muted small">The latest {traces.length} model calls, newest first.</p>
      {traces.map((trace) => (
        <div key={trace.id} className="sheet small">
          <button className="link row trace-head" onClick={() => setOpen(open === trace.id ? null : trace.id)}>
            <strong>{(trace.task ?? trace.role).replace("_", " ")}</strong>
            {trace.actorId && <span>{trace.actorId}</span>}
            <span className={FAILED.test(trace.outcome) ? "error" : "muted"}>{trace.outcome}</span>
            <span className="muted grow right">
              {trace.model} · {(trace.inputTokens ?? 0) + (trace.outputTokens ?? 0)} tokens · {credits(trace.cost)} · {(trace.latencyMs / 1000).toFixed(1)} s
            </span>
          </button>
          {open === trace.id && (
            <div className="stack">
              {trace.error && <p className="error">{trace.error}</p>}
              <h4>System</h4>
              <pre className="prompt">{trace.request.system}</pre>
              <h4>Prompt</h4>
              <pre className="prompt">{trace.request.prompt}</pre>
              <h4>Response</h4>
              <pre className="prompt">{typeof trace.response === "string" ? trace.response : JSON.stringify(trace.response, null, 2)}</pre>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
