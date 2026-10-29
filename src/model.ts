import { z } from "zod";

/**
 * Format of newly written events. Older events are upcast on read (see upcast.ts).
 * Additions that leave existing events valid, such as new event types or optional
 * fields, keep the format.
 */
export const EVENT_FORMAT = 2;
export const MAX_WAIT_SECONDS = 3600;
export const MAX_SPEECH_LENGTH = 700;
export const MAX_NARRATION_LENGTH = 1000;
export const MAX_INTENT_LENGTH = 200;
export const MAX_REASON_LENGTH = 300;
export const MAX_NOTE_LENGTH = 200;
export const MAX_GOAL_LENGTH = 200;
export const MAX_DISCOVERY_LENGTH = 500;
/** Events one belief may cite as its evidence. */
export const MAX_EVIDENCE = 5;
/** Goals and commitments one character may hold, open or settled. */
export const MAX_GOALS = 100;
export const MAX_THREAT_LENGTH = 500;
export const MAX_STEERING_LENGTH = 500;
export const MAX_INTRODUCED_LENGTH = 1000;
export const MAX_RETCON_LENGTH = 500;
export const MAX_CRITERIA_LENGTH = 1000;
export const MAX_ENDING_LENGTH = 1000;

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveCount = count.min(1);
const label = z.string().trim().min(1).max(100);
const description = z.string().trim().min(1).max(1000);
const modifier = z.number().int().min(-10).max(20);
const routeSeconds = positiveCount.max(86_400);
const taskSeconds = positiveCount.max(MAX_WAIT_SECONDS);
const speechText = z.string().trim().min(1).max(MAX_SPEECH_LENGTH);
const narrationText = z.string().trim().min(1).max(MAX_NARRATION_LENGTH);
const intentText = z.string().trim().min(1).max(MAX_INTENT_LENGTH);
const reasonText = z.string().trim().min(1).max(MAX_REASON_LENGTH);
const attributeText = z.string().trim().min(1).max(60);
const noteText = z.string().trim().min(1).max(MAX_NOTE_LENGTH);
const goalText = z.string().trim().min(1).max(MAX_GOAL_LENGTH);
const threatText = z.string().trim().min(1).max(MAX_THREAT_LENGTH);
const steeringText = z.string().trim().min(1).max(MAX_STEERING_LENGTH);
const introducedText = z.string().trim().min(1).max(MAX_INTRODUCED_LENGTH);
const retconText = z.string().trim().min(1).max(MAX_RETCON_LENGTH);
/** New words for an edited line; each kind of line keeps its own limit (see retractionProblem). */
const replacementText = z.string().trim().min(1).max(Math.max(MAX_SPEECH_LENGTH, MAX_NARRATION_LENGTH, MAX_INTRODUCED_LENGTH));
const oneChange = { message: "A retcon either rewords a line or withdraws it with a note, not both" };
const sequenceList = z.array(positiveCount).min(1).max(20);
const routeRef = z.strictObject({ fromId: id, destinationId: id });
const itemGrant = z.strictObject({ itemId: id, quantity: positiveCount.max(1000) });
export const abilitySchema = z.enum(["strength", "dexterity", "wisdom"]);
export type Ability = z.infer<typeof abilitySchema>;
export const difficultyBandSchema = z.enum(["easy", "moderate", "hard", "very hard"]);
export type DifficultyBand = z.infer<typeof difficultyBandSchema>;
/** The difficulty a ruling sets for each band; each lies inside the band perception reports. */
export const BAND_DIFFICULTY: Record<DifficultyBand, number> = { easy: 8, moderate: 12, hard: 16, "very hard": 21 };
export const confidenceSchema = z.enum(["low", "medium", "high"]);
export type Confidence = z.infer<typeof confidenceSchema>;
export const goalKindSchema = z.enum(["goal", "commitment"]);
export const goalStatusSchema = z.enum(["adopted", "fulfilled", "abandoned"]);

