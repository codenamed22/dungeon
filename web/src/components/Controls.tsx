import { useState } from "react";
import { api, errorText } from "../api.ts";
import { credits } from "../format.ts";
import type { RunStatus, WorldView } from "../types.ts";

const STOP_REASONS: Record<string, string> = {
  max_turns: "reached its turn limit",
  max_model_calls: "reached its model-call limit",
  max_tokens: "reached its token limit",
  max_cost: "reached its cost limit",
  consecutive_failures: "stopped after repeated failed turns",
  stalled: "stopped: the group kept talking without acting",
  no_active_characters: "stopped: nobody can act",
  all_muted: "stopped: everyone is muted",
  paused: "paused",
  lease_lost: "stopped: another scheduler took over this world",
  stepped: "took one turn",
  nobody_can_act: "nobody could take a turn",
  ended: "stopped: the story has ended",
};

/** Run, Step, and Pause, with the run's limits and progress. */
export function Controls({ worldId, view, run }: { worldId: string; view: WorldView; run: RunStatus | null }) {
  const [turns, setTurns] = useState(6);
  const [maxCalls, setMaxCalls] = useState(40);
  const [maxCost, setMaxCost] = useState("");
  const [error, setError] = useState<string | null>(null);
  const running = run?.state === "running" || run?.state === "pausing";
  const ended = view.world.endedWith !== undefined;
  const playable = view.keyConfigured;

  async function act(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (problem) {
      setError(errorText(problem));
    }
  }

  const cost = Number(maxCost);
  const limits = { turns, maxModelCalls: maxCalls, ...(maxCost.trim() && cost > 0 ? { maxCost: cost } : {}) };
  const noKey = "Set OPENROUTER_API_KEY in .env.local and restart the server";
  return (
    <div className="controls">
      <div className="row wrap">
        {ended && !running ? (
          <p className="small muted">The story has ended. To play on, branch from an earlier event.</p>
        ) : running ? (
          <button className="danger" disabled={run.state === "pausing"} onClick={() => void act(() => api.pause(worldId))}>
            {run.state === "pausing" ? "Pausing…" : "Pause"}
          </button>
        ) : (
          <>
            <button disabled={!playable} title={playable ? "One turn, chosen by the scheduler, plus its narration" : noKey}
              onClick={() => void act(() => api.step(worldId))}>Step</button>
            <button className="primary" disabled={!playable} title={playable ? "Run turns until a limit" : noKey}
              onClick={() => void act(() => api.run(worldId, limits))}>Run</button>
            <label className="inline" title="Main and supporting character turns">
              <input type="number" min={1} max={100} value={turns} onChange={(event) => setTurns(Number(event.target.value))} /> turns
            </label>
            <label className="inline" title="Stop before making more model calls than this">
              ≤ <input type="number" min={1} value={maxCalls} onChange={(event) => setMaxCalls(Number(event.target.value))} /> calls
            </label>
            <label className="inline" title="Stop once the run has cost this many OpenRouter credits (optional)">
              ≤ <input type="number" min={0} step="0.01" placeholder="any" value={maxCost} onChange={(event) => setMaxCost(event.target.value)} /> credits
            </label>
            {view.rehearsable && (
              <button title="Plays a scripted opening with no model and fixed dice: free. Only for a new Dry Aqueduct world."
                onClick={() => void act(() => api.rehearse(worldId))}>Scripted opening (free)</button>
            )}
          </>
        )}
      </div>
      <RunLine run={run} />
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

function RunLine({ run }: { run: RunStatus | null }) {
  if (!run) return <p className="muted small">Nothing has run in this session. Nothing runs on its own: press Step or Run.</p>;
  const what = run.kind === "rehearse" ? "Scripted opening" : run.kind === "step" ? (run.actorId ? `Cue for ${run.actorId}` : "Step") : "Run";
  if (run.state === "running" || run.state === "pausing") {
    return (
      <p className="small run-line running">
        {what} {run.state === "pausing" ? "pausing" : "running"}: {run.turns} turn(s){run.lastOutcome ? `; ${run.lastOutcome}` : ""}
      </p>
    );
  }
  if (run.state === "failed") return <p className="small error">{what} failed: {run.error}</p>;
  const reason = run.stopReason ? STOP_REASONS[run.stopReason] ?? run.stopReason : "finished";
  const spend = run.modelCalls === null ? "" : `; ${run.modelCalls} model call(s), ${run.tokens} tokens, ${credits(run.cost)} credits`;
  return <p className="small muted run-line">{what} {reason} after {run.turns} turn(s){spend}.</p>;
}
