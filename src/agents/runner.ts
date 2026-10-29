import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { AdventureEngine, TraceInput, TraceTask } from "../engine.ts";
import { EngineError, MAX_NARRATION_LENGTH, rulesOf } from "../model.ts";
import type { AdventureEvent, Command, JudgmentInput, RulingInput, WorldState } from "../model.ts";
import { BELIEF_EVENTS, beliefsOf, rankRecollections, recallQuery } from "../memory.ts";
import { availableActions, perceive } from "../perception.ts";
import { attemptProblem, checkRuling, inScene, isNarratable, isNpc, MENTAL_EVENTS, PRIVATE_EVENTS } from "../rules.ts";
import { liveEvents } from "../wipes.ts";
import {
  beliefLines, describeEvent, eventLine, goalLines, NO_DIRECTION, renderCharacterPrompt, renderJudgingPrompt,
  renderNarrationPrompt, renderNpcPrompt, renderRulingPrompt,
} from "./context.ts";
import type { JudgedAttempt, MemoryView, NpcTurnReason, Said } from "./context.ts";
import {
  characterSystemPrompt, frameOf, judgeSystemPrompt, narratorSystemPrompt, npcSystemPrompt, PROMPT_VERSION, refereeSystemPrompt,
} from "./prompts.ts";
import type { Cast, WorldFrame } from "./prompts.ts";
import {
  characterTurnSchema, judgedRulingSchema, judgmentSchema, narrationSchema, npcTurnSchema, ProposalError, rulingSchema,
  toJudgedRuling, toJudgment, toNpcParts, toRuling, toTurnParts,
} from "./protocol.ts";
import type { Ruling } from "./protocol.ts";
import { ProviderError } from "./provider.ts";
import type { AgentRole, ModelProvider, ModelRequest, ModelUsage } from "./provider.ts";
import {
  chooseNextActor, dueAgendas, lastCharacterTurn, pacePolicy, pendingSteering, togetherIn, turnDirection, turnHistory, turnsWithoutAction,
} from "./schedule.ts";
import type { Direction, StallPolicy, TurnRecord } from "./schedule.ts";

export interface RunnerSettings extends StallPolicy {
  /** Extra attempts after an invalid proposal or stale revision. */
  maxRevisions: number;
  /** A run stops after this many failed turns in a row. */
  maxConsecutiveFailures: number;
  /** A run stops after this many character turns in a row with no action, a backstop to `requireActionAfter`; 0 disables. */
  stallTurns: number;
  /** Perceived events included in an agent's context. */
  recentEvents: number;
  /** Older perceived events an agent may recall when relevant; 0 disables recall. */
  memoryEvents: number;
  /** Whether the DM narrates committed actions. */
  narrate: boolean;
  /** How long the world's scheduler lease lasts unless renewed; it renews every third of this. */
  leaseMs: number;
}

export const DEFAULT_RUNNER_SETTINGS: RunnerSettings = {
  maxRevisions: 2,
  maxConsecutiveFailures: 3,
  nudgeAfter: 3,
  requireActionAfter: 5,
  stallTurns: 8,
  recentEvents: 30,
  memoryEvents: 6,
  narrate: true,
  leaseMs: 60_000,
};

export interface RunLimits {
  /** Character and NPC turns, whether or not they committed. */
  maxTurns: number;
  maxModelCalls?: number | undefined;
  maxTokens?: number | undefined;
  /** In the provider's billing unit; calls that report no cost count as free. */
  maxCost?: number | undefined;
}

export interface RunOptions {
  /** Aborting pauses: no new call starts, and an in-flight turn is cancelled before it commits. */
  signal?: AbortSignal | undefined;
}

export interface StepOptions extends RunOptions {
  /** Cue this character or NPC to take the turn, instead of the scheduler's choice, even if muted. */
  actorId?: string | undefined;
}

export type StepOutcome =
  | { kind: "turn"; actorId: string; events: AdventureEvent[]; attempts: number }
  | { kind: "narration"; events: AdventureEvent[]; attempts: number }
  | { kind: "failed"; role: AgentRole; actorId: string | null; attempts: number; reason: string }
  | { kind: "cancelled"; role: AgentRole; actorId: string | null; reason: string };

export type StopReason =
  | "max_turns"
  | "max_model_calls"
  | "max_tokens"
  | "max_cost"
  | "consecutive_failures"
  | "stalled"
  | "ended"
  | "no_active_characters"
  | "all_muted"
  | "paused"
  | "lease_lost";

export interface RunReport {
  outcomes: StepOutcome[];
  turns: number;
  modelCalls: number;
  tokens: number;
  cost: number;
  stopReason: StopReason;
}

type BudgetReason = "max_model_calls" | "max_tokens" | "max_cost";

class BudgetExceeded extends Error {
  readonly reason: BudgetReason;

  constructor(reason: BudgetReason) {
    super(`Run budget reached: ${reason}`);
    this.reason = reason;
  }
}

/** Counts model calls, tokens, and cost; refuses to start a call once a limit is reached. */
class Budget {
  calls = 0;
  tokens = 0;
  cost = 0;
  private readonly limits: Omit<RunLimits, "maxTurns">;

  constructor(limits: Omit<RunLimits, "maxTurns"> = {}) {
    this.limits = limits;
  }