const ruleName = z.string().trim().min(1).max(30);
/** A world's own names for the three abilities; the keys stay strength, dexterity, and wisdom. */
export const statNamesSchema = z.strictObject({ strength: ruleName, dexterity: ruleName, wisdom: ruleName });
export type StatNames = z.infer<typeof statNamesSchema>;

/**
 * How a world decides outcomes, and what it tracks. With dice, a check is a d20
 * plus the ability's modifier against the difficulty. With judgment, the referee
 * decides from what the challenge says it takes, and the engine records the
 * decision. Without stats every modifier is 0; without health nothing deals
 * damage, so nobody is ever incapacitated.
 */
export const worldRulesSchema = z.strictObject({
  outcomes: z.enum(["dice", "judgment"]),
  stats: statNamesSchema.nullable(),
  /** What health is called, such as HP or Composure; null for none. */
  health: ruleName.nullable(),
});
export type WorldRules = z.infer<typeof worldRulesSchema>;

/** The rules of a world that names none: dice, three abilities, and hit points. */
export const DEFAULT_RULES: WorldRules = {
  outcomes: "dice",
  stats: { strength: "Strength", dexterity: "Dexterity", wisdom: "Wisdom" },
  health: "HP",
};

export function rulesOf(world: { rules?: WorldRules | undefined }): WorldRules {
  return world.rules ?? DEFAULT_RULES;
}

/** A character's own intention, or a promise made to others. */
const goalSchema = z.strictObject({
  id,
  kind: goalKindSchema,
  text: goalText,
  status: goalStatusSchema,
});
export type Goal = z.infer<typeof goalSchema>;

export const characterSchema = z.strictObject({
  id,
  name: label,
  locationId: id,
  hp: count,
  maxHp: positiveCount,
  modifiers: z.strictObject({
    strength: modifier,
    dexterity: modifier,
    wisdom: modifier,
  }),
  inventory: z.record(id, positiveCount),
  /** Voiced by the DM through NPC turns instead of taking character turns. */
  npc: z.boolean().optional(),
  /**
   * Away from the scene: neither perceives nor is perceived, and takes no turns,
   * until something brings them in. `locationId` is where they were, or would appear.
   */
  away: z.literal(true).optional(),
  /** Goals and commitments, in the order adopted; only the character perceives them. */
  goals: z.array(goalSchema).max(MAX_GOALS).optional(),
});

const threatIds = z.array(id).min(1).max(10);

const challengeSchema = z.strictObject({
  id,
  name: label,
  description: description.optional(),
  locationId: id,
  ability: abilitySchema,
  difficulty: positiveCount.max(40),
  seconds: taskSeconds,
  failureDamage: count.max(100),
  requiresItemId: id.optional(),
  /** What it takes to succeed, for the referee in a judgment world. Only the referee and the director read it. */
  criteria: z.string().trim().min(1).max(MAX_CRITERIA_LENGTH).optional(),
  onSuccess: z.strictObject({
    unlockRoutes: z.array(routeRef).max(10).optional(),
    grantItems: z.array(itemGrant).max(10).optional(),
    /** A fact revealed only to whoever succeeds: a private discovery. */
    reveals: z.string().trim().min(1).max(MAX_DISCOVERY_LENGTH).optional(),
    armThreats: threatIds.optional(),
    disarmThreats: threatIds.optional(),
  }).optional(),
  /** Consequences of failing: routes it blocks, and threats it sets in motion. */
  onFailure: z.strictObject({
    lockRoutes: z.array(routeRef).min(1).max(10).optional(),
    armThreats: threatIds.optional(),
  }).optional(),
  resolved: z.boolean(),
});

/**
 * Something the world does when the clock reaches it, whatever the characters
 * are doing. An armed threat fires at `at`; a waiting one is armed by a
 * challenge's consequence, to fire `delaySeconds` later. Firing and disarming
 * are final.
 */
