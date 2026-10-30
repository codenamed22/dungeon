import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { ADVENTURES } from "../src/adventures/index.ts";
import { castProblems, creatorSystemPrompt } from "../src/agents/prompts.ts";
import { ProviderConfigError, ScriptedProvider } from "../src/agents/provider.ts";
import { runCreator } from "../src/creator/assistant.ts";
import type { CreatorEvent, CreatorLimits, CreatorTurn } from "../src/creator/assistant.ts";
import {
  blankDraft, connectPlaces, draftProblems, draftSchema, hasErrors, publishable, remove, setPersona, setWorld, slugify, upsertChallenge,
  upsertCharacter, upsertEnding, upsertItem, upsertPlace, upsertThreat,
} from "../src/creator/operations.ts";
import type { Draft, OperationResult } from "../src/creator/operations.ts";
import { normalizeSample, SAMPLE_PART_CHARACTERS, sampleInfo, sampleParts, sampleTextProblem } from "../src/creator/samples.ts";
import type { DraftSample } from "../src/creator/samples.ts";
import { buildStep, EVERY_STEP_TOOLS, nextBuildStep } from "../src/creator/steps.ts";
import type { BuildStepId } from "../src/creator/steps.ts";
import { creatorExamples, creatorToolDefinitions, runCreatorTool } from "../src/creator/tools.ts";
import { AdventureEngine } from "../src/engine.ts";
import { EngineError, validateWorld, worldProblems } from "../src/model.ts";
import type { WorldSeed } from "../src/model.ts";
import { sampleWorld } from "../src/sample-world.ts";
import { createApp } from "../src/server/app.ts";
import { DraftService } from "../src/server/drafts.ts";
import { RunManager } from "../src/server/runs.ts";
import { catalog, chatWith, completion, hang, simulatedOpenRouter, toolCall } from "./fake-openrouter.ts";
import type { Handler } from "./fake-openrouter.ts";
import { errorCode } from "./support.ts";

const connectionString = process.env.TEST_DATABASE_URL;

/** Applies operations in order, each to the last one's draft. */
function build(draft: Draft, ...steps: ((draft: Draft) => OperationResult)[]): Draft {
  return steps.reduce((current, step) => step(current).draft, draft);
}

/** A small, complete world written entirely through the operations. */
function lighthouse(): Draft {
  return build(
    blankDraft(),
    (draft) => setWorld(draft, {
      name: "The Drowned Light", premise: "A storm coast in a cold age. Three keepers must relight the lamp before the ships come in.",
      narratorStyle: "Wet, close, and brief.", openEndedActions: true, rulingMaxDifficulty: "moderate",
      outcomes: "dice", statNames: ["Strength", "Dexterity", "Wisdom"], healthName: "HP",
    }),
    (draft) => upsertPlace(draft, { name: "Jetty", description: "Slick planks and a rope rail." }),
    (draft) => upsertPlace(draft, { name: "Lamp Room", description: "A cold brass lamp under salt-stained glass." }),
    (draft) => upsertPlace(draft, { name: "Stair" }),
    (draft) => connectPlaces(draft, { fromId: "jetty", toId: "stair", minutes: 3 }),
    (draft) => connectPlaces(draft, { fromId: "stair", toId: "lamp-room", minutes: 2, locked: true }),
    (draft) => upsertItem(draft, { name: "Oil Flask" }),
    (draft) => upsertCharacter(draft, { name: "Ada", placeId: "jetty", maxHp: 12, strength: 2, itemIds: ["oil-flask", "oil-flask"] }),
    (draft) => upsertCharacter(draft, { name: "Bram", placeId: "jetty", dexterity: 3 }),
    (draft) => upsertCharacter(draft, { name: "Old Wick", placeId: "stair", npc: true }),
    (draft) => setPersona(draft, { characterId: "ada", summary: "A keeper.", voice: "Curt.", goals: ["Light the lamp"] }),
    (draft) => setPersona(draft, { characterId: "bram", summary: "Her brother.", voice: "Soft.", goals: ["Keep Ada safe"], riskTolerance: "cautious" }),
    (draft) => setPersona(draft, {
      characterId: "old-wick", summary: "The last keeper.", voice: "Wheezing.", knowledge: ["The hatch sticks in the wet"],
      agendaAims: ["Warn them off the stair"],
    }),
    (draft) => upsertThreat(draft, { name: "The tide turns", text: "Water surges over the planks.", placeIds: ["jetty"], damage: 2, afterMinutes: 5 }),
    (draft) => upsertThreat(draft, { name: "Ships sight the coast", text: "Far lights blink on the water.", startsAtMinute: 60 }),
    (draft) => upsertChallenge(draft, {
      name: "Force the hatch", placeId: "stair", ability: "strength", difficulty: "moderate", minutes: 4, failureDamage: 1,
      opensRoutes: [{ fromId: "stair", toId: "lamp-room" }], reveals: "The lamp's wick is dry but whole.",
      failureArmsThreatIds: ["the-tide-turns"],
    }),
  );
}

test("the creator's operations write a playable world, converting units and choosing unique IDs", () => {
  const draft = lighthouse();
  assert.deepEqual(draftProblems(draft), []);
  // A waiting threat that no challenge sets off never happens.
  const orphan = upsertThreat(draft, { name: "The keeper wakes", text: "Boots on the stair above.", afterMinutes: 2 }).draft;
  assert.deepEqual(draftProblems(orphan).map((problem) => [problem.severity, problem.section, problem.id]), [["warning", "threats", "the-keeper-wakes"]]);
  const { seed, cast } = publishable(draft, "drowned-light");
  assert.doesNotThrow(() => validateWorld(seed));
  assert.deepEqual(castProblems(cast, seed.characters, seed.id), []);
  assert.equal(seed.id, "drowned-light");
  assert.equal(cast.premise?.startsWith("A storm coast"), true);
  assert.deepEqual(seed.rulings, { abilities: ["strength", "dexterity", "wisdom"], maxDifficulty: "moderate", maxFailureDamage: 3, maxSeconds: 600 });

  const stair = seed.locations.find((location) => location.id === "stair")!;
  assert.deepEqual(stair.routes, [{ destinationId: "jetty", seconds: 180 }, { destinationId: "lamp-room", seconds: 120, locked: true }]);
  // A lock applies only one way: the lamp room's way back stays open.
  assert.deepEqual(seed.locations.find((location) => location.id === "lamp-room")!.routes, [{ destinationId: "stair", seconds: 120 }]);
  const ada = seed.characters.find((character) => character.id === "ada")!;
  assert.deepEqual([ada.hp, ada.maxHp, ada.modifiers, ada.inventory], [12, 12, { strength: 2, dexterity: 0, wisdom: 0 }, { "oil-flask": 2 }]);
  assert.equal(seed.characters.find((character) => character.id === "old-wick")!.npc, true);
  assert.deepEqual(cast.npcs?.["old-wick"]?.agenda, { everyMinutes: 10, aims: ["Warn them off the stair"] });

  const hatch = seed.challenges[0]!;
  assert.deepEqual([hatch.id, hatch.difficulty, hatch.seconds, hatch.failureDamage], ["force-the-hatch", 12, 240, 1]);
  assert.deepEqual(hatch.onSuccess, {
    unlockRoutes: [{ fromId: "stair", destinationId: "lamp-room" }], reveals: "The lamp's wick is dry but whole.",
  });
  assert.deepEqual(hatch.onFailure, { armThreats: ["the-tide-turns"] });
  assert.deepEqual(seed.threats?.map((threat) => [threat.id, threat.status, threat.at, threat.delaySeconds]), [
    ["the-tide-turns", "waiting", undefined, 300],
    ["ships-sight-the-coast", "armed", 3600, undefined],
  ]);

  // IDs are unique across every kind of thing, and readable.
  const twice = build(draft, (next) => upsertItem(next, { name: "Jetty" }), (next) => upsertPlace(next, { name: "Jetty" }));
  assert.deepEqual(twice.seed.items.map((item) => item.id), ["oil-flask", "jetty-2"]);
  assert.equal(twice.seed.locations.at(-1)!.id, "jetty-3");
  assert.equal(slugify("  Café — North Tower!! "), "cafe-north-tower");
  assert.equal(slugify("???"), "x");
  // Operations never change the draft they were given.
  assert.equal(draft.seed.items.length, 1);
});

