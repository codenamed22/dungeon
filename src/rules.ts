import { randomInt } from "node:crypto";
import {
  BAND_DIFFICULTY,
  canonicalJson,
  difficultyBandSchema,
  EngineError,
  EVENT_FORMAT,
  MAX_GOALS,
  MAX_INTRODUCED_LENGTH,
  MAX_NARRATION_LENGTH,
  MAX_SPEECH_LENGTH,
  rulesOf,
  validateSeed,
  validateWorld,
  worldStateSchema,
} from "./model.ts";
import { survivesWipe } from "./wipes.ts";
import type {
  AdventureEvent,
  Character,
  CharacterAction,
  Challenge,
  CheckEffects,
  Command,
  Ending,
  EventData,
  EventSource,
  GoalInput,
  JudgmentInput,
  NoteInput,
  RulingInput,
  Threat,
  Threshold,
  Track,
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

type RulingData = Extract<EventData, { type: "ruling" }>;
/** Actions a character resolves without the DM; an attempt needs a ruling first. */
export type DirectAction = Exclude<CharacterAction, { type: "attempt" }>;

const NARRATABLE = new Set<EventData["type"]>([
  "character_moved",
  "travel_halted",
  "item_transferred",
  "check_resolved",
  "time_advanced",
  "ruling",
  "character_entered",
  "character_exited",
]);

/** Events nobody perceives: hidden consequences, the director's out-of-fiction steering, and wipes. */
const HIDDEN = new Set<EventData["type"]>(["threat_armed", "threat_disarmed", "steering", "wiped", "track_changed", "threshold_reached"]);
/** Someone coming into the scene or leaving it. */
const STAGING = new Set<EventData["type"]>(["character_entered", "character_exited"]);
/**
 * Zero-time parts of an outcome, which commit before any threat its duration
 * made due. The engine now appends an action's ending after those threats, but
 * replay still accepts the ending among these parts, as earlier versions recorded it.
 */
const OUTCOME_PARTS = new Set<EventData["type"]>([
  "discovery", "threat_armed", "threat_disarmed", "story_ended", "character_entered", "character_exited",
  "track_changed", "threshold_reached", "insight",
]);
/** What may still happen once the story has ended: words about what already happened, and a wipe back to before it. */
const AFTER_THE_END = new Set<EventData["type"]>(["narration", "retraction", "wiped"]);

/** Thoughts: a character's notes and goals, never a perception of the world. */
export const MENTAL_EVENTS: readonly EventData["type"][] = ["belief_noted", "goal_set"];
/** Events only their actor perceives: thoughts, and private discoveries. */
export const PRIVATE_EVENTS: readonly EventData["type"][] = [...MENTAL_EVENTS, "discovery", "insight"];

/** An earlier event a belief cites, and who perceived it. */
export interface Evidence {
  type: EventData["type"];
  actorId: string | undefined;
  perceivers: readonly string[];
}
export type EvidenceLookup = (sequence: number) => Evidence | undefined;
type NoteSource = Extract<EventData, { type: "belief_noted" }>["source"];

function invalid(message: string): never {
  throw new EngineError("INVALID_ACTION", message);
}

function corrupt(message: string): never {
  throw new EngineError("CORRUPT_STORAGE", message);
}

export function quantity(inventory: Record<string, number>, itemId: string): number {
  return Object.hasOwn(inventory, itemId) ? inventory[itemId] ?? 0 : 0;
}

/** Lines a retcon may change, with the most words each may have: words only, never a change to the world. */
const LINE_LIMITS: Partial<Record<EventData["type"], number>> = {
  narration: MAX_NARRATION_LENGTH,
  utterance: MAX_SPEECH_LENGTH,
  introduced: MAX_INTRODUCED_LENGTH,
};

/**
 * Why a retcon cannot change the target, or null if it can. A line may be
 * reworded again and again, until it is withdrawn. An introduced event that
 * changed routes may be reworded, but not withdrawn: branching undoes it.
 */
export function retractionProblem(
  target: AdventureEvent | undefined,
  options: {
    replacement?: string | undefined;
    text?: string | undefined;
    /** Whether a retcon already withdrew the target. */
    withdrawn: boolean;
    /** Whether a wipe took the target back. */
    wiped: boolean;
    /** For a goal change: whether a later change to the same goal stands. */
    laterChange: boolean;
  },
): string | null {
  if (!target) return "No such event";
  if (options.wiped) return "That line was wiped";
  const data = target.data;
  if (isMental(data.type)) {
    if (options.replacement !== undefined) return "Only narration, speech, and introduced events can be reworded";
    if (options.text !== undefined) return "A thought is deleted without a correction";
    if (options.withdrawn) return "That line was already withdrawn";
    if (options.laterChange) return "This goal changed later; delete that change first, or wipe from before it";
    return null;
  }
  const limit = LINE_LIMITS[data.type];
  if (limit === undefined) return "Only narration, speech, introduced events, notes, and goals can be retconned; wipe from before it to undo anything else";
  if (options.withdrawn) return "That line was already withdrawn";
  if (options.replacement === undefined && data.type === "introduced" && data.lockedRoutes.length + data.unlockedRoutes.length > 0) {
    return "This introduced event changed the world; wipe from before it to undo it";
  }
  if (options.replacement !== undefined && options.replacement.length > limit) return `The new words are longer than this line may be (${limit} characters)`;
  return null;
}

/**
 * Why the story can't be wiped from `from`, or null. `before` is the event
 * just before it: a wipe starts where a turn does, as a branch ends where one
 * does. `withinWipe` is whether an earlier wipe's range holds it, wiped or
 * outliving the wipe: going back to there would bring that wipe's lines back.
 */
export function wipeProblem(from: AdventureEvent | undefined, before: AdventureEvent | undefined, withinWipe: boolean): string | null {
  if (!from || from.sequence < 2) return "No such line";
  if (withinWipe) return "That line is within an earlier wipe; wipe from before it";
  if (from.data.type === "wiped") return "A wipe can't be wiped; branch from a wiped line to play it again";
  if (from.data.type === "retraction") return "An edit or deletion outlives a wipe; wipe from the line after it";
  if (before?.requestId === from.requestId) return `#${from.sequence} is in the middle of a turn; wipe from the turn's first line`;
  return null;
}

/** Takes back a goal change the director deleted: an adoption removes the goal, and a fulfilment or abandonment reopens it. */
function undoGoal(state: WorldState, data: Extract<EventData, { type: "goal_set" }>): void {
  const actor = storedActor(state, data.actorId);
  if (data.status === "adopted") {
    actor.goals = (actor.goals ?? []).filter((goal) => goal.id !== data.goalId);
    return;
  }
  const goal = actor.goals?.find((entry) => entry.id === data.goalId);
  if (goal?.status !== data.status) corrupt("A deleted goal change does not match the goal");
  goal.status = "adopted";
}

/** Who perceives a retcon: whoever perceived its target when it carries a correction, and nobody otherwise. */
export function retconAudience(data: { text?: string | undefined }, targetPerceivers: readonly string[]): readonly string[] {
  return data.text === undefined ? [] : targetPerceivers;
}

/** Actions that the DM may narrate; speech and narration are not narratable. */
export function isNarratable(type: EventData["type"]): boolean {
  return NARRATABLE.has(type);
}

export function isMental(type: EventData["type"]): boolean {
  return MENTAL_EVENTS.includes(type);
}

export function isPrivate(type: EventData["type"]): boolean {
  return PRIVATE_EVENTS.includes(type);
}

export function actorOf(data: EventData): string | undefined {
  return "actorId" in data ? data.actorId : undefined;
}

/**
 * Where a belief comes from, judged only from what it cites. Someone else's
 * words, the narrator's, or the referee's make it hearsay even beside firsthand
 * evidence, so a rumor cannot be laundered into an observation. Citing nothing,
 * or only one's own words, makes it speculation.
 */
function noteSource(actorId: string, evidence: readonly number[], lookup: EvidenceLookup): NoteSource | { problem: string } {
  let firsthand = false;
  let reported = false;
  for (const sequence of evidence) {
    const cited = lookup(sequence);
    if (!cited?.perceivers.includes(actorId)) return { problem: `${actorId} did not perceive event #${sequence}` };
    if (isMental(cited.type)) return { problem: `Event #${sequence} is a thought, not evidence` };
    if (cited.type === "narration" || cited.type === "ruling" || (cited.type === "utterance" && cited.actorId !== actorId)) {
      reported = true;
    } else if (cited.type !== "utterance") {
      firsthand = true;
    }
  }
  return reported ? "reported" : firsthand ? "inferred" : "speculation";
}

function noteEvent(actor: Character, note: NoteInput, lookup: EvidenceLookup): EventData {
  const evidence = [...new Set(note.evidence)].sort((a, b) => a - b);
  const source = noteSource(actor.id, evidence, lookup);
  if (typeof source !== "string") invalid(source.problem);
  return {
    type: "belief_noted",
    actorId: actor.id,
    about: note.about,
    attribute: note.attribute,
    value: note.value,
    evidence,
    confidence: note.confidence,
    source,
  };
}

function goalEvent(actor: Character, goal: GoalInput, sequence: number): EventData {
  const goals = actor.goals ?? [];
  if (goal.status === "adopted") {
    if (goals.length >= MAX_GOALS) invalid(`${actor.id} already has ${MAX_GOALS} goals`);
    return { type: "goal_set", actorId: actor.id, goalId: `goal-${sequence}`, kind: goal.kind, text: goal.text, status: "adopted" };
  }
  const open = goals.find((entry) => entry.id === goal.goalId && entry.status === "adopted");
  if (!open) invalid(`${goal.goalId} is not one of ${actor.id}'s open goals`);
  return { type: "goal_set", actorId: actor.id, goalId: open.id, kind: open.kind, text: open.text, status: goal.status };
}

export function successEffects(challenge: Challenge): CheckEffects {
  return structuredClone({
    unlockedRoutes: challenge.onSuccess?.unlockRoutes ?? [],
    grantedItems: challenge.onSuccess?.grantItems ?? [],
  });
}

const NO_EFFECTS: CheckEffects = { unlockedRoutes: [], grantedItems: [] };

export function failureEffects(challenge: Challenge): CheckEffects {
  const lockedRoutes = challenge.onFailure?.lockRoutes;
  return structuredClone({ ...NO_EFFECTS, ...(lockedRoutes ? { lockedRoutes } : {}) });
}

/** The armed threat due first, ties going to ID order. */
export function nextThreat(state: WorldState): Threat | undefined {
  let next: Threat | undefined;
  for (const threat of state.threats ?? []) {
    if (threat.status !== "armed") continue;
    if (!next || threat.at! < next.at! || (threat.at === next.at && threat.id < next.id)) next = threat;
  }
  return next;
}

/** The threat that fires partway through a task of `seconds` starting now, which stops travel and waiting. */
function interruption(state: WorldState, seconds: number): Threat | undefined {
  const next = nextThreat(state);
  return next && next.at! < state.elapsedSeconds + seconds ? next : undefined;
}

/** Whether a character is in the scene: away characters keep their last place but take no part. */
export function inScene(character: Character): boolean {
  return character.away !== true;
}

/** Conscious characters in the scene, in the given places or everywhere. */
function presentAt(state: WorldState, locationIds: readonly string[] | undefined): Character[] {
  return state.characters.filter((character) => (
    character.hp > 0 && inScene(character) && (locationIds === undefined || locationIds.includes(character.locationId))
  ));
}

function threatEvent(state: WorldState, threat: Threat): EventData {
  const damage = threat.damage ?? 0;
  return {
    type: "threat_triggered",
    threatId: threat.id,
    at: threat.at!,
    text: threat.text,
    ...(threat.locationIds ? { locationIds: [...threat.locationIds] } : {}),
    damage: damage === 0 ? [] : presentAt(state, threat.locationIds)
      .map((character) => ({ characterId: character.id, amount: Math.min(character.hp, damage) })),
    lockedRoutes: structuredClone(threat.lockRoutes ?? []),
    unlockedRoutes: structuredClone(threat.unlockRoutes ?? []),
  };
}

/** Hidden events setting threats in motion or stopping them, as a check's outcome dictates. */
function consequences(state: WorldState, challenge: Challenge, success: boolean): EventData[] {
  const threats = state.threats ?? [];
  const arm = (success ? challenge.onSuccess?.armThreats : challenge.onFailure?.armThreats) ?? [];
  const disarm = success ? challenge.onSuccess?.disarmThreats ?? [] : [];
  return [
    ...threats.filter((threat) => threat.status === "waiting" && arm.includes(threat.id)).map((threat): EventData => ({
      type: "threat_armed", threatId: threat.id, challengeId: challenge.id, at: state.elapsedSeconds + threat.delaySeconds!,
    })),
    ...threats.filter((threat) => (threat.status === "armed" || threat.status === "waiting") && disarm.includes(threat.id))
      .map((threat): EventData => ({ type: "threat_disarmed", threatId: threat.id, challengeId: challenge.id })),
  ];
}

/** The ending an outcome reaches, if any: the first listed. */
export function endingFor(
  state: WorldState,
  trigger: { challengeId: string; success: boolean } | { threatId: string } | { trackId: string; thresholdId: string },
): Ending | undefined {
  return state.endings?.find(({ when }) => {
    if ("threatId" in trigger) return "threatId" in when && when.threatId === trigger.threatId;
    if ("trackId" in trigger) return "trackId" in when && when.trackId === trigger.trackId && when.thresholdId === trigger.thresholdId;
    return "challengeId" in when && when.challengeId === trigger.challengeId && (when.outcome === "success") === trigger.success;
  });
}

const reachedKey = (characterId: string, trackId: string, thresholdId: string) => `${characterId}:${trackId}:${thresholdId}`;
const clampModifier = (value: number) => Math.min(20, Math.max(-10, value));
type ThresholdData = Extract<EventData, { type: "threshold_reached" }>;

/** What a character reaching a threshold does to the world, exactly as the track defines it and the world now stands. */
function thresholdEvent(state: WorldState, characterId: string, track: Track, threshold: Threshold): ThresholdData {
  const threats = state.threats ?? [];
  return {
    type: "threshold_reached",
    characterId,
    trackId: track.id,
    thresholdId: threshold.id,
    unlockedRoutes: structuredClone(threshold.unlockRoutes ?? []),
    lockedRoutes: structuredClone(threshold.lockRoutes ?? []),
    unlockedChallenges: state.challenges
      .filter((challenge) => challenge.locked === true && threshold.unlockChallenges?.includes(challenge.id) === true)
      .map((challenge) => challenge.id),
    armedThreats: threats
      .filter((threat) => threat.status === "waiting" && threshold.armThreats?.includes(threat.id) === true)
      .map((threat) => ({ threatId: threat.id, at: state.elapsedSeconds + threat.delaySeconds! })),
    disarmedThreats: threats
      .filter((threat) => (threat.status === "armed" || threat.status === "waiting") && threshold.disarmThreats?.includes(threat.id) === true)
      .map((threat) => threat.id),
    modifiers: structuredClone(threshold.adjustModifiers ?? []),
  };
}

export function isNpc(state: WorldState, characterId: string): boolean {
  return state.characters.find((character) => character.id === characterId)?.npc === true;
}

/** A conscious actor of the given kind: characters take turns, the DM voices NPCs. */
function activeActor(state: WorldState, actorId: string, kind: "character" | "npc" = "character"): Character {
  const actor = state.characters.find((character) => character.id === actorId);
  if (!actor) invalid(`Unknown actor: ${actorId}`);
  if ((actor.npc === true) !== (kind === "npc")) {
    invalid(kind === "npc" ? `${actor.id} is not an NPC` : `${actor.id} is an NPC, voiced by the DM`);
  }
  if (actor.hp === 0) invalid(`${actor.id} is incapacitated`);
  if (!inScene(actor)) invalid(`${actor.id} is away from the scene`);
  return actor;
}

/** Why the addressee cannot hear the speaker, or null if they can. */
function addresseeProblem(state: WorldState, speaker: Character, addresseeId: string): string | null {
  const addressee = state.characters.find((character) => character.id === addresseeId);
  if (
    !addressee || addressee.id === speaker.id || addressee.locationId !== speaker.locationId
    || addressee.hp === 0 || !inScene(addressee)
  ) {
    return `${addresseeId} is not here to hear ${speaker.id}`;
  }
  return null;
}

function utterance(state: WorldState, speaker: Character, text: string, addresseeId: string | undefined): EventData {
  if (addresseeId !== undefined) {
    const problem = addresseeProblem(state, speaker, addresseeId);
    if (problem) invalid(problem);
  }
  return {
    type: "utterance",
    actorId: speaker.id,
    locationId: speaker.locationId,
    text,
    seconds: state.speechSeconds,
    ...(addresseeId === undefined ? {} : { addresseeId }),
  };
}

function resolveMove(state: WorldState, actor: Character, destinationId: string): EventData {
  const location = state.locations.find((entry) => entry.id === actor.locationId);
  const route = location?.routes.find((entry) => entry.destinationId === destinationId);
  if (!route) invalid(`No route from ${actor.locationId} to ${destinationId}`);
  if (route.locked) invalid(`The way from ${actor.locationId} to ${destinationId} is blocked`);
  const threat = interruption(state, route.seconds);
  if (threat) {
    return {
      type: "travel_halted",
      actorId: actor.id,
      fromId: actor.locationId,
      destinationId,
      seconds: threat.at! - state.elapsedSeconds,
      threatId: threat.id,
    };
  }
  return {
    type: "character_moved",
    actorId: actor.id,
    fromId: actor.locationId,
    destinationId,
    seconds: route.seconds,
  };
}

const BANDS: readonly string[] = difficultyBandSchema.options;

/** Why a ruling breaks the world's rules, or null if it is valid. Used on commit and on replay. */
function rulingProblem(state: WorldState, actor: Character, data: RulingData): string | null {
  const limits = state.rulings;
  if (!limits) return "This world does not allow open-ended attempts";
  if (data.bringsIn !== undefined) {
    const arriving = state.characters.find((character) => character.id === data.bringsIn);
    if (!arriving || inScene(arriving)) return `${data.bringsIn} is not away from the scene, so nothing can bring them in`;
  }
  if (data.sendsOut !== undefined) {
    const leaving = state.characters.find((character) => character.id === data.sendsOut);
    if (!leaving || leaving.npc !== true || !inScene(leaving) || leaving.locationId !== actor.locationId) {
      return `${data.sendsOut} is not a supporting character here; only they can be sent away by an attempt`;
    }
  }
  switch (data.decision) {
    case "existing": {
      const challenge = state.challenges.find((entry) => entry.id === data.challengeId);
      if (data.challenge !== undefined || data.seconds !== undefined || data.bringsIn !== undefined || data.sendsOut !== undefined) {
        return "A ruling on an existing challenge defines nothing";
      }
      if (!challenge || challenge.locationId !== actor.locationId) return `There is no challenge ${data.challengeId} here`;
      return challenge.resolved ? `${challenge.id} is already resolved` : challenge.locked ? `${challenge.id} is not available yet` : null;
    }
    case "new": {
      const challenge = data.challenge;
      if (!challenge || data.challengeId !== challenge.id || data.seconds !== undefined) {
        return "A new check needs exactly one definition";
      }
      if (state.challenges.some((entry) => entry.id === challenge.id)) return `Challenge ID ${challenge.id} is taken`;
      if (
        challenge.locationId !== actor.locationId || challenge.resolved || challenge.description !== undefined
        || challenge.requiresItemId !== undefined || challenge.criteria !== undefined || challenge.onSuccess !== undefined
        || challenge.locked !== undefined || challenge.onFailure !== undefined
      ) {
        return "A ruled check takes place where the actor is, starts unresolved, and has no requirements or effects";
      }
      if (!limits.abilities.includes(challenge.ability)) return `Rulings in this world cannot test ${challenge.ability}`;
      const band = Object.entries(BAND_DIFFICULTY).find(([, difficulty]) => difficulty === challenge.difficulty)?.[0];
      if (band === undefined || BANDS.indexOf(band) > BANDS.indexOf(limits.maxDifficulty)) {
        return `Difficulty must be a band up to ${limits.maxDifficulty}`;
      }
      if (challenge.failureDamage > limits.maxFailureDamage) {
        return `Failure damage must be at most ${limits.maxFailureDamage}`;
      }
      return challenge.seconds > limits.maxSeconds ? `A ruled check takes at most ${limits.maxSeconds} seconds` : null;
    }
    case "automatic":
      if (data.seconds === undefined || data.challengeId !== undefined || data.challenge !== undefined) {
        return "An automatic ruling only takes time";
      }
      return data.seconds > limits.maxSeconds ? `A ruled action takes at most ${limits.maxSeconds} seconds` : null;
  }
}

/** The ruling event for an attempt. A new check's ID derives from the ruling's sequence. */
function rulingEvent(state: WorldState, actor: Character, intent: string, ruling: RulingInput, sequence: number): RulingData {
  const base = { type: "ruling" as const, actorId: actor.id, intent, reason: ruling.reason };
  const staging = ruling.decision === "existing" ? {} : {
    ...(ruling.bringsIn === undefined ? {} : { bringsIn: ruling.bringsIn }),
    ...(ruling.sendsOut === undefined ? {} : { sendsOut: ruling.sendsOut }),
  };
  let data: RulingData;
  switch (ruling.decision) {
    case "existing":
      data = { ...base, decision: "existing", challengeId: ruling.challengeId };
      break;
    case "new": {
      const challengeId = `ruled-${sequence}`;
      data = {
        ...base,
        ...staging,
        decision: "new",
        challengeId,
        challenge: {
          id: challengeId,
          name: ruling.name,
          locationId: actor.locationId,
          ability: ruling.ability,
          difficulty: BAND_DIFFICULTY[ruling.difficulty],
          seconds: ruling.seconds,
          failureDamage: ruling.failureDamage,
          resolved: false,
        },
      };
      break;
    }
    case "automatic":
      data = { ...base, ...staging, decision: "automatic", seconds: ruling.seconds };
      break;
  }
  const problem = rulingProblem(state, actor, data);
  if (problem) invalid(problem);
  return data;
}

/** Why the engine would refuse this ruling on an actor's attempt, or null if it would accept it. */
export function checkRuling(state: WorldState, actorId: string, intent: string, ruling: RulingInput): string | null {
  try {
    rulingEvent(state, activeActor(state, actorId), intent, ruling, state.revision + 1);
    return null;
  } catch (error) {
    if (error instanceof EngineError) return error.message;
    throw error;
  }
}

/**
 * The event for a direct action. A check is rolled in a dice world; in a
 * judgment world the referee's judgment decides it, and is required.
 */
/** The challenge the actor means to attempt, if they can attempt it now. */
function attemptable(state: WorldState, actor: Character, challengeId: string): Challenge {
  const challenge = state.challenges.find((entry) => entry.id === challengeId);
  if (!challenge) invalid(`Unknown challenge: ${challengeId}`);
  if (challenge.locationId !== actor.locationId) invalid("Challenge is not in this location");
  if (challenge.resolved) invalid("Challenge is already resolved");
  if (challenge.locked) invalid("Challenge is not available yet");
  if (challenge.requiresItemId !== undefined && quantity(actor.inventory, challenge.requiresItemId) === 0) {
    invalid(`${challenge.id} requires ${challenge.requiresItemId}, which ${actor.id} does not carry`);
  }
  return challenge;
}

/** Why the engine would refuse this actor's attempt at a challenge now, or null; checked before asking a referee to judge it. */
export function attemptProblem(state: WorldState, actorId: string, challengeId: string): string | null {
  try {
    attemptable(state, activeActor(state, actorId), challengeId);
    return null;
  } catch (error) {
    if (error instanceof EngineError) return error.message;
    throw error;
  }
}

export function resolveAction(
  state: WorldState,
  actorId: string,
  action: DirectAction,
  roll: Roll = d20,
  judgment?: JudgmentInput,
): EventData {
  const actor = activeActor(state, actorId);
  switch (action.type) {
    case "move":
      return resolveMove(state, actor, action.destinationId);
    case "transfer_item": {
      const recipient = state.characters.find((entry) => entry.id === action.recipientId);
      if (!recipient || recipient.id === actor.id) invalid("Choose a different, existing recipient");
      if (recipient.locationId !== actor.locationId || !inScene(recipient)) invalid("Recipient must be in the same location");
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
      const challenge = attemptable(state, actor, action.challengeId);
      let outcome: { success: boolean; roll?: number; modifier?: number; difficulty?: number; reason?: string };
      if (rulesOf(state).outcomes === "judgment") {
        if (!judgment) invalid("In this world the referee judges every attempt, so a check needs a judgment");
        outcome = { success: judgment.success, reason: judgment.reason };
      } else {
        if (judgment) invalid("This world rolls dice for checks, so it takes no judgment");
        const value = roll();
        if (!Number.isInteger(value) || value < 1 || value > 20) {
          throw new Error("The dice source must return an integer from 1 to 20");
        }
        const modifier = actor.modifiers[challenge.ability];
        outcome = { roll: value, modifier, difficulty: challenge.difficulty, success: value + modifier >= challenge.difficulty };
      }
      const success = outcome.success;
      const effects = success ? successEffects(challenge) : failureEffects(challenge);
      for (const grant of effects.grantedItems) {
        if (!Number.isSafeInteger(quantity(actor.inventory, grant.itemId) + grant.quantity)) {
          invalid("Inventory would overflow");
        }
      }
      return {
        type: "check_resolved",
        actorId: actor.id,
        challengeId: challenge.id,
        ...outcome,
        ...(action.approach === undefined ? {} : { approach: action.approach }),
        damage: success ? 0 : Math.min(actor.hp, challenge.failureDamage),
        seconds: challenge.seconds,
        effects,
      };
    }
    case "wait": {
      const threat = interruption(state, action.seconds);
      return threat
        ? { type: "time_advanced", actorId: actor.id, seconds: threat.at! - state.elapsedSeconds, interruptedBy: threat.id }
        : { type: "time_advanced", actorId: actor.id, seconds: action.seconds };
    }
  }
}

export function eventDuration(data: EventData): number {
  return "seconds" in data ? data.seconds ?? 0 : 0;
}

/**
 * Characters who perceive an event: conscious characters where it happens, plus
 * the actor. A move is seen at both ends. Narration reaches the perceivers of the
 * events it describes, and a retraction its audience (see retconAudience); the
 * caller supplies these.
 */
export function perceiversOf(
  before: WorldState | undefined,
  data: EventData,
  audience?: readonly string[],
): string[] {
  if (data.type === "world_created" || HIDDEN.has(data.type)) return [];
  if (data.type === "narration" || data.type === "retraction") {
    if (!audience) throw new Error(`${data.type} perceivers require the audience of the events it concerns`);
    return [...new Set(audience)].sort();
  }
  if (!before) corrupt("Event precedes world creation");
  if (data.type === "threat_triggered" || data.type === "introduced") {
    return presentAt(before, data.locationIds).map((character) => character.id).sort();
  }
  if (data.type === "story_ended") return presentAt(before, undefined).map((character) => character.id).sort();
  if (data.type === "character_entered" || data.type === "character_exited") {
    // Seen where it happens, by those there and by the one coming or going.
    const staged = before.characters.find((character) => character.id === data.characterId);
    if (!staged) corrupt(`Event stages an unknown character: ${data.characterId}`);
    const present = presentAt(before, [data.locationId]).map((character) => character.id);
    return [...new Set([...(staged.hp > 0 ? [staged.id] : []), ...present])].sort();
  }
  if (!("actorId" in data)) corrupt(`A ${data.type} event cannot be perceived`);
  if (isPrivate(data.type)) return [data.actorId];
  const actor = before.characters.find((character) => character.id === data.actorId);
  if (!actor) corrupt(`Event has an unknown actor: ${data.actorId}`);
  const locations = data.type === "character_moved" ? [data.fromId, data.destinationId] : [actor.locationId];
  const present = presentAt(before, locations).map((character) => character.id);
  return [...new Set([actor.id, ...present])].sort();
}

/** Resolves a validated command into the events it commits and the resulting state. */
export function resolveCommand(
  state: WorldState,
  command: Command,
  options: {
    roll: Roll;
    recordedAt: string;
    /** Who perceived the events a narration describes, or the event a retcon withdraws. */
    audience?: readonly string[];
    /** The event a retcon targets, which the caller checked with retractionProblem. */
    target?: AdventureEvent;
    /** Notes a deletion takes with it: those whose evidence is then all withdrawn. */
    alsoWithdraw?: readonly number[];
    /** The earlier events a note cites; a note may cite only events its writer perceived. */
    evidence?: EvidenceLookup;
  },
): { committed: CommittedEvent[]; state: WorldState } {
  if (state.endedWith !== undefined && command.role !== "dm" && !(command.role === "director" && ["retcon", "wipe"].includes(command.action.type))) {
    invalid("The story has ended. Branch the world from before the ending to play on");
  }
  const committed: CommittedEvent[] = [];
  let current = state;
  const append = (source: EventSource, data: EventData, audience = options.audience, target?: AdventureEvent) => {
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
    const perceivers = perceiversOf(current, data, audience);
    current = applyEvent(current, event, target);
    committed.push({ event, perceivers });
  };
  const done = () => ({ committed, state: current });
  const end = (ending: Ending | undefined) => {
    if (ending) append("engine", { type: "story_ended", endingId: ending.id });
  };
  /** The entrances and exits an outcome causes, skipping anyone already in or out of the scene. */
  const stage = (enters: readonly { characterId: string; locationId: string }[], exits: readonly string[]) => {
    for (const { characterId, locationId } of enters) {
      if (!inScene(current.characters.find((character) => character.id === characterId)!)) {
        append("engine", { type: "character_entered", characterId, locationId });
      }
    }
    for (const characterId of exits) {
      const leaving = current.characters.find((character) => character.id === characterId)!;
      if (inScene(leaving)) append("engine", { type: "character_exited", characterId, locationId: leaving.locationId });
    }
  };
  /**
   * Fires every threat the clock has reached, earliest first, until one ends
   * the story. A threat interrupts the turn: whatever the actor meant to do
   * next does not happen.
   */
  const fireDue = (): boolean => {
    let fired = false;
    for (
      let threat = nextThreat(current);
      threat && threat.at! <= current.elapsedSeconds && current.endedWith === undefined;
      threat = nextThreat(current)
    ) {
      append("engine", threatEvent(current, threat));
      stage(threat.enters ?? [], threat.exits ?? []);
      end(endingFor(current, { threatId: threat.id }));
      fired = true;
    }
    return fired;
  };
  /**
   * An action, then its outcome: what a successful check revealed to the actor
   * alone, and its consequences. Returns the ending the outcome reaches, which
   * the caller appends only after any threat that came due during the action,
   * since that threat happened first.
   */
  const act = (data: EventData): Ending | undefined => {
    append("character", data);
    if (data.type !== "check_resolved") return undefined;
    const challenge = current.challenges.find((entry) => entry.id === data.challengeId)!;
    const reveals = data.success ? challenge.onSuccess?.reveals : undefined;
    if (reveals !== undefined) {
      append("character", { type: "discovery", actorId: data.actorId, challengeId: data.challengeId, text: reveals });
    }
    for (const consequence of consequences(current, challenge, data.success)) append("engine", consequence);
    const reached = moveTracks(data, challenge);
    return endingFor(current, { challengeId: challenge.id, success: data.success }) ?? reached;
  };
  /**
   * A check's pull on the tracks it names, and whatever each threshold it
   * brings a character to then does. Returns the first ending a threshold reaches.
   */
  const moveTracks = (data: Extract<EventData, { type: "check_resolved" }>, challenge: Challenge): Ending | undefined => {
    let ending: Ending | undefined;
    for (const adjustment of (data.success ? challenge.onSuccess : challenge.onFailure)?.adjustTracks ?? []) {
      const subject = current.characters.find((entry) => entry.id === (adjustment.subjectId ?? data.actorId));
      const track = current.tracks?.find((entry) => entry.id === adjustment.trackId);
      const before = subject?.tracks?.[adjustment.trackId];
      if (!subject || !track || before === undefined) continue;
      const value = Math.min(track.max, Math.max(0, before + adjustment.delta));
      if (value === before) continue;
      append("engine", {
        type: "track_changed", characterId: subject.id, trackId: track.id, challengeId: challenge.id, delta: adjustment.delta, value,
      });
      for (const threshold of [...track.thresholds].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))) {
        if (value < threshold.at || current.reached?.includes(reachedKey(subject.id, track.id, threshold.id))) continue;
        append("engine", thresholdEvent(current, subject.id, track, threshold));
        if (threshold.reveals !== undefined && subject.hp > 0 && inScene(subject)) {
          append("engine", { type: "insight", actorId: subject.id, trackId: track.id, thresholdId: threshold.id, text: threshold.reveals });
        }
        ending ??= endingFor(current, { trackId: track.id, thresholdId: threshold.id });
      }
    }
    return ending;
  };
  if (command.role === "director") {
    const action = command.action;
    if (action.type === "steer") {
      const target = action.targetId;
      if (target !== undefined && !current.characters.some((character) => character.id === target)) {
        invalid(`Unknown character: ${target}`);
      }
      append("director", { type: "steering", text: action.text, ...(target === undefined ? {} : { targetId: target }) });
    } else if (action.type === "retcon") {
      // The caller checks the target with retractionProblem and supplies the audience.
      append("director", {
        type: "retraction",
        targetSequence: action.sequence,
        ...(action.text === undefined ? {} : { text: action.text }),
        ...(action.replacement === undefined ? {} : { replacement: action.replacement }),
      }, options.audience, options.target);
      for (const note of options.alsoWithdraw ?? []) append("director", { type: "retraction", targetSequence: note }, []);
    } else if (action.type === "wipe") {
      // A wipe needs the whole history, so the engine replays it (see Replayer).
      throw new Error("A wipe is resolved by replaying the world's history");
    } else if (action.type === "enter") {
      const arriving = current.characters.find((character) => character.id === action.characterId);
      if (!arriving) invalid(`Unknown character: ${action.characterId}`);
      if (inScene(arriving)) invalid(`${arriving.id} is already in the scene`);
      if (!current.locations.some((location) => location.id === action.locationId)) invalid(`Unknown location: ${action.locationId}`);
      append("director", {
        type: "character_entered",
        characterId: arriving.id,
        locationId: action.locationId,
        ...(action.text === undefined ? {} : { text: action.text }),
      });
    } else if (action.type === "exit") {
      const leaving = current.characters.find((character) => character.id === action.characterId);
      if (!leaving) invalid(`Unknown character: ${action.characterId}`);
      if (!inScene(leaving)) invalid(`${leaving.id} is already away from the scene`);
      append("director", {
        type: "character_exited",
        characterId: leaving.id,
        locationId: leaving.locationId,
        ...(action.text === undefined ? {} : { text: action.text }),
      });
    } else {
      const problem = introductionProblem(current, action.locationIds, action.lockRoutes ?? [], action.unlockRoutes ?? []);
      if (problem) invalid(problem);
      append("director", {
        type: "introduced",
        text: action.text,
        ...(action.locationIds ? { locationIds: [...action.locationIds] } : {}),
        lockedRoutes: structuredClone(action.lockRoutes ?? []),
        unlockedRoutes: structuredClone(action.unlockRoutes ?? []),
      });
    }
    return done();
  }
  if (command.role === "character") {
    const actor = activeActor(current, command.actorId);
    if (command.speech !== undefined) {
      append("character", utterance(current, actor, command.speech, command.addresseeId));
      if (fireDue()) return done();
    }
    // Thoughts commit before the action, while the actor is sure to be conscious.
    if (command.note !== undefined) {
      append("character", noteEvent(actor, command.note, options.evidence ?? (() => undefined)));
    }
    if (command.goal !== undefined) {
      append("character", goalEvent(actor, command.goal, current.revision + 1));
    }
    const action = command.action;
    let ending: Ending | undefined;
    if (action?.type === "attempt") {
      if (!command.ruling) invalid("An attempt needs the DM's ruling");
      // The ruling, and any check it defines, commits before the roll.
      const ruling = rulingEvent(current, actor, action.intent, command.ruling, current.revision + 1);
      if (ruling.challengeId === undefined && command.judgment !== undefined) invalid("An automatic success needs no judgment");
      append("dm", ruling);
      if (ruling.challengeId !== undefined) {
        ending = act(resolveAction(current, actor.id, { type: "attempt_check", challengeId: ruling.challengeId }, options.roll, command.judgment));
      }
      // Whoever the attempt brings in or sends away: always for an automatic one, and for a check only if it succeeded.
      const worked = current.challenges.find((entry) => entry.id === ruling.challengeId)?.resolved ?? true;
      if (worked) {
        stage(
          ruling.bringsIn === undefined ? [] : [{ characterId: ruling.bringsIn, locationId: actor.locationId }],
          ruling.sendsOut === undefined ? [] : [ruling.sendsOut],
        );
      }
    } else if (action !== undefined) {
      ending = act(resolveAction(current, actor.id, action, options.roll, command.judgment));
    }
    // A threat the action's duration made due happened before the action finished, so it fires first, and may end the story itself.
    fireDue();
    if (current.endedWith === undefined) end(ending);
  } else if (command.role === "npc") {
    const actor = activeActor(current, command.actorId, "npc");
    if (command.speech !== undefined) {
      append("dm", utterance(current, actor, command.speech, command.addresseeId));
      if (fireDue()) return done();
    }
    if (command.leave === true) {
      append("dm", { type: "character_exited", characterId: actor.id, locationId: actor.locationId });
    }
    if (command.destinationId !== undefined) {
      append("dm", resolveMove(current, actor, command.destinationId));
      fireDue();
    }
  } else {
    append("dm", {
      type: "narration",
      aboutSequences: command.action.aboutSequences,
      text: command.action.text,
    });
  }
  return done();
}