const threatSchema = z.strictObject({
  id,
  name: label,
  /** What characters where it strikes notice when it fires. */
  text: threatText,
  /** Where it strikes and is noticed; everywhere when absent. */
  locationIds: z.array(id).min(1).max(20).optional(),
  /** Damage to each conscious character where it strikes. */
  damage: positiveCount.max(100).optional(),
  lockRoutes: z.array(routeRef).min(1).max(10).optional(),
  unlockRoutes: z.array(routeRef).min(1).max(10).optional(),
  /** Characters it brings into the scene, each at a place, and characters it sends away. */
  enters: z.array(z.strictObject({ characterId: id, locationId: id })).min(1).max(10).optional(),
  exits: z.array(id).min(1).max(10).optional(),
  status: z.enum(["armed", "waiting", "fired", "disarmed"]),
  at: positiveCount.optional(),
  delaySeconds: positiveCount.max(86_400).optional(),
});
export type Threat = z.infer<typeof threatSchema>;

/** One way the story can end: a challenge's success or failure, or a threat happening, ends it. */
const endingSchema = z.strictObject({
  id,
  name: label,
  /** What everyone reads when the story ends this way. */
  text: z.string().trim().min(1).max(MAX_ENDING_LENGTH),
  when: z.union([
    z.strictObject({ challengeId: id, outcome: z.enum(["success", "failure"]) }),
    z.strictObject({ threatId: id }),
  ]),
});
export type Ending = z.infer<typeof endingSchema>;

/** Bounds on the checks a DM may define when ruling on an open-ended intention. */
export const rulingLimitsSchema = z.strictObject({
  abilities: z.array(abilitySchema).min(1).max(3),
  maxDifficulty: difficultyBandSchema,
  maxFailureDamage: count.max(100),
  maxSeconds: taskSeconds,
});
export type RulingLimits = z.infer<typeof rulingLimitsSchema>;

export const worldSeedSchema = z.strictObject({
  id,
  name: label,
  speechSeconds: positiveCount.max(600),
  locations: z.array(z.strictObject({
    id,
    name: label,
    description: description.optional(),
    routes: z.array(z.strictObject({
      destinationId: id,
      seconds: routeSeconds,
      locked: z.boolean().optional(),
    })),
  })).min(1),
  items: z.array(z.strictObject({
    id,
    name: label,
    description: description.optional(),
  })),
  characters: z.array(characterSchema).min(1),
  challenges: z.array(challengeSchema),
  /** Without limits, characters cannot attempt open-ended intentions. */
  rulings: rulingLimitsSchema.optional(),
  threats: z.array(threatSchema).max(50).optional(),
  /** Dice, three abilities, and hit points when absent. */
  rules: worldRulesSchema.optional(),
  endings: z.array(endingSchema).max(20).optional(),
});

export const worldStateSchema = worldSeedSchema.extend({
  revision: positiveCount,
  elapsedSeconds: count,
  /** The ending the story reached; after it, nothing more happens. */
  endedWith: id.optional(),
});
export type WorldSeed = z.infer<typeof worldSeedSchema>;
export type WorldState = z.infer<typeof worldStateSchema>;
export type Character = WorldState["characters"][number];
export type Challenge = WorldState["challenges"][number];

export const characterActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("move"), destinationId: id }),
  z.strictObject({
    type: z.literal("transfer_item"),
    recipientId: id,
    itemId: id,
    quantity: positiveCount,
  }),
  /** `approach` says how the character goes about it, for the referee in a judgment world. */
  z.strictObject({ type: z.literal("attempt_check"), challengeId: id, approach: intentText.optional() }),
  /** An open-ended intention; the DM's ruling decides how the engine resolves it. */
  z.strictObject({ type: z.literal("attempt"), intent: intentText }),
  z.strictObject({ type: z.literal("wait"), seconds: positiveCount.max(MAX_WAIT_SECONDS) }),
]);
export type CharacterAction = z.infer<typeof characterActionSchema>;

/**
 * Who a new check (if it succeeds) or an automatic success brings into the scene
 * at the actor's place, and which supporting character there it sends away.
 */
const staging = { bringsIn: id.optional(), sendsOut: id.optional() };

/**
 * The DM's ruling on an attempt: the same task as an existing challenge, a new
 * check within the world's limits, or an automatic success. An impossible
 * intention never reaches the engine; it goes back to the character.
 */
