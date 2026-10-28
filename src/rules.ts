import { randomInt } from "node:crypto";
import {
  canonicalJson,
  EngineError,
  EVENT_FORMAT,
  validateWorld,
  worldStateSchema,
} from "./model.ts";
import type {
  AdventureEvent,
  CharacterAction,
  Challenge,
  CheckEffects,
  Command,
  EventData,
  EventSource,
  WorldState,
} from "./model.ts";

/** Returns an integer from 1 to 20. Injected so tests and scripted runs can fix outcomes. */
export type Roll = () => number;
export const d20: Roll = () => randomInt(1, 21);

export interface CommittedEvent {
  event: AdventureEvent;
  /** Characters who perceived the event, sorted. */
  perceivers: string[];
}

const NARRATABLE = new Set<EventData["type"]>([
  "character_moved",
  "item_transferred",
  "check_resolved",
  "time_advanced",
]);

function invalid(message: string): never {
  throw new EngineError("INVALID_ACTION", message);
}

function corrupt(message: string): never {
  throw new EngineError("CORRUPT_STORAGE", message);
}

export function quantity(inventory: Record<string, number>, itemId: string): number {
  return Object.hasOwn(inventory, itemId) ? inventory[itemId] ?? 0 : 0;
}

/** Character actions that the DM may narrate; speech and narration are not narratable. */
export function isNarratable(type: EventData["type"]): boolean {
  return NARRATABLE.has(type);
}

export function successEffects(challenge: Challenge): CheckEffects {
  return structuredClone({
    unlockedRoutes: challenge.onSuccess?.unlockRoutes ?? [],
    grantedItems: challenge.onSuccess?.grantItems ?? [],
  });
}

const NO_EFFECTS: CheckEffects = { unlockedRoutes: [], grantedItems: [] };

function activeActor(state: WorldState, actorId: string) {
  const actor = state.characters.find((character) => character.id === actorId);
  if (!actor) invalid(`Unknown actor: ${actorId}`);
  if (actor.hp === 0) invalid(`${actor.id} is incapacitated`);
  return actor;
}

export function resolveAction(
  state: WorldState,
  actorId: string,
  action: CharacterAction,
  roll: Roll = d20,
): EventData {
  const actor = activeActor(state, actorId);
  switch (action.type) {
    case "move": {
      const location = state.locations.find((entry) => entry.id === actor.locationId);
      const route = location?.routes.find((entry) => entry.destinationId === action.destinationId);
      if (!route) invalid(`No route from ${actor.locationId} to ${action.destinationId}`);
      if (route.locked) invalid(`The way from ${actor.locationId} to ${action.destinationId} is blocked`);
      return {
        type: "character_moved",
        actorId: actor.id,
        fromId: actor.locationId,
        destinationId: action.destinationId,
        seconds: route.seconds,
      };
    }
    case "transfer_item": {
      const recipient = state.characters.find((entry) => entry.id === action.recipientId);
      if (!recipient || recipient.id === actor.id) invalid("Choose a different, existing recipient");
      if (recipient.locationId !== actor.locationId) invalid("Recipient must be in the same location");
      if (quantity(actor.inventory, action.itemId) < action.quantity) {
        invalid(`Insufficient inventory: ${action.itemId}`);
      }
      if (!Number.isSafeInteger(quantity(recipient.inventory, action.itemId) + action.quantity)) {
        invalid("Recipient inventory would overflow");
      }
      return {
        type: "item_transferred",
        actorId: actor.id,
        recipientId: recipient.id,
        itemId: action.itemId,
        quantity: action.quantity,
      };
    }
    case "attempt_check": {
      const challenge = state.challenges.find((entry) => entry.id === action.challengeId);
      if (!challenge) invalid(`Unknown challenge: ${action.challengeId}`);
      if (challenge.locationId !== actor.locationId) invalid("Challenge is not in this location");
      if (challenge.resolved) invalid("Challenge is already resolved");
      if (challenge.requiresItemId !== undefined && quantity(actor.inventory, challenge.requiresItemId) === 0) {
        invalid(`${challenge.id} requires ${challenge.requiresItemId}, which ${actor.id} does not carry`);
      }
      const value = roll();
      if (!Number.isInteger(value) || value < 1 || value > 20) {
        throw new Error("The dice source must return an integer from 1 to 20");
      }
      const modifier = actor.modifiers[challenge.ability];
      const success = value + modifier >= challenge.difficulty;
      const effects = success ? successEffects(challenge) : structuredClone(NO_EFFECTS);
      for (const grant of effects.grantedItems) {
        if (!Number.isSafeInteger(quantity(actor.inventory, grant.itemId) + grant.quantity)) {
          invalid("Inventory would overflow");
        }
      }
      return {
        type: "check_resolved",
        actorId: actor.id,
        challengeId: challenge.id,
        roll: value,
        modifier,
        difficulty: challenge.difficulty,
        success,
        damage: success ? 0 : Math.min(actor.hp, challenge.failureDamage),
        seconds: challenge.seconds,
        effects,
      };
    }
    case "wait":
      return { type: "time_advanced", actorId: actor.id, seconds: action.seconds };
  }
}