  beforeCall(): void {
    if (this.limits.maxModelCalls !== undefined && this.calls >= this.limits.maxModelCalls) {
      throw new BudgetExceeded("max_model_calls");
    }
    if (this.limits.maxTokens !== undefined && this.tokens >= this.limits.maxTokens) {
      throw new BudgetExceeded("max_tokens");
    }
    if (this.limits.maxCost !== undefined && this.cost >= this.limits.maxCost) {
      throw new BudgetExceeded("max_cost");
    }
  }

  record(usage: ModelUsage | undefined): void {
    this.calls += 1;
    this.tokens += (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
    this.cost += usage?.cost ?? 0;
  }
}

/**
 * The world's scheduler lease, renewed in the background; losing it aborts
 * `signal`. The story editor holds it too, so it and a run never overlap.
 */
export class Lease {
  private readonly engine: AdventureEngine;
  private readonly worldId: string;
  private readonly ttlMs: number;
  private readonly holder = randomUUID();
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setInterval> | undefined;
  private renewal: Promise<unknown> = Promise.resolve();

  constructor(engine: AdventureEngine, worldId: string, ttlMs: number) {
    this.engine = engine;
    this.worldId = worldId;
    this.ttlMs = ttlMs;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get lost(): boolean {
    return this.controller.signal.aborted;
  }

  /** Takes the lease, or refuses with WORLD_BUSY while another scheduler holds it. */
  async acquire(): Promise<void> {
    if (!(await this.engine.acquireLease(this.worldId, this.holder, this.ttlMs))) {
      throw new EngineError(
        "WORLD_BUSY",
        `Another scheduler is running ${this.worldId}; wait for it to stop, or for its lease to expire`,
      );
    }
    // A failed renewal is retried on the next beat; the check before each commit is what counts.
    this.timer = setInterval(() => this.renew().catch(() => undefined), Math.max(1, Math.floor(this.ttlMs / 3)));
    this.timer.unref();
  }

  /** Extends the lease. False, with `signal` aborted, once another scheduler has taken it. */
  async renew(): Promise<boolean> {
    if (this.lost) return false;
    const renewal = this.engine.acquireLease(this.worldId, this.holder, this.ttlMs);
    this.renewal = renewal.catch(() => undefined);
    if (await renewal) return true;
    this.controller.abort();
    return false;
  }

  async release(): Promise<void> {
    clearInterval(this.timer);
    // A renewal still in flight would otherwise re-create the lease after it is released.
    await this.renewal;
    if (!this.lost) await this.engine.releaseLease(this.worldId, this.holder);
  }
}

/** What a step runs under: its budget, and the signal that pauses it or reports a lost lease. */
interface Context {
  budget: Budget;
  lease: Lease;
  signal: AbortSignal;
}

type CallResult =
  | { ok: true; output: unknown; raw: unknown; model: string; usage: ModelUsage; latencyMs: number }
  | { ok: false; error: ProviderError; model: string; latencyMs: number };

type TraceBase = Pick<TraceInput, "worldId" | "turnId" | "role" | "task" | "actorId" | "attempt" | "model" | "request" | "latencyMs">;

/** Try again with this feedback; `outcome` labels the trace. */
type Redo = { redo: string; outcome: string };
/** What a referee call came to: a decision, an attempt that cannot work, or a step that ended. */
type Refereed<T> = { value: T } | { impossible: string } | { end: StepOutcome };
/** Stop the step with this outcome; `outcome` labels the trace. */
type End = { end: StepOutcome; outcome: string };

/** One agent's proposal loop: how to prompt it and how its output becomes a command. */
interface Proposal {
  task: TraceTask;
  role: AgentRole;
  actorId: string | null;
  system: string;
  schema: z.ZodType;
  schemaName: string;
  /** What the engine rejects, in feedback: "proposal", "reply", or "narration". */
  noun: string;
  /** Derived from the revision, so a duplicate runner cannot commit the same proposal twice. */
  requestId(state: WorldState): string;
  prompt(state: WorldState, feedback: string[]): Promise<string>;
  /** The command for valid output; throws ProposalError when the output is malformed. */
  command(output: unknown, state: WorldState, requestId: string): Promise<Command | Redo | End>;
  committed(events: AdventureEvent[], attempts: number): StepOutcome;
  /** After a stale revision: an outcome to stop with, or null to try again at the new state. */
  stale?(state: WorldState, attempts: number): StepOutcome | null;
}

const TRACE_OUTCOMES: Partial<Record<EngineError["code"], string>> = {
  INVALID_ACTION: "invalid_action",
  INVALID_INPUT: "invalid_action",
  STALE_REVISION: "stale",
  REQUEST_CONFLICT: "conflict",
};

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function usageFields(usage: ModelUsage | undefined): Pick<TraceInput, "inputTokens" | "outputTokens" | "cost"> {
  return { inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, cost: usage?.cost ?? null };
}

/** Parses model output against a schema, or explains the mismatch as feedback. */
function parseOutput<T>(schema: z.ZodType<T>, output: unknown, format: string): T {
  const parsed = schema.safeParse(output);
  if (!parsed.success) {
    throw new ProposalError(`Your reply did not match the ${format} format: ${oneLine(z.prettifyError(parsed.error))}`);
  }
  return parsed.data;
}

export type ContextSettings = Pick<RunnerSettings, "recentEvents" | "memoryEvents">;

/**
 * What a character or NPC knows beyond its current perception: its recent
 * events, older events recalled as relevant now, its beliefs, and its goals.
 * Every part derives from events delivered to it, so its context holds nothing
 * it did not perceive. Its own notes and goals appear as beliefs and goals, not
 * as events.
 */
export async function recallContext(
  engine: AdventureEngine,
  worldId: string,
  state: WorldState,
  viewerId: string,
  settings: ContextSettings,
): Promise<{ recent: string[]; memory: MemoryView }> {
  const perception = perceive(state, viewerId);
  const recent = await engine.getPerceivedEvents(worldId, viewerId, settings.recentEvents, { exclude: MENTAL_EVENTS });
  const query = settings.memoryEvents > 0 ? recallQuery(perception, recent) : "";
  const matches = query
    ? await engine.searchMemories(worldId, viewerId, query, { before: recent[0]?.sequence ?? state.revision + 1, limit: 40 })
    : [];
  const perceived = await engine.getPerceivedEvents(worldId, viewerId, 1000, { types: BELIEF_EVENTS });
  return {
    recent: recent.map((event) => eventLine(event, state, viewerId)),
    memory: {
      recalled: rankRecollections(matches, viewerId, state, settings.memoryEvents).map((event) => eventLine(event, state, viewerId)),
      beliefs: beliefLines(beliefsOf(viewerId, perceived, state), perception, state),
      goals: goalLines(state, viewerId),
    },
  };
}

/** Recent events, enough for turn order, stalls, agendas, and pending steering; none the director wiped. */
async function schedulingEvents(engine: AdventureEngine, worldId: string, state: WorldState): Promise<AdventureEvent[]> {
  return liveEvents(await engine.getEvents(worldId, Math.max(0, state.revision - 500), 500));
}

/** The director's pending steering for an actor, and for a character, the pressure of a stalled debate. */
export async function directionFor(
  engine: AdventureEngine,
  worldId: string,
  state: WorldState,
  actorId: string,
  policy: StallPolicy,
): Promise<Direction> {
  const events = await schedulingEvents(engine, worldId, state);
  return isNpc(state, actorId)
    ? { ...NO_DIRECTION, steering: pendingSteering(events, actorId) }
    : turnDirection(turnHistory(events, state), events, actorId, policy);
}

/** The user message a character's agent receives this turn. */
export async function buildCharacterPrompt(
  engine: AdventureEngine,
  worldId: string,
  state: WorldState,
  actorId: string,
  settings: ContextSettings,
  feedback: string[] = [],
  direction: Direction = NO_DIRECTION,
): Promise<string> {
  const { recent, memory } = await recallContext(engine, worldId, state, actorId, settings);
  return renderCharacterPrompt(perceive(state, actorId), availableActions(state, actorId), recent, feedback, memory, direction);
}

/** The user message the DM receives to voice an NPC: one who was spoken to, was cued, or whose agenda came due. */
export async function buildNpcPrompt(
  engine: AdventureEngine,
  worldId: string,
  state: WorldState,
  npcId: string,
  settings: ContextSettings,
  feedback: string[] = [],
  reason: NpcTurnReason = "addressed",
  steering: string[] = [],
): Promise<string> {
  const { recent, memory } = await recallContext(engine, worldId, state, npcId, settings);
  return renderNpcPrompt(perceive(state, npcId), recent, feedback, reason, memory, steering, await failedSince(engine, worldId, state, npcId));
}

/**
 * Attempts that failed where an NPC could see them since it last spoke, as
 * lines for its prompt: a failed attempt to get something from it means it did
 * not give it, so its next words must not hand it over.
 */
async function failedSince(engine: AdventureEngine, worldId: string, state: WorldState, npcId: string): Promise<string[]> {
  const perceived = await engine.getPerceivedEvents(worldId, npcId, 30, { types: ["utterance", "check_resolved"] });
  const spoke = perceived.findLast((event) => event.data.type === "utterance" && event.data.actorId === npcId)?.sequence ?? 0;
  return perceived.flatMap((event) => {
    const data = event.data;
    if (event.sequence <= spoke || data.type !== "check_resolved" || data.success) return [];
    const who = state.characters.find((character) => character.id === data.actorId)?.name ?? data.actorId;
    const challenge = state.challenges.find((entry) => entry.id === data.challengeId)?.name ?? data.challengeId;
    return [`- ${who} tried "${challenge}", and it didn't work.${data.reason === undefined ? "" : ` The referee: ${data.reason}`}`];
  });
}

/**
 * Runs turns for one world: the DM narrates committed actions, then the next
 * actor speaks and may act. Turn order derives from the event log, so a
 * restarted runner continues where the last one stopped. A lease keeps a
 * second runner off the world while this one works.
 */
export class TurnRunner {
  private readonly engine: AdventureEngine;
  private readonly provider: ModelProvider;
  private readonly cast: Cast;
  private readonly settings: RunnerSettings;

