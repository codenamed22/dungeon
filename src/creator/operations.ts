import { z } from "zod";
import { castProblems, castSchema, MAX_PREMISE_LENGTH, npcPersonaSchema, paceSchema, personaSchema } from "../agents/prompts.ts";
import type { Cast } from "../agents/prompts.ts";
import {
  abilitySchema, BAND_DIFFICULTY, difficultyBandSchema, EngineError, MAX_ENDING_LENGTH, parseInput, rulesOf, worldProblems,
  worldSeedSchema,
} from "../model.ts";
import type { DifficultyBand, WorldRules, WorldSeed } from "../model.ts";

// The world creator's operations: small, checked edits to a draft world and
// its cast. The browser's editor and the AI creator's tools both use them, so
// they behave the same whoever makes the edit. Keep this module free of Node
// APIs: the browser imports it.

const seedShape = worldSeedSchema.shape;
const locationSchema = seedShape.locations.element;
const itemSchema = seedShape.items.element;
const characterSchema = seedShape.characters.element;
const challengeSchema = seedShape.challenges.element;
const threatSchema = seedShape.threats.unwrap().element;
const endingSchema = seedShape.endings.unwrap().element;

export const DRAFT_LIMITS = { places: 30, items: 50, characters: 20, challenges: 30, threats: 20, endings: 10 } as const;

/** A world being written: possibly incomplete, so it may have no places or characters yet. */
export const draftSeedSchema = worldSeedSchema.extend({
  locations: z.array(locationSchema).max(DRAFT_LIMITS.places),
  items: z.array(itemSchema).max(DRAFT_LIMITS.items),
  characters: z.array(characterSchema).max(DRAFT_LIMITS.characters),
  challenges: z.array(challengeSchema).max(DRAFT_LIMITS.challenges),
});
export const draftSchema = z.strictObject({ seed: draftSeedSchema, cast: castSchema });
export type Draft = z.infer<typeof draftSchema>;
export type DraftSeed = Draft["seed"];

export interface OperationResult {
  draft: Draft;
  /** What changed, in a sentence: shown to the director and returned to the AI. */
  summary: string;
}

/** A new world starts free-form: the referee judges outcomes, and nobody has stats or health. */
export function blankDraft(name = "Untitled world"): Draft {
  return {
    seed: {
      id: "new-world", name, speechSeconds: 10, locations: [], items: [], characters: [], challenges: [],
      rules: { outcomes: "judgment", stats: null, health: null },
    },
    cast: { narratorStyle: "Plain, concrete, present tense.", characters: {} },
  };
}

// ---------------------------------------------------------------------------
// Problems

export type DraftSection = "story" | "places" | "characters" | "items" | "challenges" | "threats" | "endings";

export interface DraftProblem {
  /** Errors stop the world being created; warnings do not. */
  severity: "error" | "warning";
  section: DraftSection;
  message: string;
  id?: string;
}

const SECTION_BY_KIND = {
  location: "places", item: "items", character: "characters", challenge: "challenges", threat: "threats", ending: "endings", rules: "story",
} as const satisfies Record<string, DraftSection>;

/** Everything that stops a draft becoming a world, then what would make it play better. */
export function draftProblems(draft: Draft): DraftProblem[] {
  const { seed, cast } = draft;
  const problems: DraftProblem[] = [];
  const add = (severity: DraftProblem["severity"], section: DraftSection, message: string, id?: string) => {
    problems.push({ severity, section, message, ...(id === undefined ? {} : { id }) });
  };
  const places = new Set(seed.locations.map((location) => location.id));
  if (seed.locations.length === 0) add("error", "places", "Add at least one place.");
  if (!seed.characters.some((character) => !character.npc)) add("error", "characters", "Add at least one main character.");
  else if (!seed.characters.some((character) => !character.npc && !character.away)) {
    add("error", "characters", "At least one main character must start in the scene, or nobody can take the first turn.");
  }
  // Removing a place can strand what was in it; say so plainly before the engine's own checks.
  const reported = new Set<string>();
  for (const character of seed.characters) {
    if (!places.has(character.locationId)) {
      add("error", "characters", `${character.name} starts in a place that does not exist. Choose where they start.`, character.id);
      reported.add(`character:${character.id}`);
    }
  }
  for (const challenge of seed.challenges) {
    if (!places.has(challenge.locationId)) {
      add("error", "challenges", `"${challenge.name}" is in a place that does not exist. Choose where it is.`, challenge.id);
      reported.add(`challenge:${challenge.id}`);
    }
  }
  for (const problem of worldProblems(seed as WorldSeed)) {
    const restates = /^(Invalid character state|Unknown challenge location)/.test(problem.message);
    if (restates && reported.has(`${problem.kind}:${problem.id}`)) continue;
    add("error", SECTION_BY_KIND[problem.kind], problem.message, problem.id);
  }
  for (const message of castProblems(cast, seed.characters, seed.id)) add("error", "characters", message);

  if (!cast.premise) add("warning", "story", "Write a premise, so every AI knows what kind of world this is.");
  for (const character of seed.characters) {
    if (!character.npc && !cast.characters[character.id]) {
      add("warning", "characters", `No agent plays ${character.name}: give them a persona, or they never take a turn.`, character.id);
    }
    if (character.npc && !cast.npcs?.[character.id]) {
      add("warning", "characters", `${character.name} never speaks without a persona.`, character.id);
    }
  }
  const broughtIn = new Set((seed.threats ?? []).flatMap((threat) => (threat.enters ?? []).map((entry) => entry.characterId)));
  for (const character of seed.characters) {
    if (character.away && !broughtIn.has(character.id)) {
      add("warning", "characters", `${character.name} starts away and no threat brings them in, so only the referee or the director can.`, character.id);
    }
  }
  if (seed.locations.length > 0 && seed.challenges.length === 0) {
    add("warning", "challenges", "Nothing stands in anyone's way yet. Add a challenge.");
  }
  if (rulesOf(seed).outcomes === "judgment") {
    for (const challenge of seed.challenges) {
      if (!challenge.criteria) add("warning", "challenges", `"${challenge.name}" doesn't say what it takes, so the referee will guess.`, challenge.id);
    }
  }
  const threats = new Map((seed.threats ?? []).map((threat) => [threat.id, threat]));
  const setOff = new Set(seed.challenges.flatMap((challenge) => [...challenge.onSuccess?.armThreats ?? [], ...challenge.onFailure?.armThreats ?? []]));
  for (const threat of threats.values()) {
    if (threat.status === "waiting" && !setOff.has(threat.id)) {
      add("warning", "threats", `Nothing sets off "${threat.name}", so it never happens. Choose it under a challenge's outcome, or give it a time.`, threat.id);
    }
  }
  for (const challenge of seed.challenges) {
    for (const threatId of [...challenge.onSuccess?.armThreats ?? [], ...challenge.onFailure?.armThreats ?? []]) {
      const threat = threats.get(threatId);
      if (threat?.status === "armed") {
        add("warning", "challenges", `"${challenge.name}" sets off "${threat.name}", which is already on its own clock, so that does nothing.`, challenge.id);
      }
    }
  }
  return problems;
}