export function eventDuration(data: EventData): number {
  return "seconds" in data ? data.seconds : 0;
}

/**
 * Characters who perceive an event: conscious characters where it happens, plus
 * the actor. A move is seen at both ends. Narration reaches the perceivers of the
 * events it describes, which the caller supplies.
 */
export function perceiversOf(
  before: WorldState | undefined,
  data: EventData,
  narrationAudience?: readonly string[],
): string[] {
  if (data.type === "world_created") return [];
  if (data.type === "narration") {
    if (!narrationAudience) throw new Error("Narration perceivers require the narrated events' audience");
    return [...new Set(narrationAudience)].sort();
  }
  if (!before) corrupt("Event precedes world creation");
  const actor = before.characters.find((character) => character.id === data.actorId);
  if (!actor) corrupt(`Event has an unknown actor: ${data.actorId}`);
  const locations = data.type === "character_moved" ? [data.fromId, data.destinationId] : [actor.locationId];
  const present = before.characters
    .filter((character) => character.hp > 0 && locations.includes(character.locationId))
    .map((character) => character.id);
  return [...new Set([actor.id, ...present])].sort();
}

/** Resolves a validated command into the events it commits and the resulting state. */
export function resolveCommand(
  state: WorldState,
  command: Command,
  options: { roll: Roll; recordedAt: string; narrationAudience?: readonly string[] },
): { committed: CommittedEvent[]; state: WorldState } {
  const committed: CommittedEvent[] = [];
  let current = state;
  const append = (source: EventSource, data: EventData) => {
    const event: AdventureEvent = {
      v: EVENT_FORMAT,
      worldId: current.id,
      sequence: current.revision + 1,
      requestId: command.requestId,
      source,
      recordedAt: options.recordedAt,
      elapsedSeconds: current.elapsedSeconds + eventDuration(data),
      data,
    };
    const perceivers = perceiversOf(current, data, options.narrationAudience);
    current = applyEvent(current, event);
    committed.push({ event, perceivers });
  };
  if (command.role === "character") {
    const actor = activeActor(current, command.actorId);
    if (command.speech !== undefined) {
      append("character", {
        type: "utterance",
        actorId: actor.id,
        locationId: actor.locationId,
        text: command.speech,
        seconds: current.speechSeconds,
      });
    }
    if (command.action !== undefined) {
      append("character", resolveAction(current, actor.id, command.action, options.roll));
    }
  } else {
    append("dm", {
      type: "narration",
      aboutSequences: command.action.aboutSequences,
      text: command.action.text,
    });
  }
  return { committed, state: current };
}

function storedActor(state: WorldState, actorId: string) {
  const actor = state.characters.find((entry) => entry.id === actorId);
  if (!actor || actor.hp === 0) corrupt("Event has an invalid or incapacitated actor");
  return actor;
}