export const rulingInputSchema = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("existing"), challengeId: id, reason: reasonText }),
  z.strictObject({
    decision: z.literal("new"),
    name: label,
    ability: abilitySchema,
    difficulty: difficultyBandSchema,
    failureDamage: count.max(100),
    seconds: taskSeconds,
    reason: reasonText,
    ...staging,
  }),
  z.strictObject({ decision: z.literal("automatic"), seconds: taskSeconds, reason: reasonText, ...staging }),
]);
export type RulingInput = z.infer<typeof rulingInputSchema>;

/** The referee's decision on an attempt in a judgment world, with a reason shown to those present. */
export const judgmentInputSchema = z.strictObject({ success: z.boolean(), reason: reasonText });
export type JudgmentInput = z.infer<typeof judgmentInputSchema>;

/** A belief a character records: about one entity, citing events it perceived. */
export const noteInputSchema = z.strictObject({
  about: id,
  attribute: attributeText,
  value: noteText,
  evidence: z.array(positiveCount).max(MAX_EVIDENCE),
  confidence: confidenceSchema,
});
export type NoteInput = z.infer<typeof noteInputSchema>;

/** Adopting a goal or commitment, or settling one by its ID. */
export const goalInputSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("adopted"), kind: goalKindSchema, text: goalText }),
  z.strictObject({ status: z.literal("fulfilled"), goalId: id }),
  z.strictObject({ status: z.literal("abandoned"), goalId: id }),
]);
export type GoalInput = z.infer<typeof goalInputSchema>;

export const commandSchema = z.discriminatedUnion("role", [
  z.strictObject({
    role: z.literal("character"),
    requestId: id,
    expectedRevision: positiveCount,
    actorId: id,
    speech: speechText.optional(),
    /** The one person present the speech is addressed to. */
    addresseeId: id.optional(),
    action: characterActionSchema.optional(),
    /** The DM's ruling, present exactly when the action is an attempt. */
    ruling: rulingInputSchema.optional(),
    /** In a judgment world, the referee's decision on an attempted check. */
    judgment: judgmentInputSchema.optional(),
    /** A belief to remember, and a goal to adopt or settle; only the character perceives them. */
    note: noteInputSchema.optional(),
    goal: goalInputSchema.optional(),
  }).refine((command) => command.speech !== undefined || command.action !== undefined, {
    message: "A character turn needs speech, an action, or both",
  }).refine((command) => command.addresseeId === undefined || command.speech !== undefined, {
    message: "Only speech can be addressed to someone",
  }).refine((command) => (command.action?.type === "attempt") === (command.ruling !== undefined), {
    message: "An attempt needs the DM's ruling, and only an attempt has one",
  }).refine((command) => command.judgment === undefined || command.action?.type === "attempt_check" || command.action?.type === "attempt", {
    message: "Only an attempt can be judged",
  }),
  /** An NPC's turn, voiced by the DM: npc_say (speech), npc_move (destination), and leaving the scene. */
  z.strictObject({
    role: z.literal("npc"),
    requestId: id,
    expectedRevision: positiveCount,
    actorId: id,
    speech: speechText.optional(),
    addresseeId: id.optional(),
    destinationId: id.optional(),
    /** Leave the scene after speaking, until something brings them back. */
    leave: z.literal(true).optional(),
  }).refine((command) => command.speech !== undefined || command.destinationId !== undefined, {
    message: "An NPC turn needs speech, a destination, or both",
  }).refine((command) => command.addresseeId === undefined || command.speech !== undefined, {
    message: "Only speech can be addressed to someone",
  }).refine((command) => command.leave === undefined || (command.speech !== undefined && command.destinationId === undefined), {
    message: "An NPC leaves the scene after speaking, and without walking anywhere",
  }),
  z.strictObject({
    role: z.literal("dm"),
    requestId: id,
    expectedRevision: positiveCount,
    action: z.strictObject({
      type: z.literal("narrate"),
      aboutSequences: sequenceList,
      text: narrationText,
    }),
  }),
  /**
   * The director's commands. Steering is out of fiction: it asks one character,
   * or the whole party, to reconsider. An introduced event is in the fiction:
   * something happens where the director says, and whoever is there perceives it.
   * A retcon changes an earlier line: narration, speech, or an introduced
   * event. With `replacement` it rewords the line; otherwise it withdraws it,
   * silently or with `text`, a correction for those who perceived it.
   */
  z.strictObject({
    role: z.literal("director"),
    requestId: id,
    expectedRevision: positiveCount,
    action: z.discriminatedUnion("type", [
      z.strictObject({
        type: z.literal("steer"),
        text: steeringText,
        targetId: id.optional(),
      }),
      z.strictObject({
        type: z.literal("introduce"),
        text: introducedText,
        /** Where it happens; everywhere if omitted. */
        locationIds: z.array(id).min(1).max(20).optional(),
        lockRoutes: z.array(routeRef).min(1).max(10).optional(),
        unlockRoutes: z.array(routeRef).min(1).max(10).optional(),
      }),
      z.strictObject({
        type: z.literal("retcon"),
        sequence: positiveCount,
        text: retconText.optional(),
        replacement: replacementText.optional(),
      }).refine((action) => action.text === undefined || action.replacement === undefined, oneChange),
      /** Brings someone away from the scene into it, at a place; `text` says how it looks. */
      z.strictObject({ type: z.literal("enter"), characterId: id, locationId: id, text: introducedText.optional() }),
      /** Sends someone in the scene away from it. */
      z.strictObject({ type: z.literal("exit"), characterId: id, text: introducedText.optional() }),
    ]),
  }),
]);
export type Command = z.infer<typeof commandSchema>;