export function hasErrors(problems: readonly DraftProblem[]): boolean {
  return problems.some((problem) => problem.severity === "error");
}

// ---------------------------------------------------------------------------
// Helpers

function fail(message: string): never {
  throw new EngineError("INVALID_INPUT", message);
}

/** Checks an operation's input, with a reason a person can act on: the editor calls operations directly. */
function checked<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  let reason = issue.message;
  if (issue.code === "too_small") {
    reason = issue.origin === "string" && Number(issue.minimum) === 1 ? "can't be empty" : `must be at least ${String(issue.minimum)}`;
  } else if (issue.code === "too_big") {
    reason = issue.origin === "string" ? `is too long (at most ${String(issue.maximum)} characters)` : `must be at most ${String(issue.maximum)}`;
  }
  const field = issue.path.join(".");
  return fail(field ? `${field} ${reason}` : reason);
}

/** A readable ID from a name: lowercase letters, digits, and hyphens. */
export function slugify(name: string): string {
  const slug = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return slug || "x";
}

/** IDs are unique across every kind of thing, since a belief can be about any of them. */
function takenIds(seed: DraftSeed): Set<string> {
  return new Set([
    ...seed.locations, ...seed.items, ...seed.characters, ...seed.challenges, ...seed.threats ?? [], ...seed.endings ?? [],
  ].map((entity) => entity.id));
}

function freshId(seed: DraftSeed, name: string): string {
  const taken = takenIds(seed);
  const base = slugify(name);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

function nameOf(seed: DraftSeed, id: string): string {
  return [...seed.locations, ...seed.items, ...seed.characters, ...seed.challenges, ...seed.threats ?? [], ...seed.endings ?? []]
    .find((entity) => entity.id === id)?.name ?? id;
}

function place(seed: DraftSeed, id: string, what = "place") {
  return seed.locations.find((location) => location.id === id) ?? fail(`There is no ${what} with ID "${id}".`);
}

function requireItem(seed: DraftSeed, id: string): void {
  if (!seed.items.some((item) => item.id === id)) fail(`There is no item with ID "${id}".`);
}

function requireCharacter(seed: DraftSeed, id: string) {
  return seed.characters.find((character) => character.id === id) ?? fail(`There is no character with ID "${id}".`);
}

function requireThreat(seed: DraftSeed, id: string) {
  return seed.threats?.find((threat) => threat.id === id) ?? fail(`There is no threat with ID "${id}".`);
}

type RouteInput = { fromId: string; toId: string };

function routeRefs(seed: DraftSeed, routes: readonly RouteInput[]) {
  return routes.map(({ fromId, toId }) => {
    if (!place(seed, fromId).routes.some((route) => route.destinationId === toId)) {
      fail(`There is no way from ${nameOf(seed, fromId)} to ${nameOf(seed, toId)}. Connect the places first.`);
    }
    return { fromId, destinationId: toId };
  });
}

/** Sets an optional field, or removes it when the value is empty. */
function setOptional<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | "" | undefined | null): void {
  if (value === undefined) return;
  if (value === "" || value === null || (Array.isArray(value) && value.length === 0)) delete target[key];
  else target[key] = value;
}

export function bandOf(difficulty: number): DifficultyBand {
  const bands = Object.entries(BAND_DIFFICULTY) as [DifficultyBand, number][];
  return bands.reduce((best, entry) => (Math.abs(entry[1] - difficulty) < Math.abs(best[1] - difficulty) ? entry : best))[0];
}

function edit(draft: Draft, change: (draft: Draft) => string): OperationResult {
  const next = structuredClone(draft);
  const summary = change(next);
  return { draft: parseInput(draftSchema, next), summary };
}

// ---------------------------------------------------------------------------
// Inputs. Flat objects with every field described: they are also the AI's tool schemas.

const name = z.string().trim().min(1).max(100);
const ref = z.string().trim().min(1).max(64);
const longText = z.string().trim().max(1000);
const routeInput = z.strictObject({
  fromId: ref.describe("ID of the place the way leads from"),
  toId: ref.describe("ID of the place it leads to"),
});
const lines = (max: number, what: string) => z.array(z.string().trim().min(1).max(300)).max(max).describe(what);

const ruleName = z.string().trim().min(1).max(30);

export const setWorldInput = z.strictObject({
  name: name.optional().describe("The world's title"),
  premise: z.string().trim().max(MAX_PREMISE_LENGTH).optional().describe(
    "Setting, genre, tone, and what is at stake, in two to four sentences. Every AI reads it, the main characters included, so keep "
      + "secrets and solutions out of it. An empty string removes it.",
  ),
  narratorStyle: z.string().trim().min(1).max(500).optional().describe("How the narrator writes, e.g. \"Warm and wry, present tense.\""),
  outcomes: z.enum(["judgment", "dice"]).optional().describe(
    "How attempts are decided: judgment, by a referee from what each challenge says it takes; or dice, a d20 plus a stat against the difficulty",
  ),
  statNames: z.array(ruleName).length(3).nullable().optional().describe(
    "The world's names for its first, second, and third stats, e.g. [\"Charm\", \"Wit\", \"Empathy\"], or null for none, which "
      + "zeroes every stat. Stats hint to the referee, or add to dice rolls.",
  ),
  healthName: ruleName.nullable().optional().describe(
    "What health is called, e.g. \"HP\" or \"Composure\", or null for none: then nothing can hurt anyone, and all damage is removed.",
  ),
  pace: paceSchema.optional().describe(
    "action presses the characters to act when talk goes in circles; conversation lets talk carry the story, for social stories",
  ),
  secondsPerLine: z.number().int().min(1).max(600).optional().describe("In-world seconds one spoken line takes; usually 10"),
  openEndedActions: z.boolean().optional().describe(
    "Whether characters may attempt things no listed action covers, with a referee deciding the check. Usually true.",
  ),
  rulingAbilities: z.array(abilitySchema).min(1).max(3).optional().describe("Stats the referee may test in open-ended attempts (strength, dexterity, wisdom: the first, second, third)"),
  rulingMaxDifficulty: difficultyBandSchema.optional().describe("The hardest check the referee may set"),
  rulingMaxDamage: z.number().int().min(0).max(100).optional().describe("The most damage a failed open-ended attempt may deal"),
  rulingMaxMinutes: z.number().int().min(1).max(60).optional().describe("The longest an open-ended attempt may take, in minutes"),
});