export function applyEvent(previous: WorldState | undefined, event: AdventureEvent): WorldState {
  const data = event.data;
  if (data.type === "world_created") {
    if (
      previous || event.sequence !== 1 || event.elapsedSeconds !== 0
      || data.seed.id !== event.worldId || event.source !== "director"
    ) {
      corrupt("Invalid world creation event");
    }
    validateWorld(data.seed);
    return worldStateSchema.parse({
      ...structuredClone(data.seed),
      revision: 1,
      elapsedSeconds: 0,
    });
  }
  if (!previous || previous.id !== event.worldId || event.sequence !== previous.revision + 1) {
    corrupt("Event history is out of sequence");
  }
  const expectedSource = data.type === "narration" ? "dm" : "character";
  if (event.source !== expectedSource) corrupt(`${data.type} events must come from the ${expectedSource}`);
  const state = structuredClone(previous);
  switch (data.type) {
    case "narration": {
      const sequences = data.aboutSequences;
      if (sequences.some((sequence, index) => (
        sequence < 2 || sequence >= event.sequence || (index > 0 && sequence <= sequences[index - 1]!)
      ))) {
        corrupt("Narration must reference earlier events in ascending order");
      }
      break;
    }
    case "utterance": {
      const actor = storedActor(state, data.actorId);
      if (actor.locationId !== data.locationId || data.seconds !== state.speechSeconds) {
        corrupt("Utterance does not match its speaker or the world's speech time");
      }
      break;
    }
    case "character_moved": {
      const actor = storedActor(state, data.actorId);
      const location = state.locations.find((entry) => entry.id === actor.locationId);
      const route = location?.routes.find((entry) => entry.destinationId === data.destinationId);
      if (actor.locationId !== data.fromId || !route || route.locked || route.seconds !== data.seconds) {
        corrupt("Movement event does not match an open route");
      }
      actor.locationId = data.destinationId;
      break;
    }
    case "item_transferred": {
      const actor = storedActor(state, data.actorId);
      const recipient = state.characters.find((entry) => entry.id === data.recipientId);
      const owned = quantity(actor.inventory, data.itemId);
      if (!recipient || recipient.id === actor.id || recipient.locationId !== actor.locationId || owned < data.quantity) {
        corrupt("Invalid inventory transfer event");
      }
      if (owned === data.quantity) delete actor.inventory[data.itemId];
      else actor.inventory[data.itemId] = owned - data.quantity;
      recipient.inventory[data.itemId] = quantity(recipient.inventory, data.itemId) + data.quantity;
      break;
    }
    case "check_resolved": {
      const actor = storedActor(state, data.actorId);
      const challenge = state.challenges.find((entry) => entry.id === data.challengeId);
      if (
        !challenge || challenge.resolved || challenge.locationId !== actor.locationId
        || (challenge.requiresItemId !== undefined && quantity(actor.inventory, challenge.requiresItemId) === 0)
        || data.modifier !== actor.modifiers[challenge.ability]
        || data.difficulty !== challenge.difficulty
        || data.seconds !== challenge.seconds
        || data.success !== (data.roll + data.modifier >= challenge.difficulty)
        || data.damage !== (data.success ? 0 : Math.min(actor.hp, challenge.failureDamage))
        || canonicalJson(data.effects) !== canonicalJson(data.success ? successEffects(challenge) : NO_EFFECTS)
      ) {
        corrupt("Check outcome contradicts the world rules");
      }
      actor.hp -= data.damage;
      challenge.resolved = data.success;
      for (const ref of data.effects.unlockedRoutes) {
        const route = state.locations.find((entry) => entry.id === ref.fromId)
          ?.routes.find((entry) => entry.destinationId === ref.destinationId);
        if (!route) corrupt("Check unlocks an unknown route");
        route.locked = false;
      }
      for (const grant of data.effects.grantedItems) {
        actor.inventory[grant.itemId] = quantity(actor.inventory, grant.itemId) + grant.quantity;
      }
      break;
    }
    case "time_advanced":
      storedActor(state, data.actorId);
      break;
  }
  const elapsedSeconds = state.elapsedSeconds + eventDuration(data);
  if (!Number.isSafeInteger(elapsedSeconds) || event.elapsedSeconds !== elapsedSeconds) {
    corrupt("Invalid in-world clock");
  }
  state.elapsedSeconds = elapsedSeconds;
  state.revision = event.sequence;
  const parsed = worldStateSchema.safeParse(state);
  if (!parsed.success) corrupt(parsed.error.message);
  validateWorld(parsed.data);
  return parsed.data;
}

/** Rebuilds state and perceivers from an ordered event history, validating every step. */
export class Replayer {
  state: WorldState | undefined;
  private readonly history = new Map<number, { type: EventData["type"]; perceivers: string[] }>();

  apply(event: AdventureEvent): string[] {
    let audience: string[] | undefined;
    if (event.data.type === "narration") {
      audience = [];
      for (const sequence of event.data.aboutSequences) {
        const target = this.history.get(sequence);
        if (!target || !isNarratable(target.type)) corrupt("Narration references an event that cannot be narrated");
        audience.push(...target.perceivers);
      }
    }
    const perceivers = perceiversOf(this.state, event.data, audience);
    this.state = applyEvent(this.state, event);
    this.history.set(event.sequence, { type: event.data.type, perceivers });
    return perceivers;
  }
}