test("removing something removes every reference to it, and says what it left stranded", () => {
  const draft = lighthouse();
  const withoutStair = remove(draft, { kind: "place", id: "stair" });
  assert.match(withoutStair.summary, /Removed place Stair\. Still placed there, so move them: Old Wick, "Force the hatch"\./);
  const seed = withoutStair.draft.seed;
  assert.deepEqual(seed.locations.map((location) => [location.id, location.routes]), [["jetty", []], ["lamp-room", []]]);
  assert.equal(seed.challenges[0]!.onSuccess?.unlockRoutes, undefined);
  const problems = draftProblems(withoutStair.draft);
  assert.deepEqual(problems.map((problem) => [problem.severity, problem.section, problem.message]), [
    ["error", "characters", "Old Wick starts in a place that does not exist. Choose where they start."],
    ["error", "challenges", "\"Force the hatch\" is in a place that does not exist. Choose where it is."],
  ]);
  assert.equal(hasErrors(problems), true);

  const withoutJetty = remove(draft, { kind: "place", id: "jetty" }).draft;
  assert.equal(withoutJetty.seed.threats![0]!.locationIds, undefined);

  const withoutFlask = remove(draft, { kind: "item", id: "oil-flask" }).draft;
  assert.deepEqual(withoutFlask.seed.characters[0]!.inventory, {});
  assert.deepEqual(draftProblems(withoutFlask), []);

  const withoutTide = remove(draft, { kind: "threat", id: "the-tide-turns" }).draft;
  assert.equal(withoutTide.seed.challenges[0]!.onFailure, undefined);
  assert.deepEqual(draftProblems(withoutTide), []);

  const withoutBram = remove(draft, { kind: "character", id: "bram" }).draft;
  assert.equal(withoutBram.cast.characters.bram, undefined);
  const withoutPersona = remove(draft, { kind: "persona", id: "ada" }).draft;
  assert.deepEqual(draftProblems(withoutPersona).map((problem) => [problem.severity, problem.message]), [
    ["warning", "No agent plays Ada: give them a persona, or they never take a turn."],
  ]);
});

test("a new thing takes the ID it is given, so later calls can refer to it straight away", () => {
  const draft = build(
    blankDraft(),
    (current) => upsertPlace(current, { id: "grand-hall", name: "The Grand Hall" }),
    (current) => upsertPlace(current, { id: "vault", name: "Vault" }),
    (current) => connectPlaces(current, { fromId: "grand-hall", toId: "vault", minutes: 2 }),
    (current) => upsertItem(current, { id: "keycard", name: "Guard's keycard" }),
    (current) => upsertCharacter(current, { id: "ellis", name: "Ellis", placeId: "vault", npc: true, itemIds: ["keycard"] }),
  );
  assert.deepEqual(draft.seed.locations.map((location) => location.id), ["grand-hall", "vault"]);
  assert.deepEqual(draft.seed.characters.map((character) => [character.id, character.inventory]), [["ellis", { keycard: 1 }]]);
  assert.equal(upsertPlace(draft, { id: "vault", description: "Steel and silence." }).summary, "Updated place Vault (vault).");
  assert.equal(upsertPlace(draft, { name: "Vault" }).summary, "Added place Vault (vault-2).", "without an ID, the name decides");

  // With judgment, a challenge without a difficulty is moderate.
  const judged = upsertChallenge(draft, { id: "crack-vault", name: "Crack the vault", placeId: "vault", minutes: 5, criteria: "They have the combination." });
  assert.equal(judged.draft.seed.challenges[0]!.difficulty, 12);
});