export const upsertPlaceInput = z.strictObject({
  id: ref.optional().describe("ID of an existing place to change. Leave it out to add a new place."),
  name: name.optional().describe("The place's name; required for a new place"),
  description: longText.optional().describe("What anyone there can see, in one to three sentences. No secrets. An empty string removes it."),
});

export const connectPlacesInput = z.strictObject({
  fromId: ref.describe("ID of one place"),
  toId: ref.describe("ID of the other place"),
  minutes: z.number().int().min(1).max(1440).describe("Minutes it takes to go between them"),
  locked: z.boolean().optional().describe(
    "Whether the way from fromId to toId starts blocked, until a challenge opens it. The way back stays open.",
  ),
  bothWays: z.boolean().optional().describe("Whether to connect both directions (default true)"),
});

export const disconnectPlacesInput = z.strictObject({
  fromId: ref.describe("ID of one place"),
  toId: ref.describe("ID of the other place"),
  bothWays: z.boolean().optional().describe("Whether to remove both directions (default true)"),
});

export const upsertItemInput = z.strictObject({
  id: ref.optional().describe("ID of an existing item to change. Leave it out to add a new item."),
  name: name.optional().describe("The item's name; required for a new item"),
  description: longText.optional().describe("What it looks like, briefly. An empty string removes it."),
});

const modifierInput = (slot: string) => z.number().int().min(-5).max(10).optional()
  .describe(`In a world with stats, its ${slot} stat (the ${slot} name in statNames): -1 weak, 0 average, 3 strong, 5 exceptional`);

export const upsertCharacterInput = z.strictObject({
  id: ref.optional().describe("ID of an existing character to change. Leave it out to add a new one."),
  name: name.optional().describe("Their name; required for a new character"),
  npc: z.boolean().optional().describe(
    "True for a supporting character the main characters meet, voiced by the game master; false for a main character (default)",
  ),
  placeId: ref.optional().describe("ID of the place they start in; required for a new character"),
  startsAway: z.boolean().optional().describe(
    "True if they start away from the scene, taking no part until a threat, the referee, or the director brings them in; "
    + "placeId is then where they would appear. False to start in the scene (default)",
  ),
  maxHp: z.number().int().min(1).max(100).optional().describe("In a world with health, the most they have; about 8 for the frail, 10 average, 14 tough"),
  hp: z.number().int().min(0).max(100).optional().describe("In a world with health, what they start with; defaults to maxHp"),
  strength: modifierInput("first"),
  dexterity: modifierInput("second"),
  wisdom: modifierInput("third"),
  itemIds: z.array(ref).max(20).optional().describe("IDs of the items they carry, replacing what they carried; repeat an ID to carry more than one"),
});

export const setPersonaInput = z.strictObject({
  characterId: ref.describe("ID of the main or supporting character"),
  summary: z.string().trim().min(1).max(500).optional().describe("Who they are, in a sentence or two"),
  voice: z.string().trim().min(1).max(500).optional().describe("How they speak, with some texture, e.g. \"warm, teasing, trails off when nervous\""),
  knownAs: z.string().trim().max(300).optional()
    .describe("Who they are to everyone else, e.g. \"the incident commander tonight\" or \"Sam's oldest friend\". Every AI reads it, so never a secret. An empty string removes it."),
  goals: lines(8, "Main characters only: what they want, one per line").optional(),
  riskTolerance: z.enum(["cautious", "balanced", "bold"]).optional().describe("Main characters only: their attitude to risk"),
  knowledge: lines(20, "NPCs only: what they know or believe, one per line. It may be wrong; that is how rumors work.").optional(),
  wants: lines(10, "NPCs only: what they want").optional(),
  agendaAims: lines(8, "NPCs only: aims they bring up unprompted when a main character is there. An empty list removes the agenda.").optional(),
  agendaEveryMinutes: z.number().int().min(1).max(1440).optional().describe("NPCs only: the fewest in-world minutes between unprompted remarks"),
});

export const upsertChallengeInput = z.strictObject({
  id: ref.optional().describe("ID of an existing challenge to change. Leave it out to add a new one."),
  name: name.optional().describe("A short imperative name, e.g. \"Pry open the bars\"; required for a new challenge"),
  description: longText.optional().describe("What it looks like to those present. An empty string removes it."),
  placeId: ref.optional().describe("ID of the place it is in; required for a new challenge"),
  ability: abilitySchema.optional().describe(
    "The stat it leans on: strength, dexterity, or wisdom stand for the first, second, and third stats. Required for a new challenge in a world with stats.",
  ),
  difficulty: difficultyBandSchema.optional().describe("How hard the check is; required for a new challenge"),
  criteria: longText.optional().describe(
    "What it takes to succeed, for the referee in a judgment world, in checkable terms: what the character must have found out, "
      + "carry, or say. Only the referee and the director read it. An empty string removes it.",
  ),
  minutes: z.number().int().min(1).max(60).optional().describe("Minutes an attempt takes; required for a new challenge"),
  failureDamage: z.number().int().min(0).max(100).optional().describe("Damage a failed attempt deals; 0 for none"),
  requiresItemId: z.string().trim().max(64).optional().describe("ID of an item the attempt needs. An empty string removes the need."),
  opensRoutes: z.array(routeInput).max(10).optional().describe("Blocked ways that success opens, replacing any listed before"),
  grantsItemIds: z.array(ref).max(10).optional().describe("Items that success gives the one who succeeds"),
  reveals: longText.optional().describe("A private discovery: something only the one who succeeds learns. An empty string removes it."),
  armsThreatIds: z.array(ref).max(10).optional().describe("Waiting threats that success sets in motion"),
  disarmsThreatIds: z.array(ref).max(10).optional().describe("Threats that success stops"),
  failureBlocksRoutes: z.array(routeInput).max(10).optional().describe("Ways that a failed attempt blocks"),
  failureArmsThreatIds: z.array(ref).max(10).optional().describe("Waiting threats that a failed attempt sets in motion"),
});

