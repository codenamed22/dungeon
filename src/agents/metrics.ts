import type { TraceRecord, TraceTask } from "../engine.ts";
import type { AdventureEvent, WorldState } from "../model.ts";
import { liveEvents } from "../wipes.ts";
import { turnHistory } from "./schedule.ts";

/** Outcomes where the agent answered, but its proposal was malformed or rejected. */
const INVALID_OUTCOMES = new Set(["invalid_output", "invalid_action", "invalid_ruling"]);
const PROPOSAL_TASKS: TraceTask[] = ["character_turn", "npc_turn", "ruling"];
const TASKS: TraceTask[] = [...PROPOSAL_TASKS, "narration"];

export interface TaskMetrics {
  task: TraceTask;
  calls: number;
  invalid: number;
  providerErrors: number;
  cancelled: number;
  tokens: number;
  /** Null when no call reported a cost. */
  cost: number | null;
  meanLatencyMs: number | null;
}

export interface MetricsReport {
  characterTurns: number;
  npcTurns: number;
  turnsByActor: Record<string, number>;
  /** Character turns up to and including the first that did more than speak; null if none has. */
  turnsToFirstAction: number | null;
  /** The most character turns in a row that only spoke. */
  longestStall: number;
  threatsFired: number;
  steeringRequests: number;
  rulings: { existing: number; new: number; automatic: number; impossible: number };
  /** Malformed or rejected proposals (turns and rulings) as a share of the calls that answered. */
  invalidProposalRate: number | null;
  tasks: TaskMetrics[];
  calls: number;
  tokens: number;
  cost: number | null;
  /** Over committed character and NPC turns, counting the rulings and narration they caused. */
  costPerTurn: number | null;
  latencyPerTurnMs: number | null;
}

/** Traces recorded before Phase 2b have no task; their role implies it. */
function taskOf(trace: TraceRecord): TraceTask {
  return trace.task ?? (trace.role === "character" ? "character_turn" : "narration");
}

function sumCost(traces: TraceRecord[]): number | null {
  const costs = traces.flatMap((trace) => (trace.cost === null ? [] : [trace.cost]));
  return costs.length === 0 ? null : costs.reduce((total, cost) => total + cost, 0);
}

function sumLatency(traces: TraceRecord[]): number {
  return traces.reduce((total, trace) => total + trace.latencyMs, 0);
}

/**
 * Summarizes how a session went, from its events and the traces of its model
 * calls. Wiped events don't count; the model calls that made them do, since
 * they were paid for.
 */
export function computeMetrics(allEvents: AdventureEvent[], traces: TraceRecord[], state: WorldState): MetricsReport {
  const events = liveEvents(allEvents);
  const turns = turnHistory(events, state);
  const characterTurns = turns.filter((turn) => !turn.npc);
  const turnsByActor: Record<string, number> = {};
  for (const turn of turns) turnsByActor[turn.actorId] = (turnsByActor[turn.actorId] ?? 0) + 1;
  const firstAction = characterTurns.findIndex((turn) => turn.acted);
  let longestStall = 0;
  let stall = 0;
  for (const turn of characterTurns) {
    stall = turn.acted ? 0 : stall + 1;
    longestStall = Math.max(longestStall, stall);
  }
  const count = (type: AdventureEvent["data"]["type"]) => events.filter((event) => event.data.type === type).length;

  const rulings = { existing: 0, new: 0, automatic: 0, impossible: 0 };
  for (const event of events) if (event.data.type === "ruling") rulings[event.data.decision] += 1;
  rulings.impossible = traces.filter((trace) => taskOf(trace) === "ruling" && trace.outcome === "ruled_impossible").length;

  const tasks = TASKS.map((task): TaskMetrics => {
    const calls = traces.filter((trace) => taskOf(trace) === task);
    return {
      task,
      calls: calls.length,
      invalid: calls.filter((trace) => INVALID_OUTCOMES.has(trace.outcome)).length,
      providerErrors: calls.filter((trace) => trace.outcome === "provider_error").length,
      cancelled: calls.filter((trace) => trace.outcome === "cancelled").length,
      tokens: calls.reduce((total, trace) => total + (trace.inputTokens ?? 0) + (trace.outputTokens ?? 0), 0),
      cost: sumCost(calls),
      meanLatencyMs: calls.length === 0 ? null : sumLatency(calls) / calls.length,
    };
  });
  const proposals = tasks.filter((entry) => PROPOSAL_TASKS.includes(entry.task));
  const answered = proposals.reduce((total, entry) => total + entry.calls - entry.providerErrors - entry.cancelled, 0);
  const invalid = proposals.reduce((total, entry) => total + entry.invalid, 0);
  const cost = sumCost(traces);

  return {
    characterTurns: characterTurns.length,
    npcTurns: turns.length - characterTurns.length,
    turnsByActor,
    turnsToFirstAction: firstAction === -1 ? null : firstAction + 1,
    longestStall,
    threatsFired: count("threat_triggered"),
    steeringRequests: count("steering"),
    rulings,
    invalidProposalRate: answered === 0 ? null : invalid / answered,
    tasks,
    calls: traces.length,
    tokens: tasks.reduce((total, entry) => total + entry.tokens, 0),
    cost,
    costPerTurn: cost === null || turns.length === 0 ? null : cost / turns.length,
    latencyPerTurnMs: turns.length === 0 ? null : sumLatency(traces) / turns.length,
  };
}
