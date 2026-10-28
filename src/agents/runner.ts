import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { AdventureEngine, TraceInput } from "../engine.ts";
import { EngineError, MAX_NARRATION_LENGTH } from "../model.ts";
import type { AdventureEvent, Command, WorldState } from "../model.ts";
import { availableActions, perceive } from "../perception.ts";
import { isNarratable } from "../rules.ts";
import { describeEvent, renderCharacterPrompt, renderNarrationPrompt } from "./context.ts";
import { characterSystemPrompt, narratorSystemPrompt, PROMPT_VERSION } from "./prompts.ts";
import type { Cast } from "./prompts.ts";
import { characterTurnSchema, narrationSchema, ProposalError, toTurnParts } from "./protocol.ts";
import { ProviderError } from "./provider.ts";
import type { AgentRole, ModelProvider, ModelRequest, ModelUsage } from "./provider.ts";

export interface RunnerSettings {
  /** Extra attempts after an invalid proposal or stale revision. */
  maxRevisions: number;
  /** A run stops after this many failed turns in a row. */
  maxConsecutiveFailures: number;
  /** A run stops after this many character turns in a row with no action; 0 disables. */
  stallTurns: number;
  /** Perceived events included in a character's context. */
  recentEvents: number;
  /** Whether the DM narrates committed actions. */
  narrate: boolean;
}

export const DEFAULT_RUNNER_SETTINGS: RunnerSettings = {
  maxRevisions: 2,
  maxConsecutiveFailures: 3,
  stallTurns: 6,
  recentEvents: 30,
  narrate: true,
};

export interface RunLimits {
  maxTurns: number;
  maxModelCalls?: number | undefined;
  maxTokens?: number | undefined;
}

export type StepOutcome =
  | { kind: "turn"; actorId: string; events: AdventureEvent[]; attempts: number }
  | { kind: "narration"; events: AdventureEvent[]; attempts: number }
  | { kind: "failed"; role: AgentRole; actorId: string | null; attempts: number; reason: string };

export type StopReason =
  | "max_turns"
  | "max_model_calls"
  | "max_tokens"
  | "consecutive_failures"
  | "stalled"
  | "no_active_characters";

export interface RunReport {
  outcomes: StepOutcome[];
  turns: number;
  modelCalls: number;
  tokens: number;
  stopReason: StopReason;
}

class BudgetExceeded extends Error {
  readonly reason: "max_model_calls" | "max_tokens";

  constructor(reason: "max_model_calls" | "max_tokens") {
    super(`Run budget reached: ${reason}`);
    this.reason = reason;
  }
}

/** Counts model calls and tokens; refuses to start a call once a limit is reached. */
class Budget {
  calls = 0;
  tokens = 0;
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
  }

  record(usage: ModelUsage | undefined): void {
    this.calls += 1;
    this.tokens += (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  }
}

type CallResult =
  | { ok: true; output: unknown; raw: unknown; model: string; usage: ModelUsage; latencyMs: number }
  | { ok: false; error: ProviderError; model: string; latencyMs: number };

const TRACE_OUTCOMES: Partial<Record<EngineError["code"], string>> = {
  INVALID_ACTION: "invalid_action",
  INVALID_INPUT: "invalid_action",
  STALE_REVISION: "stale",
  REQUEST_CONFLICT: "conflict",
};

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The user message a character's agent receives this turn. */
export async function buildCharacterPrompt(
  engine: AdventureEngine,
  worldId: string,
  state: WorldState,
  actorId: string,
  recentEvents: number,
  feedback: string[] = [],
): Promise<string> {
  const recent = await engine.getPerceivedEvents(worldId, actorId, recentEvents);
  return renderCharacterPrompt(
    perceive(state, actorId),
    availableActions(state, actorId),
    recent.map((event) => describeEvent(event, state, actorId)),
    feedback,
  );
}