export const upsertThreatInput = z.strictObject({
  id: ref.optional().describe("ID of an existing threat to change. Leave it out to add a new one."),
  name: name.optional().describe("A short name for the director, e.g. \"The sluice opens\"; required for a new threat"),
  text: z.string().trim().min(1).max(500).optional().describe("What those it strikes notice when it happens; required for a new threat"),
  placeIds: z.array(ref).max(20).optional().describe("IDs of the places it strikes; an empty list means everywhere"),
  damage: z.number().int().min(0).max(100).optional().describe("Damage to each conscious character where it strikes; 0 for none"),
  blocksRoutes: z.array(routeInput).max(10).optional().describe("Ways it blocks when it happens"),
  opensRoutes: z.array(routeInput).max(10).optional().describe("Blocked ways it opens when it happens"),
  bringsIn: z.array(z.strictObject({ characterId: ref, placeId: ref })).max(10).optional()
    .describe("Characters away from the scene whom it brings in, each at a place, replacing the list; [] for none"),
  sendsAway: z.array(ref).max(10).optional()
    .describe("IDs of characters it sends out of the scene, replacing the list; [] for none"),
  startsAtMinute: z.number().int().min(1).max(1440).optional().describe(
    "Make it happen on its own at this minute of the story's clock. Give this or afterMinutes.",
  ),
  afterMinutes: z.number().int().min(1).max(1440).optional().describe(
    "Make it wait until a challenge's outcome sets it off, then happen this many minutes later. Give this or startsAtMinute.",
  ),
});

export const upsertEndingInput = z.strictObject({
  id: ref.optional().describe("ID of an existing ending to change. Leave it out to add a new one."),
  name: name.optional().describe("A short name, e.g. \"Together\" or \"Full outage\"; required for a new ending"),
  text: z.string().trim().min(1).max(MAX_ENDING_LENGTH).optional().describe(
    "The closing text everyone reads when the story ends this way, in one to three sentences; required for a new ending",
  ),
  challengeId: ref.optional().describe("End the story when this challenge succeeds or fails (see outcome). Give this or threatId."),
  outcome: z.enum(["success", "failure"]).optional().describe("With challengeId: whether its success or its failure ends the story (default success)"),
  threatId: ref.optional().describe("End the story when this threat happens. Give this or challengeId."),
});

export const removeKinds = ["place", "item", "character", "challenge", "threat", "ending", "persona"] as const;
export const removeInput = z.strictObject({
  kind: z.enum(removeKinds).describe("What to remove. \"persona\" removes only a character's persona, so no agent plays them."),
  id: ref.describe("Its ID"),
});

// ---------------------------------------------------------------------------
// Operations

export function setWorld(draft: Draft, raw: z.infer<typeof setWorldInput>): OperationResult {
  const input = checked(setWorldInput, raw);
  return edit(draft, ({ seed, cast }) => {
    const changed: string[] = [];
    if (input.name !== undefined) { seed.name = input.name; changed.push("title"); }
    if (input.premise !== undefined) { setOptional(cast, "premise", input.premise); changed.push("premise"); }
    if (input.narratorStyle !== undefined) { cast.narratorStyle = input.narratorStyle; changed.push("narrator style"); }
    if (input.secondsPerLine !== undefined) { seed.speechSeconds = input.secondsPerLine; changed.push("seconds per line"); }
    if (input.pace !== undefined) { cast.pace = input.pace; changed.push("pace"); }
    if (input.outcomes !== undefined || input.statNames !== undefined || input.healthName !== undefined) {
      const rules: WorldRules = { ...rulesOf(seed) };
      if (input.outcomes !== undefined) rules.outcomes = input.outcomes;
      if (input.statNames !== undefined) {
        const names = input.statNames;
        rules.stats = names && { strength: names[0]!, dexterity: names[1]!, wisdom: names[2]! };
      }
      if (input.healthName !== undefined) rules.health = input.healthName;
      seed.rules = rules;
      changed.push(`rules (${applyRules(seed)})`);
    }
    const rulingFields = [input.rulingAbilities, input.rulingMaxDifficulty, input.rulingMaxDamage, input.rulingMaxMinutes];
    if (input.openEndedActions === false) {
      delete seed.rulings;
      changed.push("no open-ended actions");
    } else if (input.openEndedActions === true || rulingFields.some((field) => field !== undefined)) {
      const harmless = rulesOf(seed).health === null;
      if (harmless && input.rulingMaxDamage) fail("This world has no health, so a failed attempt cannot deal damage.");
      const rulings = seed.rulings ?? {
        abilities: ["strength", "dexterity", "wisdom"], maxDifficulty: "hard", maxFailureDamage: harmless ? 0 : 3, maxSeconds: 600,
      };
      if (input.rulingAbilities) rulings.abilities = [...new Set(input.rulingAbilities)];
      if (input.rulingMaxDifficulty) rulings.maxDifficulty = input.rulingMaxDifficulty;
      if (input.rulingMaxDamage !== undefined) rulings.maxFailureDamage = input.rulingMaxDamage;
      if (input.rulingMaxMinutes !== undefined) rulings.maxSeconds = input.rulingMaxMinutes * 60;
      seed.rulings = rulings;
      changed.push("open-ended action limits");
    }
    return changed.length === 0 ? "Nothing changed." : `Set the ${changed.join(", ")}.`;
  });
}

/**
 * Makes the draft fit its rules: without stats every modifier is 0, and
 * without health everyone is unhurt and nothing deals damage. Returns the
 * rules in words, with what had to change.
 */
