import { randomUUID } from "node:crypto";
import type { AdventureEngine, TurnResult } from "../engine.ts";
import { BELIEF_EVENTS, beliefsOf } from "../memory.ts";
import type { Belief } from "../memory.ts";
import { EngineError } from "../model.ts";
import type { AdventureEvent, Command, Goal, WorldState } from "../model.ts";
import { describeEvent, entityName } from "./context.ts";
import { characterSystemPrompt, frameOf, npcSystemPrompt } from "./prompts.ts";
import type { Cast } from "./prompts.ts";
import { buildCharacterPrompt, buildNpcPrompt, DEFAULT_RUNNER_SETTINGS, directionFor } from "./runner.ts";
import { pacePolicy } from "./schedule.ts";

// Director inspection: what an agent is sent, and what a character remembers.
// Shared by the command-line director and the web director.

function requireCharacter(state: WorldState, characterId: string) {
  const character = state.characters.find((entry) => entry.id === characterId);
  if (!character) throw new EngineError("NOT_FOUND", `Unknown character: ${characterId}`);
  return character;
}

export interface AgentPrompts {
  npc: boolean;
  /** Null when the character has no persona, so no agent plays it. */
  system: string | null;
  /** The turn prompt it would get now; for an NPC, the one it gets when spoken to. */
  prompt: string;
}

/** Exactly what a character's or NPC's agent would be sent if it acted now. */
export async function agentPrompts(
  engine: AdventureEngine,
  worldId: string,
  state: WorldState,
  cast: Cast,
  characterId: string,
): Promise<AgentPrompts> {
  const character = requireCharacter(state, characterId);
  const settings = pacePolicy(cast.pace, DEFAULT_RUNNER_SETTINGS);
  const frame = frameOf(cast, state);
  const direction = await directionFor(engine, worldId, state, characterId, settings);
  if (character.npc) {
    const persona = cast.npcs?.[characterId];
    return {
      npc: true,
      system: persona ? npcSystemPrompt(character.name, persona, frame) : null,
      prompt: await buildNpcPrompt(engine, worldId, state, characterId, settings, [], "addressed", direction.steering),
    };
  }
  const persona = cast.characters[characterId];
  return {
    npc: false,
    system: persona ? characterSystemPrompt(character.name, persona, frame) : null,
    prompt: await buildCharacterPrompt(engine, worldId, state, characterId, settings, [], direction),
  };
}

export interface RememberedLine {
  sequence: number;
  line: string;
}

export interface MemoryReport {
  goals: Goal[];
  /** Newest first; `earlier` lists only the superseded beliefs whose value or source differed, newest first. */
  beliefs: { about: string; aboutName: string | null; attribute: string; current: Belief; earlier: Belief[] }[];
  discoveries: RememberedLine[];
  /** Present when a search was asked for: matches best first, with snippets marked «like this». */
  matches?: (RememberedLine & { snippet: string | null })[];
}

/** A character's personal memory: goals, beliefs with their history, discoveries, and optionally a scoped search. */
export async function memoryReport(
  engine: AdventureEngine,
  worldId: string,
  state: WorldState,
  characterId: string,
  search?: string,
): Promise<MemoryReport> {
  const character = requireCharacter(state, characterId);
  const perceived = await engine.getPerceivedEvents(worldId, characterId, 1000, { types: BELIEF_EVENTS });
  const beliefs = beliefsOf(characterId, perceived, state).map((topic) => {
    const earlier: Belief[] = [];
    let newer = topic.current;
    for (const older of topic.history.slice(0, -1).reverse()) {
      if (older.value === newer.value && older.source === newer.source) continue;
      earlier.push(older);
      newer = older;
    }
    return { about: topic.about, aboutName: entityName(state, topic.about), attribute: topic.attribute, current: topic.current, earlier };
  });
  const line = (event: AdventureEvent) => ({
    sequence: event.sequence, line: describeEvent(event, state, characterId),
  });
  const discoveries = (await engine.getPerceivedEvents(worldId, characterId, 1000, { types: ["discovery"] })).map(line);
  const report: MemoryReport = { goals: character.goals ?? [], beliefs, discoveries };
  if (search !== undefined) {
    report.matches = (await engine.searchMemories(worldId, characterId, search))
      .map((match) => ({ ...line(match.event), snippet: match.snippet }));
  }
  return report;
}

type DirectorAction = Extract<Command, { role: "director" }>["action"];

/** Commits a director command at the current revision, retrying if a running scheduler commits first. */
export async function direct(engine: AdventureEngine, worldId: string, action: DirectorAction): Promise<TurnResult> {
  const requestId = `${action.type}-${randomUUID()}`;
  for (let attempt = 1; ; attempt += 1) {
    const state = await engine.getWorld(worldId);
    try {
      return await engine.execute(worldId, { role: "director", requestId, expectedRevision: state.revision, action });
    } catch (error) {
      if (!(error instanceof EngineError && error.code === "STALE_REVISION") || attempt >= 5) throw error;
    }
  }
}