/** A stored event's actor: conscious, and an NPC only where NPCs may act. */
function storedActor(state: WorldState, actorId: string, npcAllowed = false): Character {
  const actor = state.characters.find((entry) => entry.id === actorId);
  if (!actor || actor.hp === 0 || !inScene(actor)) corrupt("Event has an invalid, incapacitated, or absent actor");
  if (actor.npc === true && !npcAllowed) corrupt(`NPC ${actor.id} cannot take this action`);
  return actor;
}

/**
 * The DM narrates, rules, and voices NPCs; the engine fires and arms threats; the
 * director steers; characters do everything else.
 */
function expectedSources(state: WorldState, data: Exclude<EventData, { type: "world_created" }>): readonly EventSource[] {
  switch (data.type) {
    // The director stages anyone; the engine stages whoever a threat or a ruling names; an NPC may leave on its own turn.
    case "character_entered":
      return ["director", "engine"];
    case "character_exited":
      return isNpc(state, data.characterId) ? ["director", "engine", "dm"] : ["director", "engine"];
    default:
      return [expectedSource(state, data)];
  }
}

function expectedSource(
  state: WorldState,
  data: Exclude<EventData, { type: "world_created" | "character_entered" | "character_exited" }>,
): EventSource {
  switch (data.type) {
    case "narration":
    case "ruling":
      return "dm";
    case "threat_triggered":
    case "threat_armed":
    case "threat_disarmed":
    case "story_ended":
    case "track_changed":
    case "threshold_reached":
    case "insight":
      return "engine";
    case "steering":
    case "introduced":
    case "retraction":
    case "wiped":
      return "director";
    case "utterance":
    case "character_moved":
    case "travel_halted":
      return isNpc(state, data.actorId) ? "dm" : "character";
    default:
      return "character";
  }
}