function applyRules(seed: DraftSeed): string {
  const rules = rulesOf(seed);
  const cleared: string[] = [];
  if (rules.stats === null) {
    const had = seed.characters.filter((character) => Object.values(character.modifiers).some((value) => value !== 0));
    for (const character of had) character.modifiers = { strength: 0, dexterity: 0, wisdom: 0 };
    if (had.length > 0) cleared.push(`cleared the stats of ${had.map((character) => character.name).join(", ")}`);
  }
  if (rules.health === null) {
    let removed = 0;
    for (const character of seed.characters) character.hp = character.maxHp;
    for (const challenge of seed.challenges) if (challenge.failureDamage > 0) { challenge.failureDamage = 0; removed += 1; }
    for (const threat of seed.threats ?? []) if (threat.damage !== undefined) { delete threat.damage; removed += 1; }
    if (seed.rulings && seed.rulings.maxFailureDamage > 0) { seed.rulings.maxFailureDamage = 0; removed += 1; }
    if (removed > 0) cleared.push(`removed ${removed} source${removed === 1 ? "" : "s"} of damage`);
  }
  const stats = rules.stats ? `stats ${rules.stats.strength}, ${rules.stats.dexterity}, ${rules.stats.wisdom}` : "no stats";
  const health = rules.health ? `${rules.health} as health` : "no health";
  return [`${rules.outcomes === "judgment" ? "judged by the referee" : "dice"}, ${stats}, ${health}`, ...cleared].join("; ");
}

export function upsertPlace(draft: Draft, raw: z.infer<typeof upsertPlaceInput>): OperationResult {
  const input = checked(upsertPlaceInput, raw);
  return edit(draft, ({ seed }) => {
    if (input.id !== undefined) {
      const existing = place(seed, input.id);
      if (input.name !== undefined) existing.name = input.name;
      setOptional(existing, "description", input.description);
      return `Updated place ${existing.name} (${existing.id}).`;
    }
    if (input.name === undefined) fail("A new place needs a name.");
    if (seed.locations.length >= DRAFT_LIMITS.places) fail(`A world can have at most ${DRAFT_LIMITS.places} places.`);
    const created = parseInput(locationSchema, {
      id: freshId(seed, input.name), name: input.name, routes: [], ...(input.description ? { description: input.description } : {}),
    });
    seed.locations.push(created);
    return `Added place ${created.name} (${created.id}).`;
  });
}

export function connectPlaces(draft: Draft, raw: z.infer<typeof connectPlacesInput>): OperationResult {
  const input = checked(connectPlacesInput, raw);
  return edit(draft, ({ seed }) => {
    if (input.fromId === input.toId) fail("A place cannot lead to itself.");
    const from = place(seed, input.fromId);
    const to = place(seed, input.toId);
    const connect = (source: typeof from, destinationId: string, locked: boolean | undefined) => {
      const existing = source.routes.find((route) => route.destinationId === destinationId);
      const route = existing ?? { destinationId, seconds: input.minutes * 60 };
      route.seconds = input.minutes * 60;
      if (locked !== undefined) setOptional(route, "locked", locked || null);
      if (!existing) source.routes.push(route);
    };
    connect(from, to.id, input.locked);
    if (input.bothWays !== false) connect(to, from.id, input.locked === undefined ? undefined : false);
    const direction = input.bothWays === false ? "→" : "↔";
    return `Connected ${from.name} ${direction} ${to.name} (${input.minutes} min${input.locked ? `, blocked from ${from.name} until opened` : ""}).`;
  });
}

export function disconnectPlaces(draft: Draft, raw: z.infer<typeof disconnectPlacesInput>): OperationResult {
  const input = checked(disconnectPlacesInput, raw);
  return edit(draft, ({ seed }) => {
    const from = place(seed, input.fromId);
    const to = place(seed, input.toId);
    from.routes = from.routes.filter((route) => route.destinationId !== to.id);
    if (input.bothWays !== false) to.routes = to.routes.filter((route) => route.destinationId !== from.id);
    dropRouteReferences(seed, (ref) => (ref.fromId === from.id && ref.destinationId === to.id)
      || (input.bothWays !== false && ref.fromId === to.id && ref.destinationId === from.id));
    return `Disconnected ${from.name} and ${to.name}.`;
  });
}

export function upsertItem(draft: Draft, raw: z.infer<typeof upsertItemInput>): OperationResult {
  const input = checked(upsertItemInput, raw);
  return edit(draft, ({ seed }) => {
    if (input.id !== undefined) {
      const existing = seed.items.find((item) => item.id === input.id) ?? fail(`There is no item with ID "${input.id}".`);
      if (input.name !== undefined) existing.name = input.name;
      setOptional(existing, "description", input.description);
      return `Updated item ${existing.name} (${existing.id}).`;
    }
    if (input.name === undefined) fail("A new item needs a name.");
    if (seed.items.length >= DRAFT_LIMITS.items) fail(`A world can have at most ${DRAFT_LIMITS.items} items.`);
    const created = parseInput(itemSchema, {
      id: freshId(seed, input.name), name: input.name, ...(input.description ? { description: input.description } : {}),
    });
    seed.items.push(created);
    return `Added item ${created.name} (${created.id}).`;
  });
}

export function upsertCharacter(draft: Draft, raw: z.infer<typeof upsertCharacterInput>): OperationResult {
  const input = checked(upsertCharacterInput, raw);
  return edit(draft, ({ seed, cast }) => {
    if (input.placeId !== undefined) place(seed, input.placeId);
    for (const itemId of input.itemIds ?? []) requireItem(seed, itemId);
    const inventory = input.itemIds && Object.fromEntries(
      [...new Set(input.itemIds)].map((itemId) => [itemId, input.itemIds!.filter((entry) => entry === itemId).length]),
    );
    let character = input.id === undefined ? undefined : seed.characters.find((entry) => entry.id === input.id);
    if (input.id !== undefined && !character) fail(`There is no character with ID "${input.id}".`);
    const created = !character;
    if (!character) {
      if (input.name === undefined || input.placeId === undefined) fail("A new character needs a name and a starting place.");
      if (seed.characters.length >= DRAFT_LIMITS.characters) fail(`A world can have at most ${DRAFT_LIMITS.characters} characters.`);
      character = {
        id: freshId(seed, input.name), name: input.name, locationId: input.placeId, hp: 10, maxHp: 10,
        modifiers: { strength: 0, dexterity: 0, wisdom: 0 }, inventory: {},
      };
      seed.characters.push(character);
    }
    const wasNpc = character.npc === true;
    if (input.name !== undefined) character.name = input.name;
    if (input.placeId !== undefined) character.locationId = input.placeId;
    if (input.npc !== undefined) setOptional(character, "npc", input.npc || null);
    if (input.startsAway !== undefined) setOptional(character, "away", input.startsAway || null);
    if (input.maxHp !== undefined) {
      character.maxHp = input.maxHp;
      if (input.hp === undefined && (created || character.hp > input.maxHp)) character.hp = input.maxHp;
    }
    const rules = rulesOf(seed);
    if (input.hp !== undefined) character.hp = input.hp;
    if (rules.health === null) character.hp = character.maxHp;
    if (character.hp > character.maxHp) fail(`${character.name} cannot have more than ${character.maxHp} hit points.`);
    for (const ability of ["strength", "dexterity", "wisdom"] as const) {
      if (input[ability] === undefined) continue;
      if (rules.stats === null && input[ability] !== 0) fail("This world has no stats. Name its stats first.");
      character.modifiers[ability] = input[ability];
    }
    if (inventory) character.inventory = inventory;
    parseInput(characterSchema, character);
    // A persona of the wrong kind cannot carry over between main and supporting characters.
    if (wasNpc !== (character.npc === true)) {
      delete cast.characters[character.id];
      if (cast.npcs) delete cast.npcs[character.id];
    }
    const kind = character.npc ? "supporting character" : "main character";
    return `${created ? "Added" : "Updated"} ${kind} ${character.name} (${character.id})${character.away ? ", away from the scene at the start" : ""}.`;
  });
}

