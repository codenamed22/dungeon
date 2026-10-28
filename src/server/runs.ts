import { isDeepStrictEqual } from "node:util";
import { castForWorld } from "../adventures/index.ts";
import { REHEARSAL_TURNS, rehearsalScript } from "../adventures/rehearsal.ts";
import { starterCast, starterWorld } from "../adventures/starter.ts";
import type { ModelProvider } from "../agents/provider.ts";
import { ScriptedProvider } from "../agents/provider.ts";
import { TurnRunner } from "../agents/runner.ts";
import type { RunnerSettings, StepOutcome } from "../agents/runner.ts";
import { loadSetup } from "../agents/setup.ts";
import type { ModelSetup } from "../agents/setup.ts";
import type { AdventureEngine } from "../engine.ts";
import { EngineError } from "../model.ts";

// The web director's scheduler runs: at most one per world in this process,
// started in the background and paused on request. Their events reach the
// browser through the event stream; this tracks only their progress.

export type RunKind = "step" | "run" | "rehearse";

/** The scripted opening plays only on a Dry Aqueduct world, by any name, that nothing has happened in yet. */
export async function isRehearsable(engine: AdventureEngine, worldId: string): Promise<boolean> {
  const [created, next] = await engine.getEvents(worldId, 0, 2);
  const seed = created?.data.type === "world_created" ? { ...created.data.seed, name: "" } : null;
  return !next && isDeepStrictEqual(seed, { ...starterWorld(worldId), name: "" });
}

export async function requireRehearsable(engine: AdventureEngine, worldId: string): Promise<void> {
  if (!await isRehearsable(engine, worldId)) {
    throw new EngineError("INVALID_INPUT", "The scripted opening only plays on a new Dry Aqueduct world");
  }
}

export interface RunRequest {
  kind: RunKind;
  /** For a step: cue this character or NPC instead of the scheduler's choice. */
  actorId?: string | undefined;
  /** For a run: the most turns to take. */
  turns?: number | undefined;
  maxModelCalls?: number | undefined;
  maxTokens?: number | undefined;
  maxCost?: number | undefined;
}

export interface RunStatus {
  worldId: string;
  kind: RunKind;
  actorId: string | null;
  state: "running" | "pausing" | "finished" | "failed";
  startedAt: string;
  endedAt: string | null;
  /** Turns answered so far, committed or failed. */
  turns: number;
  /** The latest turn outcome, in words. */
  lastOutcome: string | null;
  /** Why a run stopped; for a step, "stepped", or "ended" when the story ended. */
  stopReason: string | null;
  modelCalls: number | null;
  tokens: number | null;
  cost: number | null;
  /** Why the run could not start or broke off. */
  error: string | null;
}

export interface RunDependencies {
  engine: AdventureEngine;
  /** A provider playing a setup's models. */
  providerFor(models: ModelSetup): Promise<ModelProvider>;
  /** An engine whose dice always show the rehearsal roll, for the scripted opening; closed after use. */
  rehearsalEngine(): AdventureEngine;
  settings?: Partial<RunnerSettings>;
}

function describeOutcome(outcome: StepOutcome): string {
  switch (outcome.kind) {
    case "turn":
      return `${outcome.actorId} took a turn${outcome.attempts > 1 ? ` (attempt ${outcome.attempts})` : ""}`;
    case "narration":
      return "the narrator described it";
    case "failed":
      return `${outcome.actorId ?? "the narrator"} failed after ${outcome.attempts} attempt(s): ${outcome.reason}`;
    case "cancelled":
      return `${outcome.actorId ?? "the narrator"} was cancelled: ${outcome.reason}`;
  }
}

export class RunManager {
  private readonly deps: RunDependencies;
  private readonly runs = new Map<string, { status: RunStatus; controller: AbortController; done: Promise<void> }>();
  private readonly finished = new Map<string, RunStatus>();
  private readonly listeners = new Set<(status: RunStatus) => void>();

  constructor(deps: RunDependencies) {
    this.deps = deps;
  }

  /** The world's current run, or else its last one in this process. */
  status(worldId: string): RunStatus | null {
    return this.runs.get(worldId)?.status ?? this.finished.get(worldId) ?? null;
  }

