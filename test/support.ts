import { commandSchema, EngineError, EVENT_FORMAT, parseInput } from "../src/model.ts";
import type { AdventureEvent, EventData, WorldSeed, WorldState } from "../src/model.ts";
import { applyEvent, resolveCommand } from "../src/rules.ts";
import type { Roll } from "../src/rules.ts";

export const NOW = "2026-10-28T12:00:00.000Z";

export function errorCode(code: EngineError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof EngineError && error.code === code;
}

export function fixed(value: number): Roll {
  return () => value;
}

export function creationEvent(seed: WorldSeed): AdventureEvent {
  return {
    v: EVENT_FORMAT, worldId: seed.id, sequence: 1, requestId: "world-created", source: "director",
    recordedAt: NOW, elapsedSeconds: 0, data: { type: "world_created", seed },
  };
}

export function initialState(seed: WorldSeed): WorldState {
  return applyEvent(undefined, creationEvent(seed));
}

/** Resolves a character turn without storage. `input` defaults to Mira at the current revision. */
export function commitTurn(state: WorldState, input: Record<string, unknown>, roll: Roll = fixed(10)) {
  const command = parseInput(commandSchema, {
    role: "character", requestId: "turn", expectedRevision: state.revision, actorId: "mira", ...input,
  });
  return resolveCommand(state, command, { roll, recordedAt: NOW });
}

/** A hand-built next event, for testing what replay accepts. */
export function nextEvent(state: WorldState, data: EventData, overrides: Partial<AdventureEvent> = {}): AdventureEvent {
  return {
    v: EVENT_FORMAT, worldId: state.id, sequence: state.revision + 1, requestId: "forged",
    source: data.type === "narration" ? "dm" : "character", recordedAt: NOW,
    elapsedSeconds: state.elapsedSeconds + ("seconds" in data ? data.seconds : 0),
    data, ...overrides,
  };
}

/** The sample world as Phase 1 stored it: minutes instead of seconds, no speech time. */
export const PHASE1_SEED = {
  id: "ridge-adventure",
  name: "The Gate and the Ridge",
  locations: [
    { id: "gate", name: "Outer Gate", routes: [{ destinationId: "ridge", minutes: 5 }] },
    { id: "ridge", name: "Windy Ridge", routes: [{ destinationId: "gate", minutes: 5 }] },
  ],
  items: [{ id: "rope", name: "Rope" }, { id: "torch", name: "Torch" }],
  characters: [
    {
      id: "mira", name: "Mira", locationId: "gate", hp: 10, maxHp: 10,
      modifiers: { strength: 0, dexterity: 3, wisdom: 1 }, inventory: { rope: 1 },
    },
    {
      id: "bram", name: "Bram", locationId: "gate", hp: 14, maxHp: 14,
      modifiers: { strength: 3, dexterity: 0, wisdom: 1 }, inventory: { torch: 2 },
    },
    {
      id: "elowen", name: "Elowen", locationId: "ridge", hp: 8, maxHp: 8,
      modifiers: { strength: -1, dexterity: 1, wisdom: 3 }, inventory: {},
    },
  ],
  challenges: [
    {
      id: "gate-trap", name: "Disarm the gate trap", locationId: "gate",
      ability: "dexterity", difficulty: 13, minutes: 2, failureDamage: 3, resolved: false,
    },
    {
      id: "scout-aqueduct", name: "Locate the aqueduct entrance", locationId: "ridge",
      ability: "wisdom", difficulty: 12, minutes: 3, failureDamage: 0, resolved: false,
    },
  ],
};

/** A short Phase 1 history: transfer, failed check, move, wait. */
export function phase1Events(worldId = PHASE1_SEED.id) {
  const event = (sequence: number, requestId: string, elapsedMinutes: number, data: Record<string, unknown>) => ({
    worldId, sequence, requestId, recordedAt: NOW, elapsedMinutes, data,
  });
  return [
    event(1, "world-created", 0, { type: "world_created", seed: { ...PHASE1_SEED, id: worldId } }),
    event(2, "give", 0, { type: "item_transferred", actorId: "mira", recipientId: "bram", itemId: "rope", quantity: 1 }),
    event(3, "trap", 2, {
      type: "check_resolved", actorId: "mira", challengeId: "gate-trap",
      roll: 4, modifier: 3, difficulty: 13, success: false, damage: 3, minutes: 2,
    }),
    event(4, "walk", 7, { type: "character_moved", actorId: "mira", fromId: "gate", destinationId: "ridge", minutes: 5 }),
    event(5, "rest", 8, { type: "time_advanced", actorId: "elowen", minutes: 1 }),
  ];
}