  constructor(engine: AdventureEngine, provider: ModelProvider, cast: Cast, settings: Partial<RunnerSettings> = {}) {
    this.engine = engine;
    this.provider = provider;
    this.cast = cast;
    // A conversation's pace eases the stall ladder.
    this.settings = pacePolicy(cast.pace, { ...DEFAULT_RUNNER_SETTINGS, ...settings });
  }

  private frame(state: WorldState): WorldFrame {
    return frameOf(this.cast, state);
  }

  /** Runs exactly one turn, plus any narration owed before or after it. */
  async step(worldId: string, onOutcome?: (outcome: StepOutcome) => void, options: StepOptions = {}): Promise<StepOutcome[]> {
    const outcomes: StepOutcome[] = [];
    await this.session(worldId, new Budget(), options, async (context) => {
      if (options.actorId !== undefined) this.checkCue(await this.engine.getWorld(worldId), options.actorId);
      await this.stepWithin(worldId, context, (outcome) => {
        outcomes.push(outcome);
        onOutcome?.(outcome);
      }, options.actorId);
    });
    return outcomes;
  }

  /** Runs turns until a limit, a stall, repeated failures, or a pause stops it. */
  async run(
    worldId: string,
    limits: RunLimits,
    onOutcome?: (outcome: StepOutcome) => void,
    options: RunOptions = {},
  ): Promise<RunReport> {
    if (!Number.isInteger(limits.maxTurns) || limits.maxTurns < 1) {
      throw new EngineError("INVALID_INPUT", "maxTurns must be a positive integer");
    }
    if (limits.maxCost !== undefined && !(Number.isFinite(limits.maxCost) && limits.maxCost > 0)) {
      throw new EngineError("INVALID_INPUT", "maxCost must be a positive number");
    }
    const budget = new Budget({ maxModelCalls: limits.maxModelCalls, maxTokens: limits.maxTokens, maxCost: limits.maxCost });
    return this.session(worldId, budget, options, async (context) => {
      const outcomes: StepOutcome[] = [];
      let turns = 0;
      let consecutiveFailures = 0;
      const stop = (stopReason: StopReason): RunReport => ({
        outcomes, turns, modelCalls: budget.calls, tokens: budget.tokens, cost: budget.cost, stopReason,
      });
      for (;;) {
        if (turns >= limits.maxTurns) return stop("max_turns");
        if (context.lease.lost) return stop("lease_lost");
        if (context.signal.aborted) return stop("paused");
        const state = await this.engine.getWorld(worldId);
        // An ending whose narration failed gets another try before the run stops.
        const owed = this.settings.narrate && (await this.pendingNarration(worldId, state)).length > 0;
        if (state.endedWith !== undefined && !owed) return stop("ended");
        const agents = this.activeAgents(state);
        if (agents.length === 0) return stop("no_active_characters");
        const muted = new Set(await this.engine.getMuted(worldId));
        if (agents.every((character) => muted.has(character.id))) return stop("all_muted");
        if (await this.isStalled(worldId, state)) return stop("stalled");
        const recorded: StepOutcome[] = [];
        let budgetReached: BudgetExceeded | undefined;
        try {
          await this.stepWithin(worldId, context, (outcome) => {
            recorded.push(outcome);
            outcomes.push(outcome);
            onOutcome?.(outcome);
          });
        } catch (error) {
          if (!(error instanceof BudgetExceeded)) throw error;
          budgetReached = error;
        }
        // A turn counts once its actor has answered, whether or not it committed.
        if (recorded.some((outcome) => outcome.kind === "turn" || (outcome.kind === "failed" && outcome.actorId !== null))) {
          turns += 1;
        }
        if (budgetReached) return stop(budgetReached.reason);
        if (recorded.some((outcome) => outcome.kind === "cancelled")) return stop(context.lease.lost ? "lease_lost" : "paused");
        consecutiveFailures = recorded.some((outcome) => outcome.kind === "failed") ? consecutiveFailures + 1 : 0;
        if (consecutiveFailures >= this.settings.maxConsecutiveFailures) return stop("consecutive_failures");
      }
    });
  }