export const eventSourceSchema = z.enum(["engine", "character", "dm", "director"]);
export type EventSource = z.infer<typeof eventSourceSchema>;

const effectsSchema = z.strictObject({
  unlockedRoutes: z.array(routeRef).max(10),
  grantedItems: z.array(itemGrant).max(10),
  /** Routes a failure blocked; present only when there are some. */
  lockedRoutes: z.array(routeRef).min(1).max(10).optional(),
});
export type CheckEffects = z.infer<typeof effectsSchema>;

export const eventSchema = z.strictObject({
  v: z.literal(EVENT_FORMAT),
  worldId: id,
  sequence: positiveCount,
  requestId: id,
  source: eventSourceSchema,
  recordedAt: z.iso.datetime(),
  elapsedSeconds: count,
  data: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("world_created"), seed: worldSeedSchema }),
    z.strictObject({
      type: z.literal("utterance"),
      actorId: id,
      locationId: id,
      text: speechText,
      seconds: positiveCount,
      addresseeId: id.optional(),
    }),
    z.strictObject({
      type: z.literal("character_moved"),
      actorId: id,
      fromId: id,
      destinationId: id,
      seconds: routeSeconds,
    }),
    z.strictObject({
      type: z.literal("item_transferred"),
      actorId: id,
      recipientId: id,
      itemId: id,
      quantity: positiveCount,
    }),
    /** A check's outcome: rolled in a dice world, or the referee's judgment, with its reason, in a judgment world. */
    z.strictObject({
      type: z.literal("check_resolved"),
      actorId: id,
      challengeId: id,
      roll: z.number().int().min(1).max(20).optional(),
      modifier: modifier.optional(),
      difficulty: positiveCount.optional(),
      reason: reasonText.optional(),
      approach: intentText.optional(),
      success: z.boolean(),
      damage: count,
      seconds: taskSeconds,
      effects: effectsSchema,
    }),
    z.strictObject({
      type: z.literal("time_advanced"),
      actorId: id,
      seconds: positiveCount.max(MAX_WAIT_SECONDS),
      /** The threat that cut the wait short, firing as it ends. */
      interruptedBy: id.optional(),
    }),
    /** A journey cut short by a threat: the traveler never arrived, and is still where it began. */
    z.strictObject({
      type: z.literal("travel_halted"),
      actorId: id,
      fromId: id,
      destinationId: id,
      seconds: routeSeconds,
      threatId: id,
    }),
    /** A threat firing: perceived where it strikes. */
    z.strictObject({
      type: z.literal("threat_triggered"),
      threatId: id,
      /** When it was due; the event may come up to one task later. */
      at: positiveCount,
      text: threatText,
      locationIds: z.array(id).min(1).max(20).optional(),
      damage: z.array(z.strictObject({ characterId: id, amount: positiveCount })).max(100),
      lockedRoutes: z.array(routeRef).max(10),
      unlockedRoutes: z.array(routeRef).max(10),
    }),
    /** A consequence setting a threat in motion. Nobody perceives it until the threat fires. */
    z.strictObject({ type: z.literal("threat_armed"), threatId: id, challengeId: id, at: positiveCount }),
    /** A consequence stopping a threat. Nobody perceives it. */
    z.strictObject({ type: z.literal("threat_disarmed"), threatId: id, challengeId: id }),
    /** The story reaching one of its endings. Everyone perceives it, and nothing happens after it. */
    z.strictObject({ type: z.literal("story_ended"), endingId: id }),
    /** The director's request to reconsider, outside the story. Nobody perceives it as an event. */
    z.strictObject({ type: z.literal("steering"), text: steeringText, targetId: id.optional() }),
    /** Something the director made happen in the world: perceived, and remembered, by those where it happens. */
    z.strictObject({
      type: z.literal("introduced"),
      text: introducedText,
      locationIds: z.array(id).min(1).max(20).optional(),
      lockedRoutes: z.array(routeRef).max(10),
      unlockedRoutes: z.array(routeRef).max(10),
    }),
    /**
     * Someone coming into the scene, or leaving it, seen by those where it happens.
     * The source says why: the director, the engine (a threat, or a ruling that
     * brought them in or sent them away), or the DM (an NPC leaving on its turn).
     */
    z.strictObject({ type: z.literal("character_entered"), characterId: id, locationId: id, text: introducedText.optional() }),
    z.strictObject({ type: z.literal("character_exited"), characterId: id, locationId: id, text: introducedText.optional() }),
    /**
     * A director's retcon of an earlier line, which stays in the log as it was.
     * With `replacement`, the line is reworded: agents see the new words in its
     * place, and nobody perceives the retcon itself. Otherwise the line is
     * withdrawn, and agents no longer see it; `text`, a correction, reaches
     * whoever perceived it, and without one nobody perceives the retcon.
     */
    z.strictObject({
      type: z.literal("retraction"),
      targetSequence: positiveCount,
      text: retconText.optional(),
      replacement: replacementText.optional(),
    }).refine((data) => data.text === undefined || data.replacement === undefined, oneChange),
    z.strictObject({
      type: z.literal("narration"),
      aboutSequences: sequenceList,
      text: narrationText,
    }),
    /** A fact a successful check revealed; only the finder perceives it. */
    z.strictObject({
      type: z.literal("discovery"),
      actorId: id,
      challengeId: id,
      text: z.string().trim().min(1).max(MAX_DISCOVERY_LENGTH),
    }),
    /**
     * A belief the character recorded. The engine derives `source` from the
     * evidence: someone else's speech or narration is "reported", any other
     * perceived event "inferred", and no evidence "speculation".
     */
    z.strictObject({
      type: z.literal("belief_noted"),
      actorId: id,
      about: id,
      attribute: attributeText,
      value: noteText,
      evidence: z.array(positiveCount).max(MAX_EVIDENCE),
      confidence: confidenceSchema,
      source: z.enum(["reported", "inferred", "speculation"]),
    }),
    /** A goal or commitment adopted, fulfilled, or abandoned. */
    z.strictObject({
      type: z.literal("goal_set"),
      actorId: id,
      goalId: id,
      kind: goalKindSchema,
      text: goalText,
      status: goalStatusSchema,
    }),
    /**
     * The DM's ruling on an attempt, committed before any roll. A new check's
     * definition joins the world here; an automatic success takes `seconds`.
     */
    z.strictObject({
      type: z.literal("ruling"),
      actorId: id,
      intent: intentText,
      decision: z.enum(["existing", "new", "automatic"]),
      challengeId: id.optional(),
      challenge: challengeSchema.optional(),
      seconds: taskSeconds.optional(),
      reason: reasonText,
      ...staging,
    }),
  ]),
});
export type AdventureEvent = z.infer<typeof eventSchema>;
export type EventData = AdventureEvent["data"];