  /** Calls `listener` on every change to any run; returns the unsubscribe function. */
  subscribe(listener: (status: RunStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Starts a run in the background. Fails at once if the request is invalid or this world is already running. */
  start(worldId: string, request: RunRequest): RunStatus {
    if (this.runs.has(worldId)) throw new EngineError("WORLD_BUSY", `${worldId} is already running; pause it first`);
    if (request.kind === "run" && !(Number.isInteger(request.turns) && request.turns! >= 1 && request.turns! <= 100)) {
      throw new EngineError("INVALID_INPUT", "A run needs between 1 and 100 turns");
    }
    const status: RunStatus = {
      worldId, kind: request.kind, actorId: request.actorId ?? null, state: "running",
      startedAt: new Date().toISOString(), endedAt: null, turns: 0, lastOutcome: null, stopReason: null,
      modelCalls: null, tokens: null, cost: null, error: null,
    };
    const controller = new AbortController();
    const done = this.execute(worldId, request, status, controller.signal)
      .catch((error: unknown) => {
        status.state = "failed";
        status.error = error instanceof EngineError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        status.endedAt = new Date().toISOString();
        if (status.state !== "failed") status.state = "finished";
        this.runs.delete(worldId);
        this.finished.set(worldId, status);
        this.notify(status);
      });
    this.runs.set(worldId, { status, controller, done });
    this.notify(status);
    return status;
  }

  /** Pauses the world's run: no new model call starts, and an unfinished turn is cancelled before it commits. */
  pause(worldId: string): RunStatus | null {
    const run = this.runs.get(worldId);
    if (!run) return this.status(worldId);
    run.controller.abort();
    run.status.state = "pausing";
    this.notify(run.status);
    return run.status;
  }

  /** Pauses every run and waits for them to stop. */
  async close(): Promise<void> {
    const runs = [...this.runs.values()];
    for (const run of runs) run.controller.abort();
    await Promise.all(runs.map((run) => run.done));
  }

  private notify(status: RunStatus): void {
    const snapshot = { ...status };
    for (const listener of this.listeners) listener(snapshot);
  }

  private async execute(worldId: string, request: RunRequest, status: RunStatus, signal: AbortSignal): Promise<void> {
    const onOutcome = (outcome: StepOutcome) => {
      if (outcome.kind === "turn" || (outcome.kind === "failed" && outcome.actorId !== null)) status.turns += 1;
      status.lastOutcome = describeOutcome(outcome);
      this.notify(status);
    };
    if (request.kind === "rehearse") {
      const engine = this.deps.rehearsalEngine();
      try {
        await requireRehearsable(engine, worldId);
        // The script expects the starter cast and the default settings, narration included.
        const runner = new TurnRunner(engine, new ScriptedProvider(rehearsalScript()), starterCast);
        const report = await runner.run(worldId, { maxTurns: REHEARSAL_TURNS }, onOutcome, { signal });
        Object.assign(status, { stopReason: report.stopReason, modelCalls: report.modelCalls, tokens: report.tokens, cost: report.cost });
      } finally {
        await engine.close();
      }
      return;
    }
    const engine = this.deps.engine;
    const state = await engine.getWorld(worldId);
    const setup = await loadSetup(engine, worldId, state, castForWorld);
    const runner = new TurnRunner(engine, await this.deps.providerFor(setup.models), setup.cast, this.deps.settings);
    if (request.kind === "step") {
      const outcomes = await runner.step(worldId, onOutcome, { signal, actorId: request.actorId });
      const ended = (await engine.getWorld(worldId)).endedWith !== undefined;
      status.stopReason = ended ? "ended" : outcomes.length === 0 ? "nobody_can_act" : signal.aborted ? "paused" : "stepped";
      return;
    }
    const report = await runner.run(worldId, {
      maxTurns: request.turns!, maxModelCalls: request.maxModelCalls, maxTokens: request.maxTokens, maxCost: request.maxCost,
    }, onOutcome, { signal });
    Object.assign(status, { stopReason: report.stopReason, modelCalls: report.modelCalls, tokens: report.tokens, cost: report.cost });
  }
}