/** The known-as line after an edit: unchanged when not given, removed when empty. */
function knownAsOf(input: string | undefined, existing: string | undefined): { knownAs?: string } {
  const knownAs = input ?? existing;
  return knownAs ? { knownAs } : {};
}

export function setPersona(draft: Draft, raw: z.infer<typeof setPersonaInput>): OperationResult {
  const input = checked(setPersonaInput, raw);
  return edit(draft, ({ seed, cast }) => {
    const character = seed.characters.find((entry) => entry.id === input.characterId)
      ?? fail(`There is no character with ID "${input.characterId}".`);
    if (character.npc) {
      const npcs = cast.npcs ?? {};
      const existing = npcs[character.id];
      const summary = input.summary ?? existing?.summary;
      const voice = input.voice ?? existing?.voice;
      if (!summary || !voice) fail(`A persona for ${character.name} needs a summary and a voice.`);
      const persona: Record<string, unknown> = {
        summary, voice, ...knownAsOf(input.knownAs, existing?.knownAs),
        knowledge: input.knowledge ?? existing?.knowledge ?? [], wants: input.wants ?? existing?.wants ?? [],
      };
      const aims = input.agendaAims ?? existing?.agenda?.aims ?? [];
      if (aims.length > 0) persona.agenda = { everyMinutes: input.agendaEveryMinutes ?? existing?.agenda?.everyMinutes ?? 10, aims };
      npcs[character.id] = parseInput(npcPersonaSchema, persona);
      cast.npcs = npcs;
    } else {
      const existing = cast.characters[character.id];
      const summary = input.summary ?? existing?.summary;
      const voice = input.voice ?? existing?.voice;
      const goals = input.goals ?? existing?.goals;
      if (!summary || !voice || !goals?.length) fail(`A persona for ${character.name} needs a summary, a voice, and at least one goal.`);
      cast.characters[character.id] = parseInput(personaSchema, {
        summary, voice, ...knownAsOf(input.knownAs, existing?.knownAs), goals, riskTolerance: input.riskTolerance ?? existing?.riskTolerance ?? "balanced",
      });
    }
    return `Wrote ${character.name}'s persona.`;
  });
}

export function upsertChallenge(draft: Draft, raw: z.infer<typeof upsertChallengeInput>): OperationResult {
  const input = checked(upsertChallengeInput, raw);
  return edit(draft, ({ seed }) => {
    if (input.placeId !== undefined) place(seed, input.placeId);
    if (input.requiresItemId) requireItem(seed, input.requiresItemId);
    for (const itemId of input.grantsItemIds ?? []) requireItem(seed, itemId);
    for (const threatId of [...input.armsThreatIds ?? [], ...input.failureArmsThreatIds ?? []]) {
      const threat = requireThreat(seed, threatId);
      if (threat.status !== "waiting") fail(`"${threat.name}" already happens on its own clock; only a waiting threat can be set off.`);
    }
    for (const threatId of input.disarmsThreatIds ?? []) requireThreat(seed, threatId);
    const rules = rulesOf(seed);
    if (rules.health === null && input.failureDamage) fail("This world has no health, so a failure cannot hurt anyone.");
    let challenge = input.id === undefined ? undefined : seed.challenges.find((entry) => entry.id === input.id);
    if (input.id !== undefined && !challenge) fail(`There is no challenge with ID "${input.id}".`);
    const created = !challenge;
    if (!challenge) {
      // Without stats, the stat a challenge leans on never matters.
      const ability = input.ability ?? (rules.stats === null ? "strength" : undefined);
      if (input.name === undefined || input.placeId === undefined || !ability || !input.difficulty || input.minutes === undefined) {
        fail(`A new challenge needs a name, a place, ${rules.stats ? "a stat, " : ""}a difficulty, and the minutes it takes.`);
      }
      if (seed.challenges.length >= DRAFT_LIMITS.challenges) fail(`A world can have at most ${DRAFT_LIMITS.challenges} challenges.`);
      challenge = {
        id: freshId(seed, input.name), name: input.name, locationId: input.placeId, ability,
        difficulty: BAND_DIFFICULTY[input.difficulty], seconds: input.minutes * 60, failureDamage: 0, resolved: false,
      };
      seed.challenges.push(challenge);
    }
    if (input.name !== undefined) challenge.name = input.name;
    setOptional(challenge, "description", input.description);
    setOptional(challenge, "criteria", input.criteria);
    if (input.placeId !== undefined) challenge.locationId = input.placeId;
    if (input.ability) challenge.ability = input.ability;
    if (input.difficulty) challenge.difficulty = BAND_DIFFICULTY[input.difficulty];
    if (input.minutes !== undefined) challenge.seconds = input.minutes * 60;
    if (input.failureDamage !== undefined) challenge.failureDamage = input.failureDamage;
    setOptional(challenge, "requiresItemId", input.requiresItemId);
    const success = challenge.onSuccess ?? {};
    if (input.opensRoutes) setOptional(success, "unlockRoutes", routeRefs(seed, input.opensRoutes));
    if (input.grantsItemIds) setOptional(success, "grantItems", input.grantsItemIds.map((itemId) => ({ itemId, quantity: 1 })));
    setOptional(success, "reveals", input.reveals);
    if (input.armsThreatIds) setOptional(success, "armThreats", [...new Set(input.armsThreatIds)]);
    if (input.disarmsThreatIds) setOptional(success, "disarmThreats", [...new Set(input.disarmsThreatIds)]);
    setOptional(challenge, "onSuccess", Object.keys(success).length > 0 ? success : null);
    const failure = challenge.onFailure ?? {};
    if (input.failureBlocksRoutes) setOptional(failure, "lockRoutes", routeRefs(seed, input.failureBlocksRoutes));
    if (input.failureArmsThreatIds) setOptional(failure, "armThreats", [...new Set(input.failureArmsThreatIds)]);
    setOptional(challenge, "onFailure", Object.keys(failure).length > 0 ? failure : null);
    parseInput(challengeSchema, challenge);
    return `${created ? "Added" : "Updated"} challenge "${challenge.name}" (${challenge.id}) at ${nameOf(seed, challenge.locationId)}.`;
  });
}