export class EngineError extends Error {
  readonly code:
    | "INVALID_INPUT"
    | "NOT_FOUND"
    | "STALE_REVISION"
    | "REQUEST_CONFLICT"
    | "INVALID_ACTION"
    | "WORLD_BUSY"
    | "DRAFT_BUSY"
    | "CORRUPT_STORAGE";

  constructor(
    code: EngineError["code"],
    message: string,
  ) {
    super(message);
    this.name = "EngineError";
    this.code = code;
  }
}

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new EngineError("INVALID_INPUT", parsed.error.message);
  }
  return parsed.data;
}

export function parseStored<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new EngineError("CORRUPT_STORAGE", parsed.error.message);
  return parsed.data;
}

/** Key-order-independent JSON, for comparing stored and recomputed values. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Something wrong with a world: what it is, and which part of the world it concerns. */
export interface WorldProblem {
  message: string;
  kind: "location" | "item" | "character" | "challenge" | "threat" | "ending" | "rules";
  id?: string;
}

/** Every reference and consistency problem in a world, in a fixed order; empty when it is sound. */
export function worldProblems(world: WorldSeed): WorldProblem[] {
  const problems: WorldProblem[] = [];
  const add = (kind: WorldProblem["kind"], message: string, id?: string) => {
    problems.push({ message, kind, ...(id === undefined ? {} : { id }) });
  };
  for (const [label, entities] of [
    ["location", world.locations],
    ["item", world.items],
    ["character", world.characters],
    ["challenge", world.challenges],
  ] as const) {
    if (new Set(entities.map((entity) => entity.id)).size !== entities.length) add(label, `Duplicate ${label} ID`);
  }
  const locations = new Map(world.locations.map((location) => [location.id, location]));
  const items = new Set(world.items.map((item) => item.id));
  for (const location of world.locations) {
    const destinations = new Set<string>();
    for (const route of location.routes) {
      if (!locations.has(route.destinationId) || destinations.has(route.destinationId)) {
        add("location", `Invalid or duplicate route at ${location.id}`, location.id);
      }
      destinations.add(route.destinationId);
    }
  }
  for (const character of world.characters) {
    if (!locations.has(character.locationId) || character.hp > character.maxHp) {
      add("character", `Invalid character state: ${character.id}`, character.id);
    }
    if (Object.keys(character.inventory).some((itemId) => !items.has(itemId))) {
      add("character", `Unknown inventory item for ${character.id}`, character.id);
    }
    const goals = character.goals ?? [];
    if (new Set(goals.map((goal) => goal.id)).size !== goals.length) {
      add("character", `Duplicate goal ID for ${character.id}`, character.id);
    }
  }
  for (const challenge of world.challenges) {
    if (!locations.has(challenge.locationId)) {
      add("challenge", `Unknown challenge location: ${challenge.id}`, challenge.id);
    }
    if (challenge.requiresItemId !== undefined && !items.has(challenge.requiresItemId)) {
      add("challenge", `Unknown required item for ${challenge.id}`, challenge.id);
    }
    for (const ref of [...challenge.onSuccess?.unlockRoutes ?? [], ...challenge.onFailure?.lockRoutes ?? []]) {
      const route = locations.get(ref.fromId)?.routes.find((entry) => entry.destinationId === ref.destinationId);
      if (!route) add("challenge", `Unknown route changed by ${challenge.id}`, challenge.id);
    }
    if ((challenge.onSuccess?.grantItems ?? []).some((grant) => !items.has(grant.itemId))) {
      add("challenge", `Unknown item granted by ${challenge.id}`, challenge.id);
    }
    const referenced = [
      ...challenge.onSuccess?.armThreats ?? [], ...challenge.onSuccess?.disarmThreats ?? [], ...challenge.onFailure?.armThreats ?? [],
    ];
    if (referenced.some((threatId) => !world.threats?.some((threat) => threat.id === threatId))) {
      add("challenge", `Unknown threat in the consequences of ${challenge.id}`, challenge.id);
    }
  }
  const threats = world.threats ?? [];
  if (new Set(threats.map((threat) => threat.id)).size !== threats.length) add("threat", "Duplicate threat ID");
  for (const threat of threats) {
    if ((threat.locationIds ?? []).some((locationId) => !locations.has(locationId))) {
      add("threat", `Unknown location for threat ${threat.id}`, threat.id);
    }
    for (const ref of [...threat.lockRoutes ?? [], ...threat.unlockRoutes ?? []]) {
      if (!locations.get(ref.fromId)?.routes.some((entry) => entry.destinationId === ref.destinationId)) {
        add("threat", `Unknown route changed by threat ${threat.id}`, threat.id);
      }
    }
    const characters = new Set(world.characters.map((character) => character.id));
    const entering = (threat.enters ?? []).map((entry) => entry.characterId);
    if (
      (threat.enters ?? []).some((entry) => !characters.has(entry.characterId) || !locations.has(entry.locationId))
      || (threat.exits ?? []).some((characterId) => !characters.has(characterId))
      || new Set(entering).size !== entering.length || new Set(threat.exits ?? []).size !== (threat.exits ?? []).length
      || entering.some((characterId) => threat.exits?.includes(characterId))
    ) {
      add("threat", `Threat ${threat.id} brings in or sends away an unknown character, at an unknown place, or someone twice`, threat.id);
    }
    if ((threat.status === "armed" && threat.at === undefined)
      || (threat.status === "waiting" && (threat.delaySeconds === undefined || threat.at !== undefined))) {
      add("threat", `Threat ${threat.id} needs \`at\` when armed, and only \`delaySeconds\` while waiting`, threat.id);
    }
  }
  const endings = world.endings ?? [];
  if (new Set(endings.map((ending) => ending.id)).size !== endings.length) add("ending", "Duplicate ending ID");
  for (const ending of endings) {
    const { when } = ending;
    const known = "threatId" in when
      ? threats.some((threat) => threat.id === when.threatId)
      : world.challenges.some((challenge) => challenge.id === when.challengeId);
    if (!known) add("ending", `Ending ${ending.id} waits on a challenge or threat that does not exist`, ending.id);
    const trigger = "threatId" in when ? `threat ${when.threatId}` : `${when.challengeId} ${when.outcome}`;
    const first = endings.find((other) => (
      "threatId" in other.when ? `threat ${other.when.threatId}` : `${other.when.challengeId} ${other.when.outcome}`
    ) === trigger);
    if (first !== ending) add("ending", `Ending ${ending.id} waits on the same thing as ${first!.id}, so it can never happen`, ending.id);
  }
  const rules = rulesOf(world);
  if (rules.stats === null) {
    for (const character of world.characters) {
      if (Object.values(character.modifiers).some((value) => value !== 0)) {
        add("character", `${character.id} has stats, but this world has none`, character.id);
      }
    }
  }
  if (rules.health === null) {
    for (const character of world.characters) {
      if (character.hp !== character.maxHp) add("character", `${character.id} is hurt, but this world has no health`, character.id);
    }
    for (const challenge of world.challenges) {
      if (challenge.failureDamage > 0) add("challenge", `${challenge.id} deals damage, but this world has no health`, challenge.id);
    }
    for (const threat of threats) {
      if (threat.damage !== undefined) add("threat", `Threat ${threat.id} deals damage, but this world has no health`, threat.id);
    }
    if ((world.rulings?.maxFailureDamage ?? 0) > 0) add("rules", "Open-ended attempts may deal damage, but this world has no health");
  }
  return problems;
}

export function validateWorld(world: WorldSeed): void {
  const [first] = worldProblems(world);
  if (first) throw new EngineError("INVALID_INPUT", first.message);
}