/**
 * Runs turns for one world: the DM narrates committed actions, then the next
 * character speaks and may act. Turn order derives from the event log, so a
 * restarted runner continues where the last one stopped.
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
    this.settings = { ...DEFAULT_RUNNER_SETTINGS, ...settings };
  }

  /** Runs exactly one character turn, plus any narration owed before or after it. */
  async step(worldId: string, onOutcome?: (outcome: StepOutcome) => void): Promise<StepOutcome[]> {
    const outcomes: StepOutcome[] = [];
    await this.stepWithin(worldId, new Budget(), (outcome) => {
      outcomes.push(outcome);
      onOutcome?.(outcome);
    });
    return outcomes;
  }

  /** Runs turns until a limit, a stall, or repeated failures stop it. */
  async run(worldId: string, limits: RunLimits, onOutcome?: (outcome: StepOutcome) => void): Promise<RunReport> {
    if (!Number.isInteger(limits.maxTurns) || limits.maxTurns < 1) {
      throw new EngineError("INVALID_INPUT", "maxTurns must be a positive integer");
    }
    const budget = new Budget({ maxModelCalls: limits.maxModelCalls, maxTokens: limits.maxTokens });
    const outcomes: StepOutcome[] = [];
    let turns = 0;
    let consecutiveFailures = 0;
    const stop = (stopReason: StopReason): RunReport => ({
      outcomes, turns, modelCalls: budget.calls, tokens: budget.tokens, stopReason,
    });
    for (;;) {
      if (turns >= limits.maxTurns) return stop("max_turns");
      const state = await this.engine.getWorld(worldId);
      if (this.activeCharacters(state).length === 0) return stop("no_active_characters");
      if (await this.isStalled(worldId, state)) return stop("stalled");
      const recorded: StepOutcome[] = [];
      let budgetReached: BudgetExceeded | undefined;
      try {
        await this.stepWithin(worldId, budget, (outcome) => {
          recorded.push(outcome);
          outcomes.push(outcome);
          onOutcome?.(outcome);
        });
      } catch (error) {
        if (!(error instanceof BudgetExceeded)) throw error;
        budgetReached = error;
      }
      // A turn counts once its character has answered, whether or not it committed.
      if (recorded.some((outcome) => outcome.kind === "turn" || (outcome.kind === "failed" && outcome.role === "character"))) {
        turns += 1;
      }
      if (budgetReached) return stop(budgetReached.reason);
      consecutiveFailures = recorded.some((outcome) => outcome.kind === "failed") ? consecutiveFailures + 1 : 0;
      if (consecutiveFailures >= this.settings.maxConsecutiveFailures) return stop("consecutive_failures");
    }
  }

  private async stepWithin(worldId: string, budget: Budget, record: (outcome: StepOutcome) => void): Promise<void> {
    let state = await this.engine.getWorld(worldId);
    if (this.settings.narrate) {
      // Narration owed from an interrupted step comes before the next speaker.
      const pending = await this.pendingNarration(worldId, state);
      if (pending.length > 0) {
        const narrated = await this.narrate(worldId, state, pending, budget);
        record(narrated);
        if (narrated.kind === "failed") return;
        state = await this.engine.getWorld(worldId);
      }
    }
    const actorId = await this.nextSpeaker(worldId, state);
    if (actorId === null) return;
    const turn = await this.characterTurn(worldId, state, actorId, budget);
    record(turn);
    if (turn.kind !== "turn" || !this.settings.narrate) return;
    const actions = turn.events.filter((event) => isNarratable(event.data.type));
    if (actions.length > 0) {
      record(await this.narrate(worldId, await this.engine.getWorld(worldId), actions, budget));
    }
  }

  private activeCharacters(state: WorldState) {
    return state.characters.filter((character) => character.hp > 0 && Object.hasOwn(this.cast.characters, character.id));
  }

  private async recentEvents(worldId: string, state: WorldState, count: number): Promise<AdventureEvent[]> {
    return this.engine.getEvents(worldId, Math.max(0, state.revision - count), count);
  }

  /** Round-robin in world order, after whoever took the last character turn. */
  private async nextSpeaker(worldId: string, state: WorldState): Promise<string | null> {
    const active = new Set(this.activeCharacters(state).map((character) => character.id));
    if (active.size === 0) return null;
    const recent = await this.recentEvents(worldId, state, 200);
    const last = recent.findLast((event) => event.source === "character");
    const order = state.characters.map((character) => character.id);
    const start = last && "actorId" in last.data ? order.indexOf(last.data.actorId) : -1;
    for (let offset = 1; offset <= order.length; offset += 1) {
      const candidate = order[(start + offset + order.length) % order.length]!;
      if (active.has(candidate)) return candidate;
    }
    return null;
  }

  /** Actions from the latest character turn that no narration covers yet. */
  private async pendingNarration(worldId: string, state: WorldState): Promise<AdventureEvent[]> {
    const recent = await this.recentEvents(worldId, state, 50);
    const lastTurn = recent.findLast((event) => event.source === "character");
    if (!lastTurn) return [];
    const narrated = new Set(recent.flatMap((event) => (
      event.data.type === "narration" ? event.data.aboutSequences : []
    )));
    return recent.filter((event) => (
      event.requestId === lastTurn.requestId && isNarratable(event.data.type) && !narrated.has(event.sequence)
    ));
  }

  /** True when the latest `stallTurns` character turns were all speech. */
  private async isStalled(worldId: string, state: WorldState): Promise<boolean> {
    if (this.settings.stallTurns <= 0) return false;
    const recent = await this.recentEvents(worldId, state, 500);
    let speechOnly = 0;
    let index = recent.length - 1;
    while (index >= 0) {
      const requestId = recent[index]!.requestId;
      if (recent[index]!.source !== "character") {
        index -= 1;
        continue;
      }
      let acted = false;
      while (index >= 0 && recent[index]!.requestId === requestId) {
        if (recent[index]!.data.type !== "utterance") acted = true;
        index -= 1;
      }
      if (acted) return false;
      speechOnly += 1;
      if (speechOnly >= this.settings.stallTurns) return true;
    }
    return false;
  }

  private async callModel(request: ModelRequest, budget: Budget): Promise<CallResult> {
    budget.beforeCall();
    const started = performance.now();
    try {
      const response = await this.provider.generate(request);
      budget.record(response.usage);
      return { ok: true, ...response, latencyMs: performance.now() - started };
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      budget.record(error.usage);
      return { ok: false, error, model: this.provider.modelFor(request.role), latencyMs: performance.now() - started };
    }
  }

  private async trace(entry: Omit<TraceInput, "provider" | "promptVersion">): Promise<void> {
    await this.engine.recordTrace({ ...entry, provider: this.provider.name, promptVersion: PROMPT_VERSION });
  }

  private async characterTurn(
    worldId: string,
    initial: WorldState,
    actorId: string,
    budget: Budget,
  ): Promise<StepOutcome> {
    const name = initial.characters.find((character) => character.id === actorId)!.name;
    const system = characterSystemPrompt(name, this.cast.characters[actorId]!);
    const maxAttempts = this.settings.maxRevisions + 1;
    const failed = (attempts: number, reason: string): StepOutcome => (
      { kind: "failed", role: "character", actorId, attempts, reason }
    );
    let state = initial;
    let feedback: string[] = [];
    let reason = "No valid turn within the revision limit";
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // Derived from revision and speaker: a duplicate runner cannot commit this turn twice.
      const turnId = `t${state.revision}-${actorId}`;
      const prompt = await buildCharacterPrompt(this.engine, worldId, state, actorId, this.settings.recentEvents, feedback);
      const call = await this.callModel(
        { role: "character", system, prompt, schema: characterTurnSchema, schemaName: "take_turn" },
        budget,
      );
      const base = {
        worldId, turnId, role: "character" as const, actorId, attempt,
        model: call.model, request: { system, prompt }, latencyMs: call.latencyMs,
      };
      if (!call.ok) {
        const message = `${call.error.kind}: ${call.error.message}`;
        await this.trace({
          ...base, response: call.error.raw ?? null, outcome: "provider_error", error: message, requestId: null,
          inputTokens: call.error.usage?.inputTokens ?? null, outputTokens: call.error.usage?.outputTokens ?? null,
        });
        return failed(attempt, message);
      }
      const usage = { response: call.raw, inputTokens: call.usage.inputTokens, outputTokens: call.usage.outputTokens };
      let command: Command;
      try {
        const parsed = characterTurnSchema.safeParse(call.output);
        if (!parsed.success) {
          throw new ProposalError(`Your reply did not match the turn format: ${oneLine(z.prettifyError(parsed.error))}`);
        }
        command = { role: "character", requestId: turnId, expectedRevision: state.revision, actorId, ...toTurnParts(parsed.data) };
      } catch (error) {
        if (!(error instanceof ProposalError)) throw error;
        reason = error.message;
        feedback = [error.message];
        await this.trace({ ...base, ...usage, outcome: "invalid_output", error: error.message, requestId: null });
        continue;
      }
      try {
        const result = await this.engine.execute(worldId, command);
        await this.trace({ ...base, ...usage, outcome: "committed", error: null, requestId: turnId });
        return { kind: "turn", actorId, events: result.events, attempts: attempt };
      } catch (error) {
        if (!(error instanceof EngineError)) throw error;
        await this.trace({
          ...base, ...usage, outcome: TRACE_OUTCOMES[error.code] ?? "error",
          error: `${error.code}: ${oneLine(error.message)}`, requestId: turnId,
        });
        switch (error.code) {
          case "INVALID_ACTION":
          case "INVALID_INPUT":
            reason = oneLine(error.message);
            feedback = [`The engine rejected your proposal: ${reason}`];
            break;
          case "STALE_REVISION":
            reason = "The world changed during every attempt";
            state = await this.engine.getWorld(worldId);
            feedback = [];
            if (!this.activeCharacters(state).some((character) => character.id === actorId)) {
              return failed(attempt, `${actorId} can no longer act`);
            }
            break;
          case "REQUEST_CONFLICT":
            return failed(attempt, "Another runner already committed this turn");
          default:
            throw error;
        }
      }
    }
    return failed(maxAttempts, reason);
  }

  private async narrate(
    worldId: string,
    initial: WorldState,
    about: AdventureEvent[],
    budget: Budget,
  ): Promise<StepOutcome> {
    const aboutSequences = about.map((event) => event.sequence);
    const requestId = `n${aboutSequences[0]}-${aboutSequences.at(-1)}`;
    const system = narratorSystemPrompt(this.cast.narratorStyle);
    const maxAttempts = this.settings.maxRevisions + 1;
    const failed = (attempts: number, reason: string): StepOutcome => (
      { kind: "failed", role: "dm", actorId: null, attempts, reason }
    );
    let state = initial;
    let feedback: string[] = [];
    let reason = "No valid narration within the revision limit";
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const prompt = await this.narrationPrompt(worldId, state, about, feedback);
      const call = await this.callModel(
        { role: "dm", system, prompt, schema: narrationSchema, schemaName: "narrate" },
        budget,
      );
      const base = {
        worldId, turnId: requestId, role: "dm" as const, actorId: null, attempt,
        model: call.model, request: { system, prompt }, latencyMs: call.latencyMs,
      };
      if (!call.ok) {
        const message = `${call.error.kind}: ${call.error.message}`;
        await this.trace({
          ...base, response: call.error.raw ?? null, outcome: "provider_error", error: message, requestId: null,
          inputTokens: call.error.usage?.inputTokens ?? null, outputTokens: call.error.usage?.outputTokens ?? null,
        });
        return failed(attempt, message);
      }
      const usage = { response: call.raw, inputTokens: call.usage.inputTokens, outputTokens: call.usage.outputTokens };
      const parsed = narrationSchema.safeParse(call.output);
      const text = parsed.success ? parsed.data.narration.trim() : "";
      if (!text || text.length > MAX_NARRATION_LENGTH) {
        reason = `Narration must be 1 to ${MAX_NARRATION_LENGTH} characters in the narration field`;
        feedback = [reason];
        await this.trace({ ...base, ...usage, outcome: "invalid_output", error: reason, requestId: null });
        continue;
      }
      try {
        const result = await this.engine.execute(worldId, {
          role: "dm", requestId, expectedRevision: state.revision,
          action: { type: "narrate", aboutSequences, text },
        });
        await this.trace({ ...base, ...usage, outcome: "committed", error: null, requestId });
        return { kind: "narration", events: result.events, attempts: attempt };
      } catch (error) {
        if (!(error instanceof EngineError)) throw error;
        await this.trace({
          ...base, ...usage, outcome: TRACE_OUTCOMES[error.code] ?? "error",
          error: `${error.code}: ${oneLine(error.message)}`, requestId,
        });
        switch (error.code) {
          case "INVALID_ACTION":
          case "INVALID_INPUT":
            reason = oneLine(error.message);
            feedback = [`The engine rejected your narration: ${reason}`];
            break;
          case "STALE_REVISION":
            reason = "The world changed during every attempt";
            state = await this.engine.getWorld(worldId);
            break;
          case "REQUEST_CONFLICT":
            return failed(attempt, "Another runner already narrated these events");
          default:
            throw error;
        }
      }
    }
    return failed(maxAttempts, reason);
  }

  /**
   * The narrator sees the outcome in full, but earlier events only if every
   * perceiver of the outcome also perceived them, so narration cannot leak
   * another scene to its audience.
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
      audience.map((characterId) => this.engine.getPerceivedEvents(worldId, characterId, 20)),
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