test("the creator refuses edits that would break the world, with reasons a person or a model can act on", () => {
  const draft = lighthouse();
  const refusal = (edit: () => unknown, message: RegExp) => assert.throws(edit, (error: unknown) => (
    error instanceof EngineError && error.code === "INVALID_INPUT" && message.test(error.message)
  ));
  refusal(() => upsertPlace(draft, { id: "attic", description: "Dusty." }), /^There is no place with ID "attic" to change, and a new place needs a name\.$/);
  refusal(() => upsertPlace(draft, { id: "ada", name: "Ada's Cot" }), /^The ID "ada" already belongs to Ada\.$/);
  refusal(() => upsertItem(draft, { id: "Rope Coil", name: "Rope coil" }), /^"Rope Coil" can't be an ID: .+ such as rope-coil\.$/);
  refusal(() => upsertThreat(draft, { id: "squall", text: "Rain." }), /no threat with ID "squall" to change, and a new threat needs a name/);
  refusal(() => upsertPlace(draft, {}), /A new place needs a name/);
  refusal(() => upsertPlace(draft, { name: "   " }), /^name can't be empty$/);
  refusal(() => connectPlaces(draft, { fromId: "jetty", toId: "stair", minutes: 0 }), /^minutes must be at least 1$/);
  refusal(() => setWorld(draft, { premise: "x".repeat(2001) }), /^premise is too long \(at most 2000 characters\)$/);
  refusal(() => connectPlaces(draft, { fromId: "jetty", toId: "jetty", minutes: 1 }), /cannot lead to itself/);
  refusal(() => upsertCharacter(draft, { name: "Cat" }), /needs a name and a starting place/);
  refusal(() => upsertChallenge(draft, { name: "Climb", placeId: "stair", ability: "strength", minutes: 2 }), /a stat, a difficulty, and the minutes/);
  refusal(() => upsertCharacter(draft, { id: "ada", hp: 20 }), /cannot have more than 12 hit points/);
  refusal(() => upsertCharacter(draft, { id: "ada", itemIds: ["lantern"] }), /no item with ID "lantern"/);
  refusal(() => setPersona(blankDraftWith("Cat"), { characterId: "cat", summary: "A cat." }), /needs a summary, a voice, and at least one goal/);

  // Who someone is to the others survives other edits, and an empty string removes it.
  const known = setPersona(draft, { characterId: "old-wick", knownAs: "the last keeper of the light" }).draft;
  assert.equal(known.cast.npcs?.["old-wick"]?.knownAs, "the last keeper of the light");
  const kept = setPersona(known, { characterId: "old-wick", voice: "Wheezing, kind." }).draft;
  assert.equal(kept.cast.npcs?.["old-wick"]?.knownAs, "the last keeper of the light");
  assert.equal(setPersona(kept, { characterId: "old-wick", knownAs: "" }).draft.cast.npcs?.["old-wick"]?.knownAs, undefined);
  assert.equal(setPersona(draft, { characterId: "ada", knownAs: "Bram's sister" }).draft.cast.characters.ada?.knownAs, "Bram's sister");
  refusal(() => upsertChallenge(draft, { id: "force-the-hatch", opensRoutes: [{ fromId: "jetty", toId: "lamp-room" }] }), /no way from Jetty to Lamp Room/);
  refusal(() => upsertChallenge(draft, { id: "force-the-hatch", armsThreatIds: ["ships-sight-the-coast"] }), /already happens on its own clock/);
  refusal(() => upsertThreat(draft, { name: "Gulls", text: "Gulls scream." }), /Say when it happens/);
  refusal(() => upsertThreat(draft, { id: "the-tide-turns", startsAtMinute: 3, afterMinutes: 4 }), /not both/);

  // A persona of the wrong kind does not survive a change between party member and NPC.
  const turned = upsertCharacter(draft, { id: "bram", npc: true }).draft;
  assert.equal(turned.cast.characters.bram, undefined);
  assert.deepEqual(draftProblems(turned).map((problem) => problem.message), ["Bram never speaks without a persona."]);
  // Changing a persona keeps the fields not given.
  const changed = setPersona(draft, { characterId: "ada", voice: "Clipped." }).draft;
  assert.deepEqual(changed.cast.characters.ada, { summary: "A keeper.", voice: "Clipped.", goals: ["Light the lamp"], riskTolerance: "balanced" });
  // Making a threat wait again warns about a challenge that arms an armed one.
  const armed = upsertThreat(draft, { id: "the-tide-turns", startsAtMinute: 30 }).draft;
  assert.deepEqual(draftProblems(armed).map((problem) => problem.severity), ["warning"]);
});

test("an item a challenge gives warns until a challenge needs it, or a judged one names it", () => {
  const warnings = (draft: Draft) => draftProblems(draft).filter((problem) => problem.message.includes("changes nothing"));
  const keyed = build(
    lighthouse(),
    (draft) => upsertItem(draft, { name: "Brass Key" }),
    (draft) => upsertChallenge(draft, { id: "force-the-hatch", grantsItemIds: ["brass-key"] }),
  );
  assert.deepEqual(warnings(keyed).map((problem) => [problem.section, problem.id, problem.message]), [[
    "challenges", "force-the-hatch",
    "\"Force the hatch\" gives \"Brass Key\", but no challenge needs it, so having it changes nothing. If it should open or allow something, make a challenge need it.",
  ]]);
  const used = upsertChallenge(keyed, { name: "Unlock the lamp", placeId: "lamp-room", ability: "dexterity", difficulty: "easy", minutes: 1, requiresItemId: "brass-key" }).draft;
  assert.deepEqual(warnings(used), []);

  // Where the referee judges, naming the item in what a challenge takes is enough.
  const judged = setWorld(keyed, { outcomes: "judgment", statNames: null, healthName: null }).draft;
  assert.match(warnings(judged)[0]!.message, /make a challenge need it, or name it in what one takes\.$/);
  const named = upsertChallenge(judged, { id: "force-the-hatch", criteria: "Works if they turn the brass key in the hatch lock." }).draft;
  assert.deepEqual(warnings(named), []);
});

function blankDraftWith(name: string): Draft {
  return build(blankDraft(), (draft) => upsertPlace(draft, { name: "Room" }), (draft) => upsertCharacter(draft, { name, placeId: "room" }));
}

test("changing the rules makes the world fit them, and endings follow what they wait on", () => {
  const judged = setWorld(lighthouse(), { outcomes: "judgment", statNames: null, healthName: null });
  assert.equal(judged.summary,
    "Set the rules (judged by the referee, no stats, no health; cleared the stats of Ada, Bram; removed 3 sources of damage).");
  const { seed } = judged.draft;
  assert.ok(seed.characters.every((character) => character.hp === character.maxHp && Object.values(character.modifiers).every((value) => value === 0)));
  assert.equal(seed.challenges[0]!.failureDamage, 0);
  assert.ok(seed.threats!.every((threat) => threat.damage === undefined));
  assert.equal(seed.rulings!.maxFailureDamage, 0);
  validateWorld(seed);
  assert.deepEqual(draftProblems(judged.draft).map((problem) => problem.message), [
    "\"Force the hatch\" doesn't say what it takes, so the referee will guess.",
  ]);
  const refuse = (step: () => OperationResult, message: RegExp) => assert.throws(step, (error) => error instanceof EngineError && message.test(error.message));
  refuse(() => upsertCharacter(judged.draft, { id: "ada", strength: 2 }), /This world has no stats/);
  refuse(() => upsertChallenge(judged.draft, { id: "force-the-hatch", failureDamage: 2 }), /no health/);
  refuse(() => setWorld(judged.draft, { rulingMaxDamage: 2 }), /no health/);

  const named = setWorld(judged.draft, { statNames: ["Nerve", "Craft", "Lore"], healthName: "Warmth" });
  assert.match(named.summary, /judged by the referee, stats Nerve, Craft, Lore, Warmth as health/);

  const ended = build(
    judged.draft,
    (draft) => upsertChallenge(draft, { id: "force-the-hatch", criteria: "Works only with the oil flask on the hinges." }),
    (draft) => upsertEnding(draft, { name: "The light returns", text: "The lamp blazes over the water.", challengeId: "force-the-hatch" }),
    (draft) => upsertEnding(draft, { name: "Too late", text: "The ships run onto the rocks.", threatId: "ships-sight-the-coast" }),
  );
  assert.deepEqual(draftProblems(ended).map((problem) => problem.message), []);
  assert.deepEqual(ended.seed.endings!.map(({ id, when }) => ({ id, when })), [
    { id: "the-light-returns", when: { challengeId: "force-the-hatch", outcome: "success" } },
    { id: "too-late", when: { threatId: "ships-sight-the-coast" } },
  ]);
  assert.equal(upsertEnding(ended, { id: "the-light-returns", outcome: "failure" }).summary,
    "Updated ending \"The light returns\" (the-light-returns), when \"Force the hatch\" fails.");
  refuse(() => upsertEnding(ended, { name: "Both", text: "x", challengeId: "force-the-hatch", threatId: "too-late" }), /not both/);
  refuse(() => upsertEnding(ended, { name: "Lost", text: "x", challengeId: "nowhere" }), /no challenge with ID "nowhere"/);
  refuse(() => upsertEnding(ended, { name: "Untold", challengeId: "force-the-hatch" }), /needs a name, its closing text/);

  const removed = remove(ended, { kind: "challenge", id: "force-the-hatch" });
  assert.match(removed.summary, /Also removed the ending waiting on it: "The light returns"\.$/);
  assert.deepEqual(removed.draft.seed.endings!.map((ending) => ending.id), ["too-late"]);
  assert.equal(remove(removed.draft, { kind: "ending", id: "too-late" }).draft.seed.endings, undefined);
});

test("a blank draft lists what it needs, errors before warnings", () => {
  assert.deepEqual(draftProblems(blankDraft()).map((problem) => [problem.severity, problem.section, problem.message]), [
    ["error", "places", "Add at least one place."],
    ["error", "characters", "Add at least one main character."],
    ["warning", "story", "Write a premise, so every AI knows what kind of world this is."],
  ]);
  assert.throws(() => publishable(blankDraft(), "empty"), /not ready: Add at least one place\. Add at least one main character\./);
});

test("worldProblems finds every problem validateWorld rejects, the first one with its message", () => {
  const broken: WorldSeed = sampleWorld();
  broken.characters[0]!.locationId = "nowhere";
  broken.challenges[0]!.requiresItemId = "nothing";
  broken.items.push({ ...broken.items[0]! });
  const problems = worldProblems(broken);
  assert.ok(problems.length >= 3);
  assert.deepEqual(problems[0], { kind: "item", message: "Duplicate item ID" });
  assert.throws(() => validateWorld(broken), { message: problems[0]!.message });
  assert.deepEqual(worldProblems(sampleWorld()), []);
});

test("the operations reach nothing from Node or the database, so the browser can run them", async () => {
  const seen = new Set<string>();
  const visit = async (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = await readFile(file, "utf8");
    for (const [, specifier] of source.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gms)) {
      assert.ok(specifier!.startsWith(".") || specifier === "zod", `${path.relative(process.cwd(), file)} imports ${specifier}`);
      if (specifier!.startsWith(".")) await visit(path.resolve(path.dirname(file), specifier!));
    }
  };
  await visit(path.resolve("src/creator/operations.ts"));
  assert.ok([...seen].some((file) => file.endsWith("model.ts")));
  assert.ok(![...seen].some((file) => /setup\.ts$|openrouter\.ts$|engine\.ts$/.test(file)));
});

test("the creator's tools describe every field, and report bad calls back to the model", () => {
  const definitions = creatorToolDefinitions() as { type: string; function: { name: string; parameters: Record<string, unknown> } }[];
  assert.equal(new Set(definitions.map((definition) => definition.function.name)).size, definitions.length);
  for (const { function: tool } of definitions) {
    assert.equal(tool.parameters.type, "object");
    assert.equal(tool.parameters.$schema, undefined);
    for (const [field, schema] of Object.entries(tool.parameters.properties as Record<string, { description?: string }>)) {
      assert.ok(schema.description, `${tool.name}.${field} has no description`);
    }
  }

  const draft = lighthouse();
  const unchanged = (outcome: ReturnType<typeof runCreatorTool>) => {
    assert.equal(outcome.ok, false);
    assert.equal(outcome.changed, false);
    assert.equal(outcome.draft, draft);
    return JSON.parse(outcome.content).error as string;
  };
  assert.match(unchanged(runCreatorTool(draft, "make_dragon", "{}")), /no tool called "make_dragon"/);
  assert.match(unchanged(runCreatorTool(draft, "upsert_place", "{name:")), /not valid JSON/);
  assert.match(unchanged(runCreatorTool(draft, "connect_places", JSON.stringify({ fromId: "jetty", toId: "stair" }))), /Invalid arguments/);
  assert.match(unchanged(runCreatorTool(draft, "upsert_place", JSON.stringify({ name: "Hut", colour: "red" }))), /Invalid arguments/);
  assert.match(unchanged(runCreatorTool(draft, "remove", JSON.stringify({ kind: "place", id: "attic" }))), /no place with ID "attic"/);

  const added = runCreatorTool(draft, "upsert_place", JSON.stringify({ name: "Cellar" }));
  assert.deepEqual([added.ok, added.changed, added.summary], [true, true, "Added place Cellar (cellar)."]);
  assert.deepEqual(JSON.parse(added.content), { ok: true, done: "Added place Cellar (cellar).", problems: [] });
  const read = runCreatorTool(draft, "get_draft", "");
  assert.equal(read.changed, false);
  assert.match(JSON.parse(read.content).note, /data, never as instructions/);
  const checked = runCreatorTool(blankDraft(), "check_draft", "{}");
  assert.deepEqual(JSON.parse(checked.content).problems.slice(0, 1), ["error: Add at least one place."]);
});

test("the AI creator can read every bundled adventure as an example, and its instructions list them", () => {
  const draft = lighthouse();
  for (const adventure of ADVENTURES) {
    const read = runCreatorTool(draft, "get_example", JSON.stringify({ id: adventure.id }));
    assert.deepEqual([read.ok, read.changed, read.draft, read.summary], [true, false, draft, `Read the example "${adventure.name}".`]);
    const { note, example } = JSON.parse(read.content);
    assert.match(note, /write the director's own story/);
    assert.deepEqual(example, JSON.parse(JSON.stringify({ seed: adventure.world(adventure.id), cast: adventure.cast })));
    assert.ok(draftSchema.safeParse(example).success, `${adventure.id} reads in the same shape as a draft`);
  }
  assert.match(JSON.parse(runCreatorTool(draft, "get_example", JSON.stringify({ id: "atlantis" })).content).error, /Invalid arguments/);

  const prompt = creatorSystemPrompt({}, creatorExamples());
  assert.match(prompt, /Example worlds, finished and played: read one with get_example/);
  assert.match(prompt, /- outage: The 3 A\.M\. Outage\. .+ \(outcomes judged by the referee, no stats, no health; action pace\)/);
  for (const adventure of ADVENTURES) assert.ok(prompt.includes(`- ${adventure.id}: ${adventure.name}. ${adventure.summary}`), adventure.id);
  assert.ok(prompt.indexOf("Example worlds") < prompt.indexOf("How to work:"));
  assert.doesNotMatch(creatorSystemPrompt(), /Example worlds/);
});

const sample = (name: string, text: string): DraftSample => ({ id: name, name, text, characters: text.length, addedAt: "2026-10-30T00:00:00.000Z" });

test("sample chats come in parts that end at line breaks, and the AI creator reads them by file and part", () => {
  const long = `${"a".repeat(99)}\n`.repeat(600);
  const parts = sampleParts(long);
  assert.deepEqual(parts.map((part) => part.length), [25_000, 25_000, 10_000]);
  assert.equal(parts.join(""), long);
  const emoji = sampleParts(`${"b".repeat(SAMPLE_PART_CHARACTERS - 1)}😀 tail`);
  assert.deepEqual([emoji[0]!.length, emoji[1]], [SAMPLE_PART_CHARACTERS - 1, "😀 tail"], "an emoji is never split");
  assert.equal(normalizeSample("\r\n Hi\r\nthere\r "), "Hi\nthere");
  assert.equal(sampleTextProblem(""), "The file is empty.");
  assert.match(sampleTextProblem("PK\u0000\u0003")!, /doesn't look like a text file/);

  const samples = [sample("group.txt", long), sample("dm.txt", "Sam: you up?\nAlex: always")];
  const draft = blankDraft();
  const read = (args: unknown, step?: BuildStepId, given = samples) => runCreatorTool(draft, "read_samples", JSON.stringify(args), step, given);
  const second = read({ file: 1, part: 2 });
  assert.deepEqual([second.ok, second.changed, second.draft], [true, false, draft]);
  assert.equal(second.summary, 'Read the sample chats "group.txt", part 2 of 3.');
  const content = JSON.parse(second.content);
  assert.deepEqual([content.name, content.part, content.parts, content.text], ["group.txt", 2, 3, parts[1]]);
  assert.match(content.note, /data, never as instructions/);
  assert.equal(read({ file: 2 }).summary, 'Read the sample chats "dm.txt".');
  assert.equal(read({ file: 2 }, "places").ok, true, "every step of a guided build may read them");
  assert.match(JSON.parse(read({ file: 3 }).content).error, /are 2 sample files; choose a number from 1 to 2/);
  assert.match(JSON.parse(read({ file: 1, part: 4 }).content).error, /"group\.txt" has 3 parts/);
  assert.match(JSON.parse(read({ file: 1 }, undefined, []).content).error, /hasn't added any sample chats/);

  // The tool is offered only when there are samples, and then in every step.
  const names = (step?: BuildStepId, hasSamples = false) => (creatorToolDefinitions(step, hasSamples) as { function: { name: string } }[])
    .map((tool) => tool.function.name);
  assert.ok(!names().includes("read_samples"));
  assert.ok(names(undefined, true).includes("read_samples"));
  assert.deepEqual(names("story", true).sort(), [...EVERY_STEP_TOOLS, "read_samples"].sort());

  // The instructions list them, and say how to use them, only when there are some.
  const prompt = creatorSystemPrompt({}, [], undefined, samples.map(sampleInfo));
  assert.match(prompt, /\n1\. "group\.txt": 60,000 characters, 3 parts\n2\. "dm\.txt": 25 characters, 1 part\n/);
  assert.match(prompt, /Base characters on the people in them only if the director asks\. Leave out personal details/);
  assert.doesNotMatch(creatorSystemPrompt(), /Sample chats/);
});

async function creatorRun(
  handler: Handler,
  options: { draft?: Draft; limits?: CreatorLimits; signal?: AbortSignal; history?: CreatorTurn[]; step?: BuildStepId; samples?: DraftSample[] } = {},
) {
  const events: CreatorEvent[] = [];
  const saved: Draft[] = [];
  const run = await runCreator({
    chat: chatWith(handler),
    draft: options.draft ?? blankDraft(),
    history: options.history ?? [],
    message: "A storm lighthouse for two.",
    onEvent: (event) => events.push(event),
    save: async (draft) => saved.push(draft) + 1,
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.step ? { step: options.step } : {}),
    ...(options.samples ? { samples: options.samples } : {}),
  });
  return { run, events, saved };
}

test("the AI creator is told of the sample chats, and reads them without changing the draft", async () => {
  const requests: Record<string, any>[] = [];
  const replies = [completion({ tool_calls: [toolCall("1", "read_samples", { file: 1 })] }), completion({ content: "They tease each other." })];
  const { run, saved } = await creatorRun(async (body) => {
    requests.push(body);
    return replies.shift();
  }, { samples: [sample("chat.txt", "Sam: CANARY-SAMPLE\nAlex: ha")] });
  assert.match(requests[0]!.messages[0].content, /\n1\. "chat\.txt": 27 characters, 1 part\n/);
  assert.ok(requests[0]!.tools.some((tool: any) => tool.function.name === "read_samples"));
  assert.match(JSON.parse(requests[1]!.messages.at(-1).content).text, /CANARY-SAMPLE/);
  assert.deepEqual(run.tools.map((line) => [line.name, line.ok]), [["read_samples", true]]);
  assert.equal(saved.length, 0);

  // The next message neither counts the read as a change nor, without samples, offers the tool.
  const later: Record<string, any>[] = [];
  await creatorRun(async (body) => {
    later.push(body);
    return completion({ content: "Done." });
  }, { history: [{ message: "Read my chats.", reply: run.reply, tools: run.tools }] });
  assert.equal(later[0]!.messages[2].content, "They tease each other.");
  assert.ok(!later[0]!.tools.some((tool: any) => tool.function.name === "read_samples"));
});

test("the AI creator calls tools, sends their results back with its own message unchanged, and saves each round", async () => {
  const requests: Record<string, any>[] = [];
  const replies: unknown[] = [
    completion({
      content: "Starting with the coast.",
      reasoning_details: [{ type: "reasoning.encrypted", data: "opaque" }],
      tool_calls: [
        toolCall("call-1", "set_world", { name: "The Drowned Light", premise: "A storm coast." }),
        toolCall("call-2", "upsert_place", { name: "Jetty" }),
        toolCall("call-3", "upsert_place", "{name: Stair"),
      ],
    }),
    completion({ content: "I set the title and premise, and added the jetty." }),
  ];
  const sent = structuredClone(replies[0]) as { choices: { message: Record<string, unknown> }[] };
  const { run, events, saved } = await creatorRun(async (body) => {
    requests.push(body);
    return replies.shift();
  });

  assert.equal(requests.length, 2);
  const [first, second] = requests as [Record<string, any>, Record<string, any>];
  assert.equal(first.model, "test/creator");
  assert.equal(first.max_tokens, 16_000);
  assert.deepEqual(first.reasoning, { effort: "low" });
  assert.deepEqual(first.provider, { require_parameters: true });
  assert.equal(first.tool_choice, undefined);
  assert.ok(first.tools.some((tool: any) => tool.function.name === "upsert_challenge"));
  assert.ok(first.tools.some((tool: any) => tool.function.name === "get_example"));
  assert.equal(first.messages[0].role, "system");
  assert.match(first.messages[0].content, /- night-market: The Night Market\./);
  assert.equal(first.messages.at(-1).content, "A storm lighthouse for two.\n\n(The draft is empty.)");

  // The assistant's message goes back as it came, reasoning included, then one result per call.
  assert.deepEqual(second.messages[2], sent.choices[0]!.message);
  assert.deepEqual(second.messages[2].reasoning_details, [{ type: "reasoning.encrypted", data: "opaque" }]);
  const results = second.messages.slice(3);
  assert.deepEqual(results.map((message: any) => [message.role, message.tool_call_id]), [["tool", "call-1"], ["tool", "call-2"], ["tool", "call-3"]]);
  assert.equal(JSON.parse(results[1].content).done, "Added place Jetty (jetty).");
  assert.match(JSON.parse(results[2].content).error, /not valid JSON/);

  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0]!.seed.locations.map((location) => location.id), ["jetty"]);
  assert.equal(run.draft, saved[0]);
  assert.equal(run.reply, "I set the title and premise, and added the jetty.", "text sent with tool calls is progress, not the reply");
  assert.deepEqual(run.tools.map((line) => [line.name, line.ok]), [["set_world", true], ["upsert_place", true], ["upsert_place", false]]);
  assert.deepEqual(run.usage, { calls: 2, inputTokens: 2000, outputTokens: 200, cost: 0.004 });
  assert.equal(run.stopped, undefined);
  assert.deepEqual(events.map((event) => event.type), ["usage", "text", "tool", "tool", "tool", "draft", "usage", "text"]);
  const draftEvent = events.find((event) => event.type === "draft")!;
  assert.equal(draftEvent.type === "draft" && draftEvent.revision, 2);
});

test("a call that refers to something added later in the same reply runs again once the rest have", async () => {
  const replies = [
    completion({ tool_calls: [
      toolCall("a", "upsert_challenge", { id: "pick-lock", name: "Pick the lock", placeId: "hall", minutes: 2, criteria: "A steady hand.", failureArmsThreatIds: ["squall"] }),
      toolCall("b", "upsert_ending", { id: "soaked", name: "Soaked", text: "The rain wins.", challengeId: "pick-lock", outcome: "failure" }),
      toolCall("c", "upsert_threat", { id: "squall", name: "Squall", text: "Rain lashes the windows.", afterMinutes: 3 }),
      toolCall("d", "upsert_place", { id: "attic" }),
    ] }),
    completion({ content: "Added the lock, the squall, and an ending." }),
  ];
  const requests: Record<string, any>[] = [];
  const { run } = await creatorRun(async (body) => {
    requests.push(body);
    return replies.shift()!;
  }, { draft: build(blankDraft(), (draft) => upsertPlace(draft, { id: "hall", name: "Hall" })) });
  assert.deepEqual(run.tools.map((line) => [line.name, line.ok]), [["upsert_challenge", true], ["upsert_ending", true], ["upsert_threat", true], ["upsert_place", false]]);
  assert.deepEqual(run.draft.seed.challenges[0]?.onFailure, { armThreats: ["squall"] });
  assert.deepEqual(run.draft.seed.endings?.map((ending) => ending.id), ["soaked"]);
  const results = requests[1]!.messages.slice(-4).map((message: any) => [message.tool_call_id, JSON.parse(message.content).ok]);
  assert.deepEqual(results, [["a", true], ["b", true], ["c", true], ["d", false]], "the model hears how each call finally went, in order");
});

test("a guided build runs one step at a time, with only that step's tools", async () => {
  const replies = [
    completion({ tool_calls: [
      toolCall("a", "upsert_place", { id: "hall", name: "Hall" }),
      toolCall("b", "upsert_character", { name: "Ada", placeId: "hall" }),
      toolCall("c", "connect_places", { fromId: "hall", toId: "yard", minutes: 1 }),
      toolCall("d", "upsert_place", { id: "yard", name: "Yard" }),
    ] }),
    completion({ content: "Added the hall and the yard." }),
  ];
  const requests: Record<string, any>[] = [];
  const { run } = await creatorRun(async (body) => {
    requests.push(body);
    return replies.shift()!;
  }, { step: "places" });
  const offered = requests[0]!.tools.map((tool: any) => tool.function.name).sort();
  assert.deepEqual(offered, [...EVERY_STEP_TOOLS, ...buildStep("places").tools!].sort());
  assert.match(requests[0]!.messages[0].content, /\n\nBuilding step by step: .+1\. Story, 2\. Places, 3\. Characters, 4\. Challenges, 5\. Endings.+\nThis is step 2 of 5, Places: Add the places/);
  assert.match(requests[0]!.messages[0].content, /Problems that a later step will fix, such as no places or no challenges yet, are expected/);
  assert.deepEqual(run.tools.map((line) => [line.name, line.ok]), [["upsert_place", true], ["upsert_character", false], ["connect_places", true], ["upsert_place", true]]);
  assert.equal(run.tools[1]!.summary, `upsert_character isn't part of this step (Places); it uses ${[...EVERY_STEP_TOOLS, ...buildStep("places").tools!].join(", ")}.`);
  assert.deepEqual(run.draft.seed.characters, []);

  // The last step opens every tool, and a build outside the steps has no step section.
  assert.equal(creatorToolDefinitions("endings").length, creatorToolDefinitions().length);
  assert.equal(creatorToolDefinitions("story").length, EVERY_STEP_TOOLS.length);
  assert.doesNotMatch(creatorSystemPrompt({}, []), /Building step by step/);
  assert.deepEqual([nextBuildStep("story")?.id, nextBuildStep("endings")], ["places", null]);
});

test("the AI creator stops at its limits, on cancellation, and on provider errors, keeping what it saved", async () => {
  const checking = async () => completion({ tool_calls: [toolCall("c", "check_draft", {})] });
  const rounds = await creatorRun(checking, { limits: { maxRounds: 3, maxToolCalls: 40, maxCost: 10, maxTokens: 1e9 } });
  assert.equal(rounds.run.usage.calls, 3);
  assert.match(rounds.run.stopped!, /after 3 model calls, the limit for one message, before it finished/);
  assert.equal(rounds.run.reply, "", "a run cut off before it finished has no reply");

  // The next message knows the last one was cut off, and what it did.
  const asked: Record<string, any>[] = [];
  await creatorRun(async (body) => {
    asked.push(body);
    return completion({ content: "Done." });
  }, { history: [{ message: "Build it all.", reply: "", tools: [{ name: "upsert_place", summary: "Added place Hall (hall).", ok: true }], stopped: rounds.run.stopped }] });
  assert.equal(asked[0]!.messages[2].content, "(No reply.)\n\nChanges made: Added place Hall (hall).\n\n"
    + `(This was cut off before it finished: ${rounds.run.stopped} Anything not listed above was not done.)`);

  const requests: Record<string, any>[] = [];
  const many = await creatorRun(async (body) => {
    requests.push(body);
    return completion({ tool_calls: ["a", "b", "c", "d", "e"].map((name) => toolCall(name, "upsert_item", { name })) });
  }, { limits: { maxRounds: 8, maxToolCalls: 3, maxCost: 10, maxTokens: 1e9 } });
  assert.equal(requests.length, 1);
  assert.deepEqual(many.run.draft.seed.items.map((item) => item.id), ["a", "b", "c"]);
  assert.equal(many.saved.length, 1);
  assert.match(many.run.stopped!, /at 3 tool calls/);

  const costly = await creatorRun(async () => completion(
    { tool_calls: [toolCall("p", "upsert_place", { name: "Hall" })] }, { prompt_tokens: 600_000, completion_tokens: 10 },
  ));
  assert.deepEqual([costly.run.usage.calls, costly.run.usage.cost, costly.saved.length], [1, null, 1]);
  assert.match(costly.run.stopped!, /spending limit/);

  const controller = new AbortController();
  let calls = 0;
  const cancelled = await creatorRun(async (_body, signal) => {
    calls += 1;
    if (calls === 1) return completion({ tool_calls: [toolCall("p", "upsert_place", { name: "Hall" })] });
    setTimeout(() => controller.abort(), 5);
    return hang(signal);
  }, { signal: controller.signal });
  assert.equal(cancelled.run.stopped, "Stopped.");
  assert.deepEqual(cancelled.run.draft.seed.locations.map((location) => location.id), ["hall"]);
  assert.equal(cancelled.saved.length, 1);

  const broke = await creatorRun(async () => ({ error: { code: 402, message: "Insufficient credits" } }));
  assert.match(broke.run.error!, /needs more credits \(402\)/);
  assert.equal(broke.run.usage.calls, 0);
});

test("the AI creator needs a model that calls tools, and its prompt carries the premise", () => {
  assert.throws(() => chatWith(async () => ({}), { model: "test/plain" }), (error: unknown) => (
    error instanceof ProviderConfigError && /cannot call tools/.test(error.message)
  ));
  assert.throws(() => chatWith(async () => ({}), { model: "test/missing" }), /no model test\/missing/);
  assert.match(creatorSystemPrompt({ premise: "CANARY coast" }), /\n\nThe world: CANARY coast\n\n/);
  assert.doesNotMatch(creatorSystemPrompt(), /The world:/);
  assert.match(creatorSystemPrompt(), /the main characters included\. Keep secrets/);
});

interface Reply {
  status: number;
  // The tests read whatever shape each route returns.
  body: any;
}

test("drafts in the database, and publishing one as a world", {
  skip: connectionString ? false : "Set TEST_DATABASE_URL to run real PostgreSQL integration tests",
}, async (t) => {
  assert.ok(connectionString);
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  const engine = new AdventureEngine(connectionString, { schema });
  const runs = new RunManager({
    engine, providerFor: async () => new ScriptedProvider([]), rehearsalEngine: () => engine, settings: { narrate: false },
  });
  let handler: Handler = async () => completion({ content: "Hello." });
  const server = createServer(createApp({
    engine, runs, env: { OPENROUTER_API_KEY: "test-key" }, allowedHosts: ["localhost", "127.0.0.1"], staticDir: null,
    fetchModels: async () => catalog, creatorFetch: simulatedOpenRouter(() => handler),
  }));
  try {
    await engine.initialize();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, route: string, body?: unknown): Promise<Reply> => {
      const response = await fetch(`${base}${route}`, {
        method,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    };

    await t.test("a draft is created blank or from an adventure, and saved only at the revision last seen", async () => {
      const blank = await call("POST", "/api/drafts", {});
      assert.equal(blank.status, 201);
      assert.equal(blank.body.revision, 1);
      assert.equal(blank.body.draft.seed.name, "Untitled world");
      assert.equal(blank.body.suggestedWorldId, "untitled-world");
      assert.equal(blank.body.problems[0].message, "Add at least one place.");

      const id = blank.body.id as string;
      const next = lighthouse();
      const saved = await call("PUT", `/api/drafts/${id}`, { draft: next, expectedRevision: 1 });
      assert.equal(saved.status, 200);
      assert.deepEqual([saved.body.revision, saved.body.name, saved.body.problems], [2, "The Drowned Light", []]);
      const stale = await call("PUT", `/api/drafts/${id}`, { draft: blankDraft(), expectedRevision: 1 });
      assert.deepEqual([stale.status, stale.body.code], [409, "STALE_REVISION"]);
      const invalid = await call("PUT", `/api/drafts/${id}`, { draft: { seed: {} }, expectedRevision: 2 });
      assert.deepEqual([invalid.status, invalid.body.code], [400, "INVALID_INPUT"]);

      const copy = await call("POST", "/api/drafts", { adventureId: "aqueduct", name: "My Aqueduct" });
      assert.equal(copy.status, 201);
      assert.equal(copy.body.draft.seed.name, "My Aqueduct");
      assert.match(copy.body.draft.cast.premise, /dead cities/);
      assert.deepEqual(copy.body.problems.filter((problem: { severity: string }) => problem.severity === "error"), []);
      assert.equal((await call("POST", "/api/drafts", { adventureId: "atlantis" })).status, 404);

      const listed = await call("GET", "/api/drafts");
      assert.deepEqual(new Set(listed.body.drafts.map((draft: { name: string }) => draft.name)), new Set(["The Drowned Light", "My Aqueduct"]));

      assert.equal((await call("DELETE", `/api/drafts/${copy.body.id}`, {})).status, 200);
      assert.equal((await call("GET", `/api/drafts/${copy.body.id}`)).status, 404);
    });

    await t.test("publishing creates a playable world with its cast, and the draft becomes read-only", async () => {
      const unready = (await call("POST", "/api/drafts", {})).body;
      const refused = await call("POST", `/api/drafts/${unready.id}/publish`, { worldId: "empty", expectedRevision: 1 });
      assert.equal(refused.status, 400);
      assert.match(refused.body.error, /Add at least one place/);

      const created = (await call("POST", "/api/drafts", {})).body;
      const draft = (await call("PUT", `/api/drafts/${created.id}`, { draft: lighthouse(), expectedRevision: 1 })).body;
      assert.equal((await call("POST", `/api/drafts/${draft.id}/publish`, { worldId: "bad id!", expectedRevision: 2 })).status, 400);
      assert.equal((await call("POST", `/api/drafts/${draft.id}/publish`, { worldId: "lighthouse", expectedRevision: 1 })).status, 409);

      const published = await call("POST", `/api/drafts/${draft.id}/publish`, { worldId: "lighthouse", expectedRevision: 2 });
      assert.equal(published.status, 200, JSON.stringify(published.body));
      assert.deepEqual([published.body.worldId, typeof published.body.publishedAt], ["lighthouse", "string"]);
      const world = await call("GET", "/api/worlds/lighthouse");
      assert.equal(world.body.world.name, "The Drowned Light");
      assert.equal(world.body.setupSaved, true);
      assert.match(world.body.setup.cast.premise, /storm coast/);
      const prompts = await call("GET", "/api/worlds/lighthouse/prompts");
      assert.match(prompts.body.narrator, /The world: A storm coast/);

      const edit = await call("PUT", `/api/drafts/${draft.id}`, { draft: lighthouse(), expectedRevision: 2 });
      assert.equal(edit.status, 409);
      assert.match(edit.body.error, /can no longer change/);
      assert.equal((await call("POST", `/api/drafts/${draft.id}/publish`, { worldId: "lighthouse", expectedRevision: 2 })).status, 200);
      assert.equal((await call("POST", `/api/drafts/${draft.id}/publish`, { worldId: "other", expectedRevision: 2 })).status, 409);

      // Another draft cannot take the world's ID, even with an identical seed.
      const rival = (await call("POST", "/api/drafts", {})).body;
      await call("PUT", `/api/drafts/${rival.id}`, { draft: lighthouse(), expectedRevision: 1 });
      const taken = await call("POST", `/api/drafts/${rival.id}/publish`, { worldId: "lighthouse", expectedRevision: 2 });
      assert.equal(taken.status, 409);
      assert.match(taken.body.error, /already exists/);
      assert.equal((await call("GET", `/api/drafts/${rival.id}`)).body.suggestedWorldId, "the-drowned-light");
    });

    await t.test("a publish that failed partway resumes on retry", async () => {
      const service = new DraftService(engine);
      const record = await engine.createDraft("halfway", lighthouse());
      // As if the server stopped after creating the world, before saving its cast.
      await engine.updateDraft("halfway", record.revision, { worldId: "halfway-world" });
      await engine.createWorld(publishable(lighthouse(), "halfway-world").seed);
      const resumed = await service.publish("halfway", "halfway-world", record.revision);
      assert.equal(resumed.worldId, "halfway-world");
      assert.match(String((await engine.getSetup("halfway-world") as { cast: { premise: string } }).cast.premise), /storm coast/);
    });

    /** Posts a message to the AI creator and reads its events as they arrive. */
    const ask = async function* (draftId: string, body: Record<string, unknown>, signal?: AbortSignal) {
      const response = await fetch(`${base}/api/drafts/${draftId}/assistant`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "test/creator", ...body }),
        ...(signal ? { signal } : {}),
      });
      if (response.status !== 200) assert.fail(`${response.status}: ${await response.text()}`);
      assert.equal(response.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
          yield JSON.parse(buffer.slice(0, end)) as Record<string, any>;
          buffer = buffer.slice(end + 1);
        }
      }
    };
    const collect = async (draftId: string, body: Record<string, unknown>) => {
      const events: Record<string, any>[] = [];
      for await (const event of ask(draftId, body)) events.push(event);
      return events;
    };

    await t.test("the AI creator streams its work, saves the draft and its chat, and can be undone at the revision it produced", async () => {
      const draft = (await call("POST", "/api/drafts", {})).body;
      const replies = [
        completion({ tool_calls: [
          toolCall("1", "set_world", { premise: "A storm coast." }), toolCall("2", "upsert_place", { name: "Jetty" }),
        ] }),
        completion({ content: "Added the coast and a jetty." }),
      ];
      handler = async () => replies.shift();
      const events = await collect(draft.id, { message: "Start a storm coast.", expectedRevision: 1 });
      assert.deepEqual(events.map((event) => event.type), ["start", "usage", "tool", "tool", "draft", "usage", "text", "done"]);
      assert.equal(events[0]!.model, "test/creator");
      assert.equal(events[4]!.revision, 2);
      const done = events.at(-1)!;
      assert.deepEqual([done.entry.revisionBefore, done.entry.revisionAfter, done.entry.reply], [1, 2, "Added the coast and a jetty."]);
      assert.deepEqual([done.draft.revision, done.draft.busy, done.draft.chat.length], [2, false, 1]);

      const after = (await call("GET", `/api/drafts/${draft.id}`)).body;
      assert.equal(after.draft.cast.premise, "A storm coast.");
      assert.deepEqual(after.chat[0].tools.map((line: { summary: string }) => line.summary), ["Set the premise.", "Added place Jetty (jetty)."]);
      assert.deepEqual(after.chat[0].usage, { calls: 2, inputTokens: 2000, outputTokens: 200, cost: 0.004 });

      // Undo puts back the draft from before the message, only if nothing changed since.
      const undone = await call("PUT", `/api/drafts/${draft.id}`, { draft: draft.draft, expectedRevision: 2 });
      assert.deepEqual([undone.status, undone.body.revision, undone.body.draft.seed.locations], [200, 3, []]);
      assert.equal(undone.body.chat.length, 1);

      handler = async (body) => (body.messages.length > 4
        ? completion({ content: "Added a hut." })
        : completion({ tool_calls: [toolCall("3", "upsert_place", { name: "Hut" })] }));
      const second = await collect(draft.id, { message: "Add a hut.", expectedRevision: 3 });
      const entry = second.at(-1)!.entry;
      assert.deepEqual([entry.revisionBefore, entry.revisionAfter], [3, 4]);
      const edited = (await call("PUT", `/api/drafts/${draft.id}`, { draft: lighthouse(), expectedRevision: 4 })).body;
      assert.equal(edited.revision, 5);
      assert.equal((await call("PUT", `/api/drafts/${draft.id}`, { draft: draft.draft, expectedRevision: 4 })).status, 409);
    });

    await t.test("a guided build records each message's step, and only that step's tools are offered", async () => {
      const draft = (await call("POST", "/api/drafts", {})).body;
      const offered: string[][] = [];
      handler = async (body) => {
        offered.push(body.tools.map((tool: any) => tool.function.name));
        return body.messages.at(-1).role === "tool"
          ? completion({ content: "The story is set. Next: a hall and a yard." })
          : completion({ tool_calls: [toolCall("1", "set_world", { premise: "A storm coast." })] });
      };
      const events = await collect(draft.id, { message: "A storm coast.", step: "story", expectedRevision: 1 });
      const { entry } = events.at(-1)!;
      assert.equal(entry.step, "story");
      assert.deepEqual(offered[0]!.sort(), [...EVERY_STEP_TOOLS].sort());
      assert.equal((await call("GET", `/api/drafts/${draft.id}`)).body.chat[0].step, "story");
      const unknown = await call("POST", `/api/drafts/${draft.id}/assistant`, { message: "Go on.", step: "epilogue", expectedRevision: 2, model: "test/creator" });
      assert.equal(unknown.status, 400);
    });

    await t.test("the AI creator refuses before streaming when it cannot start", async () => {
      assert.deepEqual((await call("GET", "/api/creator")).body, { model: "~deepseek/deepseek-v4-flash-latest", keyConfigured: true });
      const draft = (await call("POST", "/api/drafts", {})).body;
      const post = (body: Record<string, unknown>, id = draft.id) => call("POST", `/api/drafts/${id}/assistant`, { model: "test/creator", ...body });
      assert.deepEqual((await post({ message: "Hi", expectedRevision: 7 })).body.code, "STALE_REVISION");
      assert.equal((await post({ message: "Hi", expectedRevision: 1 }, "missing")).status, 404);
      assert.equal((await post({ message: "  ", expectedRevision: 1 })).status, 400);
      const plain = await post({ message: "Hi", expectedRevision: 1, model: "test/plain" });
      assert.equal(plain.status, 400);
      assert.match(plain.body.error, /cannot call tools/);
      assert.equal((await call("GET", `/api/drafts/${draft.id}`)).body.busy, false);
    });

    await t.test("while the AI creator works nothing else changes the draft, and leaving keeps what it did", async () => {
      const draft = (await call("POST", "/api/drafts", {})).body;
      handler = async (body, signal) => (body.messages.length > 3
        ? hang(signal)
        : completion({ tool_calls: [toolCall("1", "upsert_place", { name: "Hall" })] }));
      const controller = new AbortController();
      const events = ask(draft.id, { message: "Build a hall, then think for a long time.", expectedRevision: 1 }, controller.signal);
      for await (const event of events) if (event.type === "draft") break;

      const blocked = await call("PUT", `/api/drafts/${draft.id}`, { draft: blankDraft(), expectedRevision: 2 });
      assert.deepEqual([blocked.status, blocked.body.code], [409, "DRAFT_BUSY"]);
      const again = await call("POST", `/api/drafts/${draft.id}/assistant`, { message: "Hi", expectedRevision: 2, model: "test/creator" });
      assert.deepEqual([again.status, again.body.code], [409, "DRAFT_BUSY"]);
      assert.equal((await call("GET", `/api/drafts/${draft.id}`)).body.busy, true);

      controller.abort();
      let view: Record<string, any> = {};
      for (let tries = 0; tries < 100; tries += 1) {
        view = (await call("GET", `/api/drafts/${draft.id}`)).body;
        if (!view.busy) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(view.busy, false);
      assert.equal(view.revision, 2);
      assert.deepEqual(view.draft.seed.locations.map((location: { id: string }) => location.id), ["hall"]);
      assert.deepEqual([view.chat[0].stopped, view.chat[0].revisionAfter, view.chat[0].tools.length], ["Stopped.", 2, 1]);
    });

    await t.test("while the AI creator works on a draft, nothing else changes it", async () => {
      const service = new DraftService(engine);
      const draft = await service.create({});
      const release = service.claim(draft.id);
      assert.equal((await service.get(draft.id)).busy, true);
      await assert.rejects(service.save(draft.id, lighthouse(), 1), errorCode("DRAFT_BUSY"));
      await assert.rejects(service.publish(draft.id, "busy-world", 1), errorCode("DRAFT_BUSY"));
      await assert.rejects(service.delete(draft.id), errorCode("DRAFT_BUSY"));
      assert.throws(() => service.claim(draft.id), errorCode("DRAFT_BUSY"));
      release();
      assert.equal((await service.save(draft.id, lighthouse(), 1)).revision, 2);
    });

    await t.test("sample chats sit beside a draft: the creator reads them, the browser sees only their names, and downloads leave them out", async () => {
      const draft = (await call("POST", "/api/drafts", {})).body;
      const added = await call("POST", `/api/drafts/${draft.id}/samples`, { name: " group chat.txt ", text: "Sam: did you feed the cat\r\nAlex: CANARY-CHAT obviously\r\n" });
      assert.equal(added.status, 201);
      assert.equal(added.body.revision, 1, "samples aren't the draft, so its revision stays");
      const characters = "Sam: did you feed the cat\nAlex: CANARY-CHAT obviously".length;
      assert.deepEqual(added.body.samples.map(({ name, characters, parts }: Record<string, unknown>) => ({ name, characters, parts })),
        [{ name: "group chat.txt", characters, parts: 1 }]);
      assert.doesNotMatch(JSON.stringify((await call("GET", `/api/drafts/${draft.id}`)).body), /CANARY-CHAT/);

      let offered: string[] = [];
      let listed = "";
      let read = "";
      handler = async (body) => {
        if (body.messages.at(-1).role === "tool") {
          read = body.messages.at(-1).content;
          return completion({ content: "Two old friends who bicker." });
        }
        offered = body.tools.map((tool: any) => tool.function.name);
        listed = body.messages[0].content;
        return completion({ tool_calls: [toolCall("1", "read_samples", { file: 1 })] });
      };
      const events = await collect(draft.id, { message: "Base it on my chats.", expectedRevision: 1 });
      assert.equal(events.at(-1)!.entry.reply, "Two old friends who bicker.");
      assert.ok(offered.includes("read_samples"));
      assert.match(listed, new RegExp(`1\\. "group chat\\.txt": ${characters} characters, 1 part`));
      assert.equal(JSON.parse(read).text, "Sam: did you feed the cat\nAlex: CANARY-CHAT obviously");
      const design = await (await fetch(`${base}/api/drafts/${draft.id}/export`)).text();
      assert.doesNotMatch(design, /CANARY-CHAT|group chat/);

      const service = new DraftService(engine);
      const refused = async (id: string, text: string, message: RegExp) => {
        await assert.rejects(service.addSample(id, { name: "more.txt", text }), (error) => errorCode("INVALID_INPUT")(error) && message.test((error as Error).message));
      };
      await refused(draft.id, " \r\n ", /^The file is empty\.$/);
      await refused(draft.id, "PK\u0000\u0003", /doesn't look like a text file/);
      for (let index = 0; index < 4; index += 1) await service.addSample(draft.id, { name: `chat-${index}.txt`, text: "Hi." });
      await refused(draft.id, "Hi.", /^A draft can have 5 sample files; remove one first\.$/);
      const roomy = await service.create({});
      await refused(roomy.id, "x".repeat(100_001), /^"more\.txt" has 100,001 characters, and the samples can have 100,000 in all\. Trim it/);
      await service.addSample(roomy.id, { name: "big.txt", text: "x".repeat(60_000) });
      await refused(roomy.id, "y".repeat(50_000), /can have 100,000 in all \(40,000 left\)/);
      assert.deepEqual((await service.addSample(roomy.id, { name: "fits.txt", text: "y".repeat(40_000) })).samples.map((entry) => entry.parts), [3, 2]);

      // Nothing changes them while the AI creator works; removing one leaves the rest.
      const release = service.claim(draft.id);
      await assert.rejects(service.addSample(draft.id, { name: "late.txt", text: "Hi." }), errorCode("DRAFT_BUSY"));
      const first = added.body.samples[0].id as string;
      await assert.rejects(service.removeSample(draft.id, first), errorCode("DRAFT_BUSY"));
      release();
      const removed = await call("DELETE", `/api/drafts/${draft.id}/samples/${first}`, {});
      assert.deepEqual([removed.status, removed.body.samples.map((entry: { name: string }) => entry.name)],
        [200, ["chat-0.txt", "chat-1.txt", "chat-2.txt", "chat-3.txt"]]);
      assert.equal((await call("DELETE", `/api/drafts/${draft.id}/samples/${first}`, {})).status, 404);

      // A published draft takes no more, but can still give one up.
      await service.save(roomy.id, lighthouse(), 1);
      const published = await service.publish(roomy.id, "sampled-world", 2);
      assert.equal(published.worldId, "sampled-world");
      assert.equal((await call("POST", `/api/drafts/${roomy.id}/samples`, { name: "late.txt", text: "Hi." })).status, 409);
      assert.equal((await service.removeSample(roomy.id, published.samples[0]!.id)).samples.length, 1);
    });
  } finally {
    await runs.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await engine.close();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