  /** Holds the world's lease while `body` runs. */
  private async session<T>(
    worldId: string,
    budget: Budget,
    options: RunOptions,
    body: (context: Context) => Promise<T>,
  ): Promise<T> {
    await this.engine.getWorld(worldId);
    const lease = new Lease(this.engine, worldId, this.settings.leaseMs);
    await lease.acquire();
    try {
      const signal = options.signal ? AbortSignal.any([options.signal, lease.signal]) : lease.signal;
      return await body({ budget, lease, signal });
    } finally {
      await lease.release();
    }
  }

  /** Refuses a cue for someone who cannot take a turn. */
  private checkCue(state: WorldState, actorId: string): void {
    const character = state.characters.find((entry) => entry.id === actorId);
    if (!character) throw new EngineError("NOT_FOUND", `Unknown character: ${actorId}`);
    if (state.endedWith !== undefined) throw new EngineError("INVALID_INPUT", "The story has ended; nobody takes another turn");
    const able = character.npc ? this.activeNpcs(state) : this.activeAgents(state);
    if (!able.some((entry) => entry.id === actorId)) {
      const reason = character.hp === 0 ? "is incapacitated" : !inScene(character) ? "is away from the scene" : "has no persona in the cast";
      throw new EngineError("INVALID_INPUT", `${actorId} cannot take a turn: ${actorId} ${reason}`);
    }
  }