export function upsertThreat(draft: Draft, raw: z.infer<typeof upsertThreatInput>): OperationResult {
  const input = checked(upsertThreatInput, raw);
  return edit(draft, ({ seed }) => {
    for (const placeId of input.placeIds ?? []) place(seed, placeId);
    for (const entry of input.bringsIn ?? []) {
      requireCharacter(seed, entry.characterId);
      place(seed, entry.placeId);
    }
    for (const characterId of input.sendsAway ?? []) requireCharacter(seed, characterId);
    if (input.startsAtMinute !== undefined && input.afterMinutes !== undefined) {
      fail("A threat either happens at a set minute or waits to be set off: give startsAtMinute or afterMinutes, not both.");
    }
    if (rulesOf(seed).health === null && input.damage) fail("This world has no health, so a threat cannot hurt anyone.");
    const threats = seed.threats ?? [];
    let threat = input.id === undefined ? undefined : threats.find((entry) => entry.id === input.id);
    if (input.id !== undefined && !threat) fail(`There is no threat with ID "${input.id}".`);
    const created = !threat;
    if (!threat) {
      if (input.name === undefined || input.text === undefined) fail("A new threat needs a name and what people notice when it happens.");
      if (input.startsAtMinute === undefined && input.afterMinutes === undefined) {
        fail("Say when it happens: startsAtMinute for a set time, or afterMinutes once a challenge sets it off.");
      }
      if (threats.length >= DRAFT_LIMITS.threats) fail(`A world can have at most ${DRAFT_LIMITS.threats} threats.`);
      threat = { id: freshId(seed, input.name), name: input.name, text: input.text, status: "waiting" };
      threats.push(threat);
    }
    if (input.name !== undefined) threat.name = input.name;
    if (input.text !== undefined) threat.text = input.text;
    if (input.placeIds !== undefined) setOptional(threat, "locationIds", [...new Set(input.placeIds)]);
    if (input.damage !== undefined) setOptional(threat, "damage", input.damage || null);
    if (input.blocksRoutes) setOptional(threat, "lockRoutes", routeRefs(seed, input.blocksRoutes));
    if (input.opensRoutes) setOptional(threat, "unlockRoutes", routeRefs(seed, input.opensRoutes));
    if (input.bringsIn) {
      setOptional(threat, "enters", input.bringsIn.map((entry) => ({ characterId: entry.characterId, locationId: entry.placeId })));
    }
    if (input.sendsAway) setOptional(threat, "exits", [...new Set(input.sendsAway)]);
    if (input.startsAtMinute !== undefined) {
      threat.status = "armed";
      threat.at = input.startsAtMinute * 60;
      delete threat.delaySeconds;
    }
    if (input.afterMinutes !== undefined) {
      threat.status = "waiting";
      threat.delaySeconds = input.afterMinutes * 60;
      delete threat.at;
    }
    parseInput(threatSchema, threat);
    seed.threats = threats;
    const when = threat.status === "armed" ? `at minute ${threat.at! / 60}` : `${threat.delaySeconds! / 60} min after a challenge sets it off`;
    return `${created ? "Added" : "Updated"} threat "${threat.name}" (${threat.id}), ${when}.`;
  });
}

export function upsertEnding(draft: Draft, raw: z.infer<typeof upsertEndingInput>): OperationResult {
  const input = checked(upsertEndingInput, raw);
  return edit(draft, ({ seed }) => {
    if (input.challengeId !== undefined && input.threatId !== undefined) {
      fail("An ending waits on a challenge or on a threat: give challengeId or threatId, not both.");
    }
    if (input.challengeId !== undefined && !seed.challenges.some((challenge) => challenge.id === input.challengeId)) {
      fail(`There is no challenge with ID "${input.challengeId}".`);
    }
    if (input.threatId !== undefined) requireThreat(seed, input.threatId);
    const endings = seed.endings ?? [];
    let ending = input.id === undefined ? undefined : endings.find((entry) => entry.id === input.id);
    if (input.id !== undefined && !ending) fail(`There is no ending with ID "${input.id}".`);
    const created = !ending;
    const when = input.threatId !== undefined
      ? { threatId: input.threatId }
      : input.challengeId !== undefined ? { challengeId: input.challengeId, outcome: input.outcome ?? "success" } : undefined;
    if (!ending) {
      if (input.name === undefined || input.text === undefined || !when) {
        fail("A new ending needs a name, its closing text, and the challenge or threat that ends the story.");
      }
      if (endings.length >= DRAFT_LIMITS.endings) fail(`A world can have at most ${DRAFT_LIMITS.endings} endings.`);
      ending = { id: freshId(seed, input.name), name: input.name, text: input.text, when };
      endings.push(ending);
    }
    if (input.name !== undefined) ending.name = input.name;
    if (input.text !== undefined) ending.text = input.text;
    if (when) ending.when = when;
    else if (input.outcome !== undefined && "challengeId" in ending.when) ending.when = { ...ending.when, outcome: input.outcome };
    parseInput(endingSchema, ending);
    seed.endings = endings;
    const trigger = "threatId" in ending.when
      ? `when "${nameOf(seed, ending.when.threatId)}" happens`
      : `when "${nameOf(seed, ending.when.challengeId)}" ${ending.when.outcome === "success" ? "succeeds" : "fails"}`;
    return `${created ? "Added" : "Updated"} ending "${ending.name}" (${ending.id}), ${trigger}.`;
  });
}

