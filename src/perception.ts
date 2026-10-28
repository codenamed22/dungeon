import { EngineError, MAX_WAIT_SECONDS } from "./model.ts";
import type { Ability, Character, WorldState } from "./model.ts";
import { quantity } from "./rules.ts";

export type Condition = "unhurt" | "wounded" | "badly wounded" | "incapacitated";
export type DifficultyBand = "easy" | "moderate" | "hard" | "very hard";

/**
 * Everything one character can currently perceive. Other characters appear only
 * by name and visible condition; difficulty appears only as a band.
 */
export interface Perception {
  characterId: string;
  name: string;
  hp: number;
  maxHp: number;
  condition: Condition;
  modifiers: Character["modifiers"];
  inventory: { id: string; name: string; quantity: number }[];
  location: { id: string; name: string; description: string | null };
  exits: { id: string; name: string; seconds: number; blocked: boolean }[];
  present: { id: string; name: string; condition: Condition }[];
  challenges: {
    id: string;
    name: string;
    description: string | null;
    ability: Ability;
    difficulty: DifficultyBand;
    dangerous: boolean;
    requires: { id: string; name: string; carried: boolean } | null;
    resolved: boolean;
  }[];
  elapsedSeconds: number;
}

/** The legal targets for each action type, given the character's situation. */
export interface AvailableActions {
  move: string[];
  transfer: { recipients: string[]; items: { id: string; quantity: number }[] };
  attempt: string[];
  maxWaitMinutes: number;
}

export function conditionOf(hp: number, maxHp: number): Condition {
  if (hp === 0) return "incapacitated";
  if (hp === maxHp) return "unhurt";
  return hp * 2 > maxHp ? "wounded" : "badly wounded";
}

export function difficultyBand(difficulty: number): DifficultyBand {
  if (difficulty <= 10) return "easy";
  if (difficulty <= 15) return "moderate";
  if (difficulty <= 20) return "hard";
  return "very hard";
}

function character(state: WorldState, characterId: string): Character {
  const found = state.characters.find((entry) => entry.id === characterId);
  if (!found) throw new EngineError("NOT_FOUND", `Unknown character: ${characterId}`);
  return found;
}

function nameOf(entities: { id: string; name: string }[], entityId: string): string {
  return entities.find((entity) => entity.id === entityId)?.name ?? entityId;
}

export function perceive(state: WorldState, characterId: string): Perception {
  const self = character(state, characterId);
  const location = state.locations.find((entry) => entry.id === self.locationId)!;
  return {
    characterId: self.id,
    name: self.name,
    hp: self.hp,
    maxHp: self.maxHp,
    condition: conditionOf(self.hp, self.maxHp),
    modifiers: { ...self.modifiers },
    inventory: Object.entries(self.inventory).map(([itemId, count]) => ({
      id: itemId,
      name: nameOf(state.items, itemId),
      quantity: count,
    })),
    location: { id: location.id, name: location.name, description: location.description ?? null },
    exits: location.routes.map((route) => ({
      id: route.destinationId,
      name: nameOf(state.locations, route.destinationId),
      seconds: route.seconds,
      blocked: route.locked === true,
    })),
    present: state.characters
      .filter((other) => other.id !== self.id && other.locationId === self.locationId)
      .map((other) => ({ id: other.id, name: other.name, condition: conditionOf(other.hp, other.maxHp) })),
    challenges: state.challenges
      .filter((challenge) => challenge.locationId === self.locationId)
      .map((challenge) => ({
        id: challenge.id,
        name: challenge.name,
        description: challenge.description ?? null,
        ability: challenge.ability,
        difficulty: difficultyBand(challenge.difficulty),
        dangerous: challenge.failureDamage > 0,
        requires: challenge.requiresItemId === undefined ? null : {
          id: challenge.requiresItemId,
          name: nameOf(state.items, challenge.requiresItemId),
          carried: quantity(self.inventory, challenge.requiresItemId) > 0,
        },
        resolved: challenge.resolved,
      })),
    elapsedSeconds: state.elapsedSeconds,
  };
}

/** Targets the engine would currently accept; an incapacitated character has none. */
export function availableActions(state: WorldState, characterId: string): AvailableActions {
  const self = character(state, characterId);
  if (self.hp === 0) return { move: [], transfer: { recipients: [], items: [] }, attempt: [], maxWaitMinutes: 0 };
  const location = state.locations.find((entry) => entry.id === self.locationId)!;
  return {
    move: location.routes.filter((route) => !route.locked).map((route) => route.destinationId),
    transfer: {
      recipients: state.characters
        .filter((other) => other.id !== self.id && other.locationId === self.locationId)
        .map((other) => other.id),
      items: Object.entries(self.inventory).map(([itemId, count]) => ({ id: itemId, quantity: count })),
    },
    attempt: state.challenges
      .filter((challenge) => (
        challenge.locationId === self.locationId && !challenge.resolved
        && (challenge.requiresItemId === undefined || quantity(self.inventory, challenge.requiresItemId) > 0)
      ))
      .map((challenge) => challenge.id),
    maxWaitMinutes: MAX_WAIT_SECONDS / 60,
  };
}