  private async stepWithin(
    worldId: string,
    context: Context,
    record: (outcome: StepOutcome) => void,
    cue?: string,
  ): Promise<void> {
    if (context.signal.aborted) return;
    let state = await this.engine.getWorld(worldId);
    if (this.settings.narrate) {
      // Narration owed from an interrupted step comes before the next actor.
      const pending = await this.pendingNarration(worldId, state);
      if (pending.length > 0) {
        const narrated = await this.narrate(worldId, state, pending, context);
        record(narrated);
        if (narrated.kind !== "narration" || context.signal.aborted) return;
        state = await this.engine.getWorld(worldId);
      }
    }
    if (state.endedWith !== undefined) return;
    const events = await schedulingEvents(this.engine, worldId, state);
    const turns = turnHistory(events, state);
    const next = cue === undefined ? await this.nextActor(worldId, state, turns) : { id: cue, npc: isNpc(state, cue) };
    if (!next) return;
    // The scheduler picks an NPC when spoken to or when its agenda is due; a cued NPC may be neither.
    const last = turns.at(-1);
    const addressed = last?.addresseeId === next.id && togetherIn(state)(last.actorId, next.id);
    const reason: NpcTurnReason = addressed ? "addressed" : cue === undefined ? "agenda" : "cued";
    const turn = next.npc
      ? await this.npcTurn(worldId, state, next.id, context, reason, pendingSteering(events, next.id))
      : await this.characterTurn(worldId, state, next.id, context, turnDirection(turns, events, next.id, this.settings));
    record(turn);
    // NPC turns are not narrated; a paused step leaves narration for the next one.
    if (turn.kind !== "turn" || next.npc || !this.settings.narrate || context.signal.aborted) return;
    const actions = await this.narratable(worldId, turn.events, turn.actorId);
    if (actions.length > 0) {
      record(await this.narrate(worldId, await this.engine.getWorld(worldId), actions, context));
    }
  }

  /** Conscious characters in the scene with a persona, in world order. */
  private activeAgents(state: WorldState) {
    return state.characters.filter((character) => (
      character.hp > 0 && inScene(character) && !character.npc && Object.hasOwn(this.cast.characters, character.id)
    ));
  }

  /** Conscious NPCs in the scene with a persona. */
  private activeNpcs(state: WorldState) {
    const npcs = this.cast.npcs ?? {};
    return state.characters.filter((character) => (
      character.hp > 0 && inScene(character) && character.npc && Object.hasOwn(npcs, character.id)
    ));
  }

  /** The latest `count` events, less any the director wiped. */
  private async recentEvents(worldId: string, state: WorldState, count: number): Promise<AdventureEvent[]> {
    return liveEvents(await this.engine.getEvents(worldId, Math.max(0, state.revision - count), count));
  }

  /** The scheduler's choice among those who can act and are not muted. */
  private async nextActor(worldId: string, state: WorldState, turns: TurnRecord[]): Promise<{ id: string; npc: boolean } | null> {
    const muted = new Set(await this.engine.getMuted(worldId));
    const unmuted = (characters: WorldState["characters"]) => characters
      .filter((character) => !muted.has(character.id))
      .map((character) => character.id);
    const npcs = new Set(unmuted(this.activeNpcs(state)));
    const agendas = new Map(Object.entries(this.cast.npcs ?? {}).flatMap(([id, persona]) => (
      persona.agenda && npcs.has(id) ? [[id, persona.agenda.everyMinutes * 60] as const] : []
    )));
    const id = chooseNextActor(turns, unmuted(this.activeAgents(state)), npcs, dueAgendas(turns, state, agendas), togetherIn(state));
    return id === null ? null : { id, npc: npcs.has(id) };
  }

  /** Actions from the latest character turn that no narration covers yet. */
  private async pendingNarration(worldId: string, state: WorldState): Promise<AdventureEvent[]> {
    const recent = await this.recentEvents(worldId, state, 50);
    const lastTurn = lastCharacterTurn(turnHistory(recent, state));
    if (!lastTurn) return [];
    const narrated = new Set(recent.flatMap((event) => (
      event.data.type === "narration" ? event.data.aboutSequences : []
    )));
    return this.narratable(worldId, recent.filter((event) => (
      event.requestId === lastTurn.requestId && !narrated.has(event.sequence)
    )), lastTurn.actorId);
  }

  /**
   * The events of a turn to narrate: actions its actor perceived. A threat
   * during the turn can bring someone in elsewhere, and one narration reaches
   * everyone who perceived any of what it covers.
   */
  private async narratable(worldId: string, events: AdventureEvent[], actorId: string): Promise<AdventureEvent[]> {
    const actions = events.filter((event) => isNarratable(event.data.type));
    const perceivers = await Promise.all(actions.map((event) => this.engine.getPerceivers(worldId, event.sequence)));
    return actions.filter((_, index) => perceivers[index]!.includes(actorId));
  }

  /** True when the latest `stallTurns` character turns were all speech. */
  private async isStalled(worldId: string, state: WorldState): Promise<boolean> {
    if (this.settings.stallTurns <= 0) return false;
    const turns = turnHistory(await this.recentEvents(worldId, state, 500), state);
    return turnsWithoutAction(turns) >= this.settings.stallTurns;
  }

  private async callModel(request: ModelRequest, context: Context): Promise<CallResult> {
    context.budget.beforeCall();
    const model = this.provider.modelFor(request.role);
    if (context.signal.aborted) {
      return { ok: false, error: new ProviderError("cancelled", "The call was cancelled"), model, latencyMs: 0 };
    }
    const started = performance.now();
    try {
      const response = await this.provider.generate({ ...request, signal: context.signal });
      context.budget.record(response.usage);
      return { ok: true, ...response, latencyMs: performance.now() - started };
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      context.budget.record(error.usage);
      return { ok: false, error, model, latencyMs: performance.now() - started };
    }
  }

  private async trace(entry: Omit<TraceInput, "provider" | "promptVersion">): Promise<void> {
    await this.engine.recordTrace({ ...entry, provider: this.provider.name, promptVersion: PROMPT_VERSION });
  }