/** Removes endings that wait on the given challenge or threat. */
function dropEndings(seed: DraftSeed, id: string): string[] {
  const dropped = (seed.endings ?? []).filter(({ when }) => ("threatId" in when ? when.threatId : when.challengeId) === id);
  seed.endings = (seed.endings ?? []).filter((ending) => !dropped.includes(ending));
  if (seed.endings.length === 0) delete seed.endings;
  return dropped.map((ending) => `"${ending.name}"`);
}

function alsoEndings(names: string[]): string {
  return names.length === 0 ? "" : ` Also removed the ending${names.length === 1 ? "" : "s"} waiting on it: ${names.join(", ")}.`;
}

/** Removes references to routes that no longer exist, or to the routes `matches` picks. */
function dropRouteReferences(seed: DraftSeed, matches: (ref: { fromId: string; destinationId: string }) => boolean): void {
  const keep = (refs: { fromId: string; destinationId: string }[] | undefined) => refs?.filter((ref) => !matches(ref));
  for (const challenge of seed.challenges) {
    if (challenge.onSuccess) setOptional(challenge.onSuccess, "unlockRoutes", keep(challenge.onSuccess.unlockRoutes));
    if (challenge.onFailure) setOptional(challenge.onFailure, "lockRoutes", keep(challenge.onFailure.lockRoutes));
    tidyOutcomes(challenge);
  }
  for (const threat of seed.threats ?? []) {
    setOptional(threat, "lockRoutes", keep(threat.lockRoutes));
    setOptional(threat, "unlockRoutes", keep(threat.unlockRoutes));
  }
}

function tidyOutcomes(challenge: DraftSeed["challenges"][number]): void {
  if (challenge.onSuccess && Object.keys(challenge.onSuccess).length === 0) delete challenge.onSuccess;
  if (challenge.onFailure && Object.keys(challenge.onFailure).length === 0) delete challenge.onFailure;
}

export function remove(draft: Draft, raw: z.infer<typeof removeInput>): OperationResult {
  const input = checked(removeInput, raw);
  return edit(draft, ({ seed, cast }) => {
    const label = nameOf(seed, input.id);
    switch (input.kind) {
      case "place": {
        place(seed, input.id);
        seed.locations = seed.locations.filter((location) => location.id !== input.id);
        for (const location of seed.locations) location.routes = location.routes.filter((route) => route.destinationId !== input.id);
        dropRouteReferences(seed, (ref) => ref.fromId === input.id || ref.destinationId === input.id);
        for (const threat of seed.threats ?? []) {
          setOptional(threat, "locationIds", threat.locationIds?.filter((id) => id !== input.id));
          setOptional(threat, "enters", threat.enters?.filter((entry) => entry.locationId !== input.id));
        }
        const stranded = [
          ...seed.characters.filter((character) => character.locationId === input.id).map((character) => character.name),
          ...seed.challenges.filter((challenge) => challenge.locationId === input.id).map((challenge) => `"${challenge.name}"`),
        ];
        return `Removed place ${label}.${stranded.length ? ` Still placed there, so move them: ${stranded.join(", ")}.` : ""}`;
      }
      case "item":
        requireItem(seed, input.id);
        seed.items = seed.items.filter((item) => item.id !== input.id);
        for (const character of seed.characters) delete character.inventory[input.id];
        for (const challenge of seed.challenges) {
          if (challenge.requiresItemId === input.id) delete challenge.requiresItemId;
          if (challenge.onSuccess) {
            setOptional(challenge.onSuccess, "grantItems", challenge.onSuccess.grantItems?.filter((grant) => grant.itemId !== input.id));
          }
          tidyOutcomes(challenge);
        }
        return `Removed item ${label}.`;
      case "character":
        if (!seed.characters.some((character) => character.id === input.id)) fail(`There is no character with ID "${input.id}".`);
        seed.characters = seed.characters.filter((character) => character.id !== input.id);
        for (const threat of seed.threats ?? []) {
          setOptional(threat, "enters", threat.enters?.filter((entry) => entry.characterId !== input.id));
          setOptional(threat, "exits", threat.exits?.filter((id) => id !== input.id));
        }
        delete cast.characters[input.id];
        if (cast.npcs) delete cast.npcs[input.id];
        return `Removed ${label}.`;
      case "challenge":
        if (!seed.challenges.some((challenge) => challenge.id === input.id)) fail(`There is no challenge with ID "${input.id}".`);
        seed.challenges = seed.challenges.filter((challenge) => challenge.id !== input.id);
        return `Removed challenge "${label}".${alsoEndings(dropEndings(seed, input.id))}`;
      case "threat":
        requireThreat(seed, input.id);
        seed.threats = seed.threats!.filter((threat) => threat.id !== input.id);
        if (seed.threats.length === 0) delete seed.threats;
        for (const challenge of seed.challenges) {
          const without = (ids: string[] | undefined) => ids?.filter((id) => id !== input.id);
          if (challenge.onSuccess) {
            setOptional(challenge.onSuccess, "armThreats", without(challenge.onSuccess.armThreats));
            setOptional(challenge.onSuccess, "disarmThreats", without(challenge.onSuccess.disarmThreats));
          }
          if (challenge.onFailure) setOptional(challenge.onFailure, "armThreats", without(challenge.onFailure.armThreats));
          tidyOutcomes(challenge);
        }
        return `Removed threat "${label}".${alsoEndings(dropEndings(seed, input.id))}`;
      case "ending":
        if (!seed.endings?.some((ending) => ending.id === input.id)) fail(`There is no ending with ID "${input.id}".`);
        seed.endings = seed.endings.filter((ending) => ending.id !== input.id);
        if (seed.endings.length === 0) delete seed.endings;
        return `Removed ending "${label}".`;
      case "persona": {
        const had = Boolean(cast.characters[input.id] ?? cast.npcs?.[input.id]);
        delete cast.characters[input.id];
        if (cast.npcs) delete cast.npcs[input.id];
        return had ? `Removed ${label}'s persona.` : `${label} had no persona.`;
      }
    }
  });
}

/** The draft as a world seed and cast, ready to create, under the given world ID; it throws if it is not ready. */
export function publishable(draft: Draft, worldId: string): { seed: WorldSeed; cast: Cast } {
  const errors = draftProblems(draft).filter((problem) => problem.severity === "error");
  if (errors.length > 0) fail(`The world is not ready: ${errors.map((problem) => problem.message).join(" ")}`);
  return { seed: parseInput(worldSeedSchema, { ...draft.seed, id: worldId }), cast: draft.cast };
}
