import { z } from "zod";

/** Format of newly written events. Older events are upcast on read (see upcast.ts). */
export const EVENT_FORMAT = 2;
export const MAX_WAIT_SECONDS = 3600;
export const MAX_SPEECH_LENGTH = 500;
export const MAX_NARRATION_LENGTH = 1000;

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
const sequenceList = z.array(positiveCount).min(1).max(20);
const routeRef = z.strictObject({ fromId: id, destinationId: id });
const itemGrant = z.strictObject({ itemId: id, quantity: positiveCount.max(1000) });
export const abilitySchema = z.enum(["strength", "dexterity", "wisdom"]);
export type Ability = z.infer<typeof abilitySchema>;

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
});

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
  challenges: z.array(z.strictObject({
    id,
    name: label,
    description: description.optional(),
    locationId: id,
    ability: abilitySchema,
    difficulty: positiveCount.max(40),
    seconds: taskSeconds,
    failureDamage: count.max(100),
    requiresItemId: id.optional(),
    onSuccess: z.strictObject({
      unlockRoutes: z.array(routeRef).max(10).optional(),
      grantItems: z.array(itemGrant).max(10).optional(),
    }).optional(),
    resolved: z.boolean(),
  })),
});

export const worldStateSchema = worldSeedSchema.extend({
  revision: positiveCount,
  elapsedSeconds: count,
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
  z.strictObject({ type: z.literal("attempt_check"), challengeId: id }),
  z.strictObject({ type: z.literal("wait"), seconds: positiveCount.max(MAX_WAIT_SECONDS) }),
]);
export type CharacterAction = z.infer<typeof characterActionSchema>;

export const commandSchema = z.discriminatedUnion("role", [
  z.strictObject({
    role: z.literal("character"),
    requestId: id,
    expectedRevision: positiveCount,
    actorId: id,
    speech: speechText.optional(),
    action: characterActionSchema.optional(),
  }).refine((command) => command.speech !== undefined || command.action !== undefined, {
    message: "A character turn needs speech, an action, or both",
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
]);
export type Command = z.infer<typeof commandSchema>;

export const eventSourceSchema = z.enum(["engine", "character", "dm", "director"]);
export type EventSource = z.infer<typeof eventSourceSchema>;

const effectsSchema = z.strictObject({
  unlockedRoutes: z.array(routeRef).max(10),
  grantedItems: z.array(itemGrant).max(10),
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
    z.strictObject({
      type: z.literal("check_resolved"),
      actorId: id,
      challengeId: id,
      roll: z.number().int().min(1).max(20),
      modifier,
      difficulty: positiveCount,
      success: z.boolean(),
      damage: count,
      seconds: taskSeconds,
      effects: effectsSchema,
    }),
    z.strictObject({
      type: z.literal("time_advanced"),
      actorId: id,
      seconds: positiveCount.max(MAX_WAIT_SECONDS),
    }),
    z.strictObject({
      type: z.literal("narration"),
      aboutSequences: sequenceList,
      text: narrationText,
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

export function validateWorld(world: WorldSeed): void {
  for (const [label, entities] of [
    ["location", world.locations],
    ["item", world.items],
    ["character", world.characters],
    ["challenge", world.challenges],
  ] as const) {
    if (new Set(entities.map((entity) => entity.id)).size !== entities.length) {
      throw new EngineError("INVALID_INPUT", `Duplicate ${label} ID`);
    }
  }
  const locations = new Map(world.locations.map((location) => [location.id, location]));
  const items = new Set(world.items.map((item) => item.id));
  for (const location of world.locations) {
    const destinations = new Set<string>();
    for (const route of location.routes) {
      if (!locations.has(route.destinationId) || destinations.has(route.destinationId)) {
        throw new EngineError("INVALID_INPUT", `Invalid or duplicate route at ${location.id}`);
      }
      destinations.add(route.destinationId);
    }
  }
  for (const character of world.characters) {
    if (!locations.has(character.locationId) || character.hp > character.maxHp) {
      throw new EngineError("INVALID_INPUT", `Invalid character state: ${character.id}`);
    }
    if (Object.keys(character.inventory).some((itemId) => !items.has(itemId))) {
      throw new EngineError("INVALID_INPUT", `Unknown inventory item for ${character.id}`);
    }
  }
  for (const challenge of world.challenges) {
    if (!locations.has(challenge.locationId)) {
      throw new EngineError("INVALID_INPUT", `Unknown challenge location: ${challenge.id}`);
    }
    if (challenge.requiresItemId !== undefined && !items.has(challenge.requiresItemId)) {
      throw new EngineError("INVALID_INPUT", `Unknown required item for ${challenge.id}`);
    }
    for (const ref of challenge.onSuccess?.unlockRoutes ?? []) {
      const route = locations.get(ref.fromId)?.routes.find((entry) => entry.destinationId === ref.destinationId);
      if (!route) throw new EngineError("INVALID_INPUT", `Unknown route unlocked by ${challenge.id}`);
    }
    if ((challenge.onSuccess?.grantItems ?? []).some((grant) => !items.has(grant.itemId))) {
      throw new EngineError("INVALID_INPUT", `Unknown item granted by ${challenge.id}`);
    }
  }
}