  private async traceFailure(base: TraceBase, error: ProviderError): Promise<void> {
    await this.trace({
      ...base, ...usageFields(error.usage), response: error.raw ?? null,
      outcome: error.kind === "cancelled" ? "cancelled" : "provider_error",
      error: `${error.kind}: ${error.message}`, requestId: null,
    });
  }

  private cancelled(role: AgentRole, actorId: string | null, context: Context): StepOutcome {
    const reason = context.lease.lost ? "Another scheduler took over the world" : "Paused before anything committed";
    return { kind: "cancelled", role, actorId, reason };
  }

  /**
   * Prompts an agent until its proposal commits, feeding back why each attempt
   * was rejected, up to the revision limit.
   */
  private async propose(worldId: string, initial: WorldState, context: Context, proposal: Proposal): Promise<StepOutcome> {
    const { task, role, actorId, system, schema, schemaName } = proposal;
    const maxAttempts = this.settings.maxRevisions + 1;
    const failed = (attempts: number, reason: string): StepOutcome => ({ kind: "failed", role, actorId, attempts, reason });
    let state = initial;
    let feedback: string[] = [];
    let reason = `No valid ${proposal.noun} within the revision limit`;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const requestId = proposal.requestId(state);
      const prompt = await proposal.prompt(state, feedback);
      const call = await this.callModel({ role, system, prompt, schema, schemaName }, context);
      const base: TraceBase = {
        worldId, turnId: requestId, role, task, actorId, attempt,
        model: call.model, request: { system, prompt }, latencyMs: call.latencyMs,
      };
      if (!call.ok) {
        await this.traceFailure(base, call.error);
        return call.error.kind === "cancelled"
          ? this.cancelled(role, actorId, context)
          : failed(attempt, `${call.error.kind}: ${call.error.message}`);
      }
      const trace = (outcome: string, error: string | null, committedId: string | null) => this.trace({
        ...base, ...usageFields(call.usage), response: call.raw, outcome, error, requestId: committedId,
      });
      let command: Command;
      try {
        const result = await proposal.command(call.output, state, requestId);
        if ("end" in result) {
          await trace(result.outcome, result.end.kind === "failed" ? result.end.reason : null, null);
          return result.end;
        }
        if ("redo" in result) {
          reason = result.redo;
          feedback = [result.redo];
          await trace(result.outcome, result.redo, null);
          continue;
        }
        command = result;
      } catch (error) {
        if (!(error instanceof ProposalError)) throw error;
        reason = error.message;
        feedback = [error.message];
        await trace("invalid_output", error.message, null);
        continue;
      }
      // A pause, or another scheduler taking the world, cancels the proposal before it commits.
      if (context.signal.aborted || !(await context.lease.renew())) {
        await trace("cancelled", null, null);
        return this.cancelled(role, actorId, context);
      }
      try {
        const result = await this.engine.execute(worldId, command);
        await trace("committed", null, requestId);
        return proposal.committed(result.events, attempt);
      } catch (error) {
        if (!(error instanceof EngineError)) throw error;
        await trace(TRACE_OUTCOMES[error.code] ?? "error", `${error.code}: ${oneLine(error.message)}`, requestId);
        switch (error.code) {
          case "INVALID_ACTION":
          case "INVALID_INPUT":
            reason = oneLine(error.message);
            feedback = [`The engine rejected your ${proposal.noun}: ${reason}`];
            break;
          case "STALE_REVISION": {
            reason = "The world changed during every attempt";
            state = await this.engine.getWorld(worldId);
            feedback = [];
            const stop = proposal.stale?.(state, attempt);
            if (stop) return stop;
            break;
          }
          case "REQUEST_CONFLICT":
            return failed(attempt, "Another runner already committed this turn");
          default:
            throw error;
        }
      }
    }
    return failed(maxAttempts, reason);
  }

  private async characterTurn(
    worldId: string,
    initial: WorldState,
    actorId: string,
    context: Context,
    direction: Direction,
  ): Promise<StepOutcome> {
    const name = initial.characters.find((character) => character.id === actorId)!.name;
    return this.propose(worldId, initial, context, {
      task: "character_turn",
      role: "character",
      actorId,
      system: characterSystemPrompt(name, this.cast.characters[actorId]!, this.frame(initial)),
      schema: characterTurnSchema,
      schemaName: "take_turn",
      noun: "proposal",
      requestId: (state) => `t${state.revision}-${actorId}`,
      prompt: (state, feedback) => buildCharacterPrompt(this.engine, worldId, state, actorId, this.settings, feedback, direction),
      command: async (output, state, requestId): Promise<Command | Redo | End> => {
        const { action, ...speech } = toTurnParts(parseOutput(characterTurnSchema, output, "turn"));
        if (direction.requireAction && !action) {
          throw new ProposalError(`Take an action this turn: nobody has acted for ${direction.stalled} turns`);
        }
        const command = { role: "character" as const, requestId, expectedRevision: state.revision, actorId, ...speech };
        // Words in the same turn commit with the attempt, so the referee hears them here rather than among recent events.
        const said = speech.speech === undefined ? undefined : { text: speech.speech, addresseeId: speech.addresseeId };
        const ended = (end: StepOutcome): End => ({ end, outcome: end.kind === "cancelled" ? "cancelled" : "ruling_failed" });
        if (action?.type === "attempt_check" && rulesOf(state).outcomes === "judgment") {
          // In a judgment world the referee decides the check, so only a check the engine allows reaches it.
          const problem = attemptProblem(state, actorId, action.challengeId);
          if (problem) return { redo: `The engine rejected your proposal: ${problem}`, outcome: "invalid_action" };
          const judged = await this.judge(worldId, state, actorId, action, requestId, context, said);
          if ("end" in judged) return ended(judged.end);
          if ("impossible" in judged) return { redo: judged.impossible, outcome: "invalid_output" };
          return { ...command, action, judgment: judged.value };
        }
        if (action?.type !== "attempt") return { ...command, ...(action ? { action } : {}) };
        if (!availableActions(state, actorId).intent) throw new ProposalError("attempt is not one of your available actions");
        const ruled = await this.rule(worldId, state, actorId, action.intent, requestId, context, said);
        if ("end" in ruled) return ended(ruled.end);
        if ("impossible" in ruled) {
          return { redo: `The referee ruled that "${action.intent}" cannot work: ${ruled.impossible}`, outcome: "ruled_impossible" };
        }
        return { ...command, action, ...ruled.value };
      },
      committed: (events, attempts) => ({ kind: "turn", actorId, events, attempts }),
      stale: (state, attempts) => (this.activeAgents(state).some((character) => character.id === actorId)
        ? null
        : { kind: "failed", role: "character", actorId, attempts, reason: `${actorId} can no longer act` }),
    });
  }