function storedThreat(state: WorldState, threatId: string): Threat {
  const threat = state.threats?.find((entry) => entry.id === threatId);
  if (!threat) corrupt(`Unknown threat: ${threatId}`);
  return threat;
}

type RouteRef = { fromId: string; destinationId: string };

/** Why an introduced event cannot happen as described, or null if it can. */
function introductionProblem(
  state: WorldState,
  locationIds: readonly string[] | undefined,
  locks: readonly RouteRef[],
  unlocks: readonly RouteRef[],
): string | null {
  const unknown = locationIds?.find((locationId) => !state.locations.some((location) => location.id === locationId));
  if (unknown !== undefined) return `Unknown location: ${unknown}`;
  const key = (ref: RouteRef) => `${ref.fromId}>${ref.destinationId}`;
  for (const ref of [...locks, ...unlocks]) {
    const route = state.locations.find((location) => location.id === ref.fromId)
      ?.routes.find((entry) => entry.destinationId === ref.destinationId);
    if (!route) return `No route from ${ref.fromId} to ${ref.destinationId}`;
  }
  const keys = [...locks, ...unlocks].map(key);
  if (new Set(keys).size !== keys.length) return "A route can be blocked or opened only once per event";
  return null;
}

function setRoutes(state: WorldState, refs: readonly RouteRef[], locked: boolean): void {
  for (const ref of refs) {
    const route = state.locations.find((entry) => entry.id === ref.fromId)
      ?.routes.find((entry) => entry.destinationId === ref.destinationId);
    if (!route) corrupt("Event changes an unknown route");
    route.locked = locked;
  }
}