  private async npcTurn(
    worldId: string,
    initial: WorldState,
    npcId: string,
    context: Context,
    reason: NpcTurnReason,
    steering: string[],
  ): Promise<StepOutcome> {
    const name = initial.characters.find((character) => character.id === npcId)!.name;
    return this.propose(worldId, initial, context, {
      task: "npc_turn",
      role: "dm",
      actorId: npcId,
      system: npcSystemPrompt(name, this.cast.npcs![npcId]!, this.frame(initial)),
      schema: npcTurnSchema,
      schemaName: "npc_turn",
      noun: "reply",
      requestId: (state) => `t${state.revision}-${npcId}`,
      prompt: (state, feedback) => buildNpcPrompt(
        this.engine, worldId, state, npcId, this.settings, feedback, reason, steering,
      ),
      command: async (output, state, requestId) => ({
        role: "npc", requestId, expectedRevision: state.revision, actorId: npcId,
        ...toNpcParts(parseOutput(npcTurnSchema, output, "reply")),
      }),
      committed: (events, attempts) => ({ kind: "turn", actorId: npcId, events, attempts }),
      stale: (state, attempts) => (this.activeNpcs(state).some((character) => character.id === npcId)
        ? null
        : { kind: "failed", role: "dm", actorId: npcId, attempts, reason: `${npcId} can no longer act` }),
    });
  }

  /** What the referee may see of the actor's situation: recent public events, and in a judgment world, their discoveries. */
  private async refereeContext(worldId: string, state: WorldState, actorId: string): Promise<{ recent: string[]; discoveries: string[] }> {
    const judged = rulesOf(state).outcomes === "judgment";
    // The referee's words reach everyone present: only a judgment world's referee sees private discoveries, with orders to keep them.
    const recent = (await this.engine.getPerceivedEvents(worldId, actorId, judged ? 12 : 8, { exclude: PRIVATE_EVENTS }))
      .map((event) => describeEvent(event, state, actorId));
    const discoveries = judged
      ? (await this.engine.getPerceivedEvents(worldId, actorId, 20, { types: ["discovery"] })).map((event) => describeEvent(event, state, actorId))
      : [];
    return { recent, discoveries };
  }

  /**
   * Asks the DM to rule on an attempt, until the ruling fits the world's limits.
   * In a judgment world the ruling also decides whether a check succeeds. The
   * ruling commits with the character's turn, before any roll.
   */
  private async rule(
    worldId: string,
    state: WorldState,
    actorId: string,
    intent: string,
    turnId: string,
    context: Context,
    said?: Said,
  ): Promise<Refereed<{ ruling: RulingInput; judgment?: JudgmentInput }>> {
    const rules = rulesOf(state);
    const judged = rules.outcomes === "judgment";
    const { recent, discoveries } = await this.refereeContext(worldId, state, actorId);
    return this.referee(worldId, actorId, turnId, context, {
      system: refereeSystemPrompt(this.frame(state)),
      schema: judged ? judgedRulingSchema : rulingSchema,
      schemaName: "rule",
      noun: "ruling",
      success: "ruled",
      prompt: (feedback) => (judged
        ? renderJudgingPrompt(state, actorId, { intent }, recent, discoveries, feedback, said)
        : renderRulingPrompt(state, actorId, intent, recent, feedback, said)),
      decide: (output) => {
        const ruling: Ruling = judged
          ? toJudgedRuling(parseOutput(judgedRulingSchema, output, "ruling"), rules, state.rulings)
          : toRuling(parseOutput(rulingSchema, output, "ruling"));
        if (ruling.kind === "impossible") return { impossible: ruling.reason };
        const problem = checkRuling(state, actorId, intent, ruling.ruling);
        if (problem) return { problem };
        return { value: { ruling: ruling.ruling, ...(ruling.judgment ? { judgment: ruling.judgment } : {}) } };
      },
    });
  }

  /** Asks the referee whether an attempt at a listed challenge works, in a judgment world. */
  private async judge(
    worldId: string,
    state: WorldState,
    actorId: string,
    attempt: Extract<JudgedAttempt, { challengeId: string }>,
    turnId: string,
    context: Context,
    said?: Said,
  ): Promise<Refereed<JudgmentInput>> {
    const { recent, discoveries } = await this.refereeContext(worldId, state, actorId);
    return this.referee(worldId, actorId, turnId, context, {
      system: judgeSystemPrompt(this.frame(state)),
      schema: judgmentSchema,
      schemaName: "judge",
      noun: "judgment",
      success: "judged",
      prompt: (feedback) => renderJudgingPrompt(state, actorId, attempt, recent, discoveries, feedback, said),
      decide: (output) => ({ value: toJudgment(parseOutput(judgmentSchema, output, "judgment")) }),
    });
  }

  /** Prompts the referee until its decision is well formed and the engine would accept it, up to the revision limit. */
  private async referee<T>(
    worldId: string,
    actorId: string,
    turnId: string,
    context: Context,
    call: {
      system: string;
      schema: z.ZodType;
      schemaName: string;
      /** What the engine rejects, in feedback and failure reasons. */
      noun: string;
      /** The trace outcome when the decision stands. */
      success: string;
      prompt(feedback: string[]): string;
      decide(output: unknown): { value: T } | { impossible: string } | { problem: string };
    },
  ): Promise<Refereed<T>> {
    const { system, schema, schemaName } = call;
    const maxAttempts = this.settings.maxRevisions + 1;
    let feedback: string[] = [];
    let reason = `No valid ${call.noun} within the revision limit`;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const prompt = call.prompt(feedback);
      const result = await this.callModel({ role: "dm", system, prompt, schema, schemaName }, context);
      const base: TraceBase = {
        worldId, turnId, role: "dm", task: "ruling", actorId, attempt,
        model: result.model, request: { system, prompt }, latencyMs: result.latencyMs,
      };
      if (!result.ok) {
        await this.traceFailure(base, result.error);
        return {
          end: result.error.kind === "cancelled"
            ? this.cancelled("dm", actorId, context)
            : { kind: "failed", role: "dm", actorId, attempts: attempt, reason: `Referee ${result.error.kind}: ${result.error.message}` },
        };
      }
      const trace = (outcome: string, error: string | null) => this.trace({
        ...base, ...usageFields(result.usage), response: result.raw, outcome, error, requestId: null,
      });
      let decision: ReturnType<typeof call.decide>;
      try {
        decision = call.decide(result.output);
      } catch (error) {
        if (!(error instanceof ProposalError)) throw error;
        reason = error.message;
        feedback = [error.message];
        await trace("invalid_output", error.message);
        continue;
      }
      if ("impossible" in decision) {
        await trace("ruled_impossible", null);
        return decision;
      }
      if ("problem" in decision) {
        reason = decision.problem;
        feedback = [`The engine rejected your ${call.noun}: ${decision.problem}`];
        await trace(`invalid_${call.noun}`, decision.problem);
        continue;
      }
      await trace(call.success, null);
      return decision;
    }
    return { end: { kind: "failed", role: "dm", actorId, attempts: maxAttempts, reason: `Referee: ${reason}` } };
  }

  private async narrate(worldId: string, initial: WorldState, about: AdventureEvent[], context: Context): Promise<StepOutcome> {
    const aboutSequences = about.map((event) => event.sequence);
    const requestId = `n${aboutSequences[0]}-${aboutSequences.at(-1)}`;
    return this.propose(worldId, initial, context, {
      task: "narration",
      role: "dm",
      actorId: null,
      system: narratorSystemPrompt(this.cast.narratorStyle, this.frame(initial)),
      schema: narrationSchema,
      schemaName: "narrate",
      noun: "narration",
      requestId: () => requestId,
      prompt: (state, feedback) => this.narrationPrompt(worldId, state, about, feedback),
      command: async (output, state) => {
        const parsed = narrationSchema.safeParse(output);
        const text = parsed.success ? parsed.data.narration.trim() : "";
        if (!text || text.length > MAX_NARRATION_LENGTH) {
          throw new ProposalError(`Narration must be 1 to ${MAX_NARRATION_LENGTH} characters in the narration field`);
        }
        return { role: "dm", requestId, expectedRevision: state.revision, action: { type: "narrate", aboutSequences, text } };
      },
      committed: (events, attempts) => ({ kind: "narration", events, attempts }),
    });
  }

  /**
   * The narrator sees the outcome in full, but earlier events only if every
   * perceiver of the outcome also perceived them, and never private events, so
   * narration cannot leak another scene, a discovery, or a thought to its audience.
   */
  private async narrationPrompt(
    worldId: string,
    state: WorldState,
    about: AdventureEvent[],
    feedback: string[],
  ): Promise<string> {
    const first = about[0]!;
    const actorId = "actorId" in first.data ? first.data.actorId : null;
    const locationId = state.characters.find((character) => character.id === actorId)?.locationId
      ?? state.locations[0]!.id;
    const audience = await this.engine.getPerceivers(worldId, first.sequence);
    const histories = await Promise.all(
      audience.map((characterId) => this.engine.getPerceivedEvents(worldId, characterId, 20, { exclude: PRIVATE_EVENTS })),
    );
    const shared = (histories[0] ?? []).filter((event) => (
      event.sequence < first.sequence
      && histories.every((history) => history.some((entry) => entry.sequence === event.sequence))
    ));
    return renderNarrationPrompt(
      state,
      locationId,
      about.map((event) => describeEvent(event, state, null)),
      shared.slice(-8).map((event) => describeEvent(event, state, null)),
      feedback,
    );
  }
}