/** Applies one event to the state. A retraction of a goal change needs its `target`, which it takes back. */
export function applyEvent(previous: WorldState | undefined, event: AdventureEvent, target?: AdventureEvent): WorldState {
  const data = event.data;
  if (data.type === "world_created") {
    if (
      previous || event.sequence !== 1 || event.elapsedSeconds !== 0
      || data.seed.id !== event.worldId || event.source !== "director"
    ) {
      corrupt("Invalid world creation event");
    }
    validateSeed(data.seed);
    return worldStateSchema.parse({
      ...structuredClone(data.seed),
      revision: 1,
      elapsedSeconds: 0,
    });
  }
  if (!previous || previous.id !== event.worldId || event.sequence !== previous.revision + 1) {
    corrupt("Event history is out of sequence");
  }
  const sources = expectedSources(previous, data);
  if (!sources.includes(event.source)) corrupt(`This ${data.type} event must come from the ${sources.join(" or ")}`);
  if (previous.endedWith !== undefined && !AFTER_THE_END.has(data.type)) corrupt("Nothing happens after the story ends");
  // Once the story has ended, the clock stops: threats still due never fire.
  // A wipe can take the clock back to where a threat is due; the next turn fires it.
  const due = previous.endedWith === undefined ? nextThreat(previous) : undefined;
  if (due && due.at! <= previous.elapsedSeconds && data.type !== "threat_triggered" && data.type !== "wiped" && !OUTCOME_PARTS.has(data.type)) {
    corrupt(`Threat ${due.id} was due and had to fire first`);
  }
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
      const actor = storedActor(state, data.actorId, true);
      if (actor.locationId !== data.locationId || data.seconds !== state.speechSeconds) {
        corrupt("Utterance does not match its speaker or the world's speech time");
      }
      if (data.addresseeId !== undefined && addresseeProblem(state, actor, data.addresseeId) !== null) {
        corrupt("Utterance is addressed to someone who could not hear it");
      }
      break;
    }
    case "ruling": {
      const problem = rulingProblem(state, storedActor(state, data.actorId), data);
      if (problem) corrupt(`Ruling breaks the world's limits: ${problem}`);
      if (data.challenge) state.challenges.push(structuredClone(data.challenge));
      break;
    }
    case "character_moved": {
      const actor = storedActor(state, data.actorId, true);
      const location = state.locations.find((entry) => entry.id === actor.locationId);
      const route = location?.routes.find((entry) => entry.destinationId === data.destinationId);
      if (actor.locationId !== data.fromId || !route || route.locked || route.seconds !== data.seconds) {
        corrupt("Movement event does not match an open route");
      }
      if (interruption(state, data.seconds)) corrupt("Travel cannot pass a threat");
      actor.locationId = data.destinationId;
      break;
    }
    case "travel_halted": {
      const actor = storedActor(state, data.actorId, true);
      const location = state.locations.find((entry) => entry.id === actor.locationId);
      const route = location?.routes.find((entry) => entry.destinationId === data.destinationId);
      const next = nextThreat(state);
      if (
        actor.locationId !== data.fromId || !route || route.locked || data.seconds >= route.seconds
        || next?.id !== data.threatId || next.at !== state.elapsedSeconds + data.seconds
      ) {
        corrupt("Halted travel does not match an open route and the next threat");
      }
      break;
    }
    case "item_transferred": {
      const actor = storedActor(state, data.actorId);
      const recipient = state.characters.find((entry) => entry.id === data.recipientId);
      const owned = quantity(actor.inventory, data.itemId);
      if (
        !recipient || recipient.id === actor.id || recipient.locationId !== actor.locationId || !inScene(recipient)
        || owned < data.quantity
      ) {
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
      // A judged outcome is recorded with its reason and no dice; a rolled one must add up.
      const outcomeFits = challenge !== undefined && (rulesOf(state).outcomes === "judgment"
        ? data.reason !== undefined && data.roll === undefined && data.modifier === undefined && data.difficulty === undefined
        : data.reason === undefined && data.roll !== undefined && data.difficulty === challenge.difficulty
          && data.modifier === actor.modifiers[challenge.ability] && data.success === (data.roll + data.modifier >= challenge.difficulty));
      if (
        !challenge || challenge.resolved || challenge.locked || challenge.locationId !== actor.locationId
        || (challenge.requiresItemId !== undefined && quantity(actor.inventory, challenge.requiresItemId) === 0)
        || !outcomeFits
        || data.seconds !== challenge.seconds
        || data.damage !== (data.success ? 0 : Math.min(actor.hp, challenge.failureDamage))
        || canonicalJson(data.effects) !== canonicalJson(data.success ? successEffects(challenge) : failureEffects(challenge))
      ) {
        corrupt("Check outcome contradicts the world rules");
      }
      actor.hp -= data.damage;
      challenge.resolved = data.success;
      setRoutes(state, data.effects.unlockedRoutes, false);
      setRoutes(state, data.effects.lockedRoutes ?? [], true);
      for (const grant of data.effects.grantedItems) {
        actor.inventory[grant.itemId] = quantity(actor.inventory, grant.itemId) + grant.quantity;
      }
      break;
    }
    case "time_advanced": {
      storedActor(state, data.actorId);
      const next = nextThreat(state);
      if (data.interruptedBy === undefined ? interruption(state, data.seconds) !== undefined
        : next?.id !== data.interruptedBy || next.at !== state.elapsedSeconds + data.seconds) {
        corrupt("A wait must stop exactly at the next threat, and only there");
      }
      break;
    }
    case "threat_triggered": {
      const threat = storedThreat(state, data.threatId);
      if (nextThreat(state)?.id !== threat.id || threat.at! > state.elapsedSeconds
        || canonicalJson(data) !== canonicalJson(threatEvent(state, threat))) {
        corrupt("Threat event contradicts the world rules");
      }
      for (const { characterId, amount } of data.damage) {
        state.characters.find((character) => character.id === characterId)!.hp -= amount;
      }
      setRoutes(state, data.lockedRoutes, true);
      setRoutes(state, data.unlockedRoutes, false);
      threat.status = "fired";
      break;
    }
    case "threat_armed": {
      const threat = storedThreat(state, data.threatId);
      if (threat.status !== "waiting" || data.at !== state.elapsedSeconds + threat.delaySeconds!) {
        corrupt("Only a waiting threat can be armed, for its delay");
      }
      threat.status = "armed";
      threat.at = data.at;
      break;
    }
    case "threat_disarmed": {
      const threat = storedThreat(state, data.threatId);
      if (threat.status !== "armed" && threat.status !== "waiting") corrupt("Only a pending threat can be disarmed");
      threat.status = "disarmed";
      break;
    }
    case "story_ended": {
      const ending = state.endings?.find((entry) => entry.id === data.endingId);
      if (!ending) corrupt(`Unknown ending: ${data.endingId}`);
      const { when } = ending;
      if ("threatId" in when && state.threats?.find((threat) => threat.id === when.threatId)?.status !== "fired") {
        corrupt("An ending on a threat comes only once the threat has happened");
      }
      if ("trackId" in when && !state.reached?.some((key) => key.endsWith(`:${when.trackId}:${when.thresholdId}`))) {
        corrupt("An ending on a threshold comes only once someone has reached it");
      }
      state.endedWith = ending.id;
      break;
    }
    case "track_changed": {
      const subject = state.characters.find((entry) => entry.id === data.characterId);
      const track = state.tracks?.find((entry) => entry.id === data.trackId);
      const before = subject?.tracks?.[data.trackId];
      if (
        !subject || !track || before === undefined || !state.challenges.some((entry) => entry.id === data.challengeId)
        || data.delta === 0 || data.value === before || data.value !== Math.min(track.max, Math.max(0, before + data.delta))
      ) {
        corrupt("Track change contradicts the world rules");
      }
      subject.tracks![data.trackId] = data.value;
      break;
    }
    case "threshold_reached": {
      const subject = state.characters.find((entry) => entry.id === data.characterId);
      const track = state.tracks?.find((entry) => entry.id === data.trackId);
      const threshold = track?.thresholds.find((entry) => entry.id === data.thresholdId);
      const key = reachedKey(data.characterId, data.trackId, data.thresholdId);
      if (
        !subject || !track || !threshold || (subject.tracks?.[track.id] ?? 0) < threshold.at || state.reached?.includes(key)
        || canonicalJson(data) !== canonicalJson(thresholdEvent(state, subject.id, track, threshold))
      ) {
        corrupt("Threshold event contradicts the world rules");
      }
      setRoutes(state, data.unlockedRoutes, false);
      setRoutes(state, data.lockedRoutes, true);
      for (const challenge of state.challenges) if (data.unlockedChallenges.includes(challenge.id)) delete challenge.locked;
      for (const { threatId, at } of data.armedThreats) {
        const threat = storedThreat(state, threatId);
        threat.status = "armed";
        threat.at = at;
      }
      for (const threatId of data.disarmedThreats) storedThreat(state, threatId).status = "disarmed";
      for (const { ability, delta } of data.modifiers) subject.modifiers[ability] = clampModifier(subject.modifiers[ability] + delta);
      state.reached = [...state.reached ?? [], key];
      break;
    }
    case "insight": {
      storedActor(state, data.actorId);
      const threshold = state.tracks?.find((entry) => entry.id === data.trackId)?.thresholds.find((entry) => entry.id === data.thresholdId);
      if (!state.reached?.includes(reachedKey(data.actorId, data.trackId, data.thresholdId)) || threshold?.reveals !== data.text) {
        corrupt("Insight does not match a threshold its holder reached");
      }
      break;
    }
    case "character_entered": {
      const arriving = state.characters.find((character) => character.id === data.characterId);
      if (!arriving || inScene(arriving) || !state.locations.some((location) => location.id === data.locationId)) {
        corrupt("Only someone away from the scene can enter it, at a known place");
      }
      delete arriving.away;
      arriving.locationId = data.locationId;
      break;
    }
    case "character_exited": {
      const leaving = state.characters.find((character) => character.id === data.characterId);
      if (!leaving || !inScene(leaving) || leaving.locationId !== data.locationId) {
        corrupt("Only someone in the scene can leave it, from where they are");
      }
      leaving.away = true;
      break;
    }
    case "steering":
      if (data.targetId !== undefined && !state.characters.some((character) => character.id === data.targetId)) {
        corrupt("Steering targets an unknown character");
      }
      break;
    case "retraction":
      if (data.targetSequence < 2 || data.targetSequence >= event.sequence) corrupt("A retcon must withdraw an earlier event");
      if (target !== undefined && target.sequence !== data.targetSequence) corrupt("A retcon's target does not match");
      if (target?.data.type === "goal_set") undoGoal(state, target.data);
      break;
    case "wiped":
      // The Replayer takes the state back before applying the wipe itself.
      if (data.fromSequence < 2 || data.fromSequence >= event.sequence) corrupt("A wipe must start at an earlier event");
      break;
    case "introduced": {
      const problem = introductionProblem(state, data.locationIds, data.lockedRoutes, data.unlockedRoutes);
      if (problem) corrupt(`Introduced event is impossible: ${problem}`);
      setRoutes(state, data.lockedRoutes, true);
      setRoutes(state, data.unlockedRoutes, false);
      break;
    }
    case "discovery": {
      storedActor(state, data.actorId);
      const challenge = state.challenges.find((entry) => entry.id === data.challengeId);
      if (!challenge?.resolved || challenge.onSuccess?.reveals !== data.text) {
        corrupt("Discovery does not match a solved challenge");
      }
      break;
    }
    case "belief_noted": {
      storedActor(state, data.actorId);
      const evidence = data.evidence;
      if (evidence.some((sequence, index) => (
        sequence < 2 || sequence >= event.sequence || (index > 0 && sequence <= evidence[index - 1]!)
      ))) {
        corrupt("A belief must cite earlier events in ascending order");
      }
      if (evidence.length === 0 && data.source !== "speculation") corrupt("A belief without evidence is speculation");
      break;
    }
    case "goal_set": {
      const actor = storedActor(state, data.actorId);
      const goals = actor.goals ?? [];
      if (data.status === "adopted") {
        if (data.goalId !== `goal-${event.sequence}`) corrupt("A new goal's ID must come from its event");
        actor.goals = [...goals, { id: data.goalId, kind: data.kind, text: data.text, status: "adopted" }];
      } else {
        const goal = goals.find((entry) => entry.id === data.goalId);
        if (goal?.status !== "adopted" || goal.kind !== data.kind || goal.text !== data.text) {
          corrupt("Goal update does not match an open goal");
        }
        goal.status = data.status;
      }
      break;
    }
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
/** What a wipe leaves: the world, its withdrawn lines and last check, and the events it takes back. */
interface Rewound {
  state: WorldState;
  withdrawn: Set<number>;
  lastCheck: AdventureEvent | undefined;
  wiped: number[];
}

export class Replayer {
  state: WorldState | undefined;
  /** Every event so far, wiped ones included. */
  private readonly history = new Map<number, { event: AdventureEvent; perceivers: string[] }>();
  private lastCheck: AdventureEvent | undefined;
  /** Lines a retcon withdrew, which nothing may change again. */
  private withdrawn = new Set<number>();
  /** Events a wipe took back, which nothing may refer to again. */
  private readonly wiped = new Set<number>();
  /** Each wipe's range, from its first event to the wipe itself. */
  private readonly wipes: { from: number; at: number }[] = [];

  apply(event: AdventureEvent): string[] {
    const data = event.data;
    let audience: string[] | undefined;
    let target: AdventureEvent | undefined;
    if (data.type === "narration") {
      audience = [];
      for (const sequence of data.aboutSequences) {
        const about = this.live(sequence);
        if (!about || !isNarratable(about.event.data.type)) corrupt("Narration references an event that cannot be narrated");
        audience.push(...about.perceivers);
      }
    }
    if (data.type === "retraction") {
      const entry = this.history.get(data.targetSequence);
      const problem = retractionProblem(entry?.event, {
        replacement: data.replacement,
        text: data.text,
        withdrawn: this.withdrawn.has(data.targetSequence),
        wiped: this.wiped.has(data.targetSequence),
        laterChange: entry !== undefined && this.changedLater(entry.event),
      });
      if (problem) corrupt(`Invalid retcon: ${problem}`);
      audience = [...retconAudience(data, entry!.perceivers)];
      target = entry!.event;
    }
    let rewound: Rewound | undefined;
    if (data.type === "wiped") {
      const from = data.fromSequence;
      const within = this.wipes.some((wipe) => wipe.from <= from && from < wipe.at);
      const problem = wipeProblem(this.history.get(from)?.event, this.history.get(from - 1)?.event, within);
      if (problem) corrupt(`Invalid wipe: ${problem}`);
      rewound = this.rewound(from);
    }
    if (data.type === "discovery") {
      const check = this.history.get(event.sequence - 1)?.event;
      if (
        check?.requestId !== event.requestId || check.data.type !== "check_resolved" || !check.data.success
        || check.data.actorId !== data.actorId || check.data.challengeId !== data.challengeId
      ) {
        corrupt("A discovery must follow its finder's successful check");
      }
    }
    if (data.type === "belief_noted" && noteSource(data.actorId, data.evidence, (sequence) => this.evidence(sequence)) !== data.source) {
      corrupt("A belief's source does not match what its holder perceived");
    }
    if (data.type === "threat_armed" || data.type === "threat_disarmed") {
      const check = this.lastCheck;
      const challenge = this.state?.challenges.find((entry) => entry.id === data.challengeId);
      const success = check?.data.type === "check_resolved" && check.data.success;
      const listed = data.type === "threat_disarmed"
        ? (success ? challenge?.onSuccess?.disarmThreats : undefined)
        : (success ? challenge?.onSuccess?.armThreats : challenge?.onFailure?.armThreats);
      if (
        check?.requestId !== event.requestId || check.data.type !== "check_resolved"
        || check.data.challengeId !== data.challengeId || !listed?.includes(data.threatId)
      ) {
        corrupt("A consequence must follow the check that caused it");
      }
    }
    if (STAGING.has(data.type) && event.source !== "director" && !this.staged(event)) {
      corrupt("An entrance or exit must follow the threat, ruling, or words that caused it");
    }
    if (data.type === "track_changed") {
      const check = this.lastCheck;
      const outcome = check?.data.type === "check_resolved" ? check.data : undefined;
      const challenge = this.state?.challenges.find((entry) => entry.id === data.challengeId);
      const listed = outcome && (outcome.success ? challenge?.onSuccess : challenge?.onFailure)?.adjustTracks;
      // Each change the outcome lists happens at most once: a value already at its end skips one.
      const allowed = listed?.filter((entry) => (
        entry.trackId === data.trackId && entry.delta === data.delta && (entry.subjectId ?? outcome!.actorId) === data.characterId
      )).length ?? 0;
      const made = this.requestBefore(event).filter((other) => other.data.type === "track_changed" && other.data.trackId === data.trackId
        && other.data.delta === data.delta && other.data.characterId === data.characterId).length;
      if (!outcome || check?.requestId !== event.requestId || outcome.challengeId !== data.challengeId || made >= allowed) {
        corrupt("A track change must follow the check that caused it");
      }
    }
    if (data.type === "threshold_reached") {
      const { characterId, trackId } = data;
      const caused = this.requestBefore(event).some((other) => other.data.type === "track_changed"
        && other.data.characterId === characterId && other.data.trackId === trackId);
      if (!caused) corrupt("A threshold must follow the track change that reached it");
    }
    if (data.type === "insight") {
      const last = this.requestBefore(event).at(-1)?.data;
      if (last?.type !== "threshold_reached" || last.characterId !== data.actorId || last.trackId !== data.trackId || last.thresholdId !== data.thresholdId) {
        corrupt("An insight must follow the threshold that taught it");
      }
    }
    if (data.type === "story_ended") {
      const when = this.state?.endings?.find((entry) => entry.id === data.endingId)?.when;
      const previous = this.causeOf(event);
      const check = this.lastCheck;
      let caused = false;
      if (when !== undefined && "threatId" in when) {
        caused = previous?.requestId === event.requestId && previous.data.type === "threat_triggered" && previous.data.threatId === when.threatId;
      } else if (when !== undefined && "trackId" in when) {
        caused = this.requestBefore(event).some((other) => other.data.type === "threshold_reached"
          && other.data.trackId === when.trackId && other.data.thresholdId === when.thresholdId);
      } else if (when !== undefined) {
        caused = check?.requestId === event.requestId && check.data.type === "check_resolved"
          && check.data.challengeId === when.challengeId && check.data.success === (when.outcome === "success");
      }
      if (!caused) corrupt("An ending must follow the outcome that reaches it");
    }
    // A wipe applies to the world as it was before its first event; nothing changes until the wipe itself checks out.
    const before = rewound ? { ...rewound.state, revision: event.sequence - 1 } : this.state;
    const perceivers = perceiversOf(before, data, audience);
    this.state = applyEvent(before, event, target);
    this.history.set(event.sequence, { event, perceivers });
    if (rewound && data.type === "wiped") {
      this.withdrawn = rewound.withdrawn;
      this.lastCheck = rewound.lastCheck;
      for (const sequence of rewound.wiped) this.wiped.add(sequence);
      this.wipes.push({ from: data.fromSequence, at: event.sequence });
    }
    if (data.type === "check_resolved") this.lastCheck = event;
    if (data.type === "retraction" && data.replacement === undefined) this.withdrawn.add(data.targetSequence);
    return perceivers;
  }

  /** An event that may still be referred to: not wiped. */
  private live(sequence: number): { event: AdventureEvent; perceivers: string[] } | undefined {
    return this.wiped.has(sequence) ? undefined : this.history.get(sequence);
  }

  /** For a goal change: whether a later change to the same goal stands. */
  private changedLater(target: AdventureEvent): boolean {
    if (target.data.type !== "goal_set") return false;
    const { goalId } = target.data;
    for (const { event } of this.history.values()) {
      if (event.sequence > target.sequence && event.data.type === "goal_set" && event.data.goalId === goalId
        && !this.wiped.has(event.sequence) && !this.withdrawn.has(event.sequence)) return true;
    }
    return false;
  }

  /**
   * The world as a wipe from `from` leaves it: the history before it replayed
   * afresh, then the edits and deletions made since to lines before it, which
   * outlive the wipe. Everything else since is wiped.
   */
  private rewound(from: number): Rewound {
    const fresh = new Replayer();
    const wiped: number[] = [];
    for (const { event } of this.history.values()) if (event.sequence < from) fresh.apply(event);
    for (const { event } of this.history.values()) {
      if (event.sequence < from || this.wiped.has(event.sequence)) continue;
      if (!survivesWipe(event.data, from)) {
        wiped.push(event.sequence);
        continue;
      }
      // An edit changes nothing here; a deletion withdraws its line, and a deleted goal change is taken back again.
      const data = event.data as Extract<EventData, { type: "retraction" }>;
      if (data.replacement === undefined) fresh.withdrawn.add(data.targetSequence);
      const goal = this.history.get(data.targetSequence)!.event.data;
      if (goal.type === "goal_set") {
        fresh.state = structuredClone(fresh.state!);
        undoGoal(fresh.state, goal);
      }
    }
    return { state: fresh.state!, withdrawn: fresh.withdrawn, lastCheck: fresh.lastCheck, wiped };
  }

  /** The events of this event's request before it, oldest first. */
  private requestBefore(event: AdventureEvent): AdventureEvent[] {
    const earlier: AdventureEvent[] = [];
    for (let sequence = event.sequence - 1; sequence > 1; sequence--) {
      const previous = this.history.get(sequence)?.event;
      if (previous?.requestId !== event.requestId) break;
      earlier.unshift(previous);
    }
    return earlier;
  }

  /** The event before this one in its request, past any entrances and exits the engine staged in between. */
  private causeOf(event: AdventureEvent): AdventureEvent | undefined {
    let sequence = event.sequence - 1;
    let previous = this.history.get(sequence)?.event;
    while (previous?.requestId === event.requestId && previous.source === "engine" && STAGING.has(previous.data.type)) {
      previous = this.history.get(--sequence)?.event;
    }
    return previous?.requestId === event.requestId ? previous : undefined;
  }

  /**
   * Whether an entrance or exit the engine or DM recorded has its cause: a threat
   * or ruling that names it, or an NPC's own words just before it leaves.
   */
  private staged(event: AdventureEvent): boolean {
    const data = event.data;
    if (data.type !== "character_entered" && data.type !== "character_exited") return false;
    if (event.source === "dm") {
      const words = this.history.get(event.sequence - 1)?.event;
      return data.type === "character_exited" && words?.requestId === event.requestId
        && words.data.type === "utterance" && words.data.actorId === data.characterId;
    }
    const cause = this.causeOf(event);
    if (cause?.data.type === "threat_triggered") {
      const threatId = cause.data.threatId;
      const threat = this.state?.threats?.find((entry) => entry.id === threatId);
      return data.type === "character_entered"
        ? threat?.enters?.some((entry) => entry.characterId === data.characterId && entry.locationId === data.locationId) === true
        : threat?.exits?.includes(data.characterId) === true;
    }
    // A ruling stages someone straight after an automatic success, or after the successful check it defined.
    let ruling = cause;
    if (cause?.data.type === "check_resolved") {
      const before = this.history.get(cause.sequence - 1)?.event;
      ruling = cause.data.success && before?.requestId === event.requestId && before.data.type === "ruling"
        && before.data.decision === "new" && before.data.challengeId === cause.data.challengeId ? before : undefined;
    } else if (cause?.data.type === "ruling" && cause.data.decision !== "automatic") {
      ruling = undefined;
    }
    if (ruling?.data.type !== "ruling") return false;
    const rulingData = ruling.data;
    const actor = this.state?.characters.find((character) => character.id === rulingData.actorId);
    return data.type === "character_entered"
      ? rulingData.bringsIn === data.characterId && actor?.locationId === data.locationId
      : rulingData.sendsOut === data.characterId;
  }

  /** A replayed event as a belief may cite it. */
  evidence(sequence: number): Evidence | undefined {
    const entry = this.live(sequence);
    return entry && { type: entry.event.data.type, actorId: actorOf(entry.event.data), perceivers: entry.perceivers };
  }
}
