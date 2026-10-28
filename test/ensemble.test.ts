import assert from "node:assert/strict";
import test from "node:test";
import { starterWorld } from "../src/adventures/starter.ts";
import { commandSchema, parseInput } from "../src/model.ts";
import type { RulingInput, WorldSeed, WorldState } from "../src/model.ts";
import { applyEvent, checkRuling, Replayer, resolveCommand } from "../src/rules.ts";
import { sampleWorld } from "../src/sample-world.ts";
import { commitTurn, creationEvent, errorCode, fixed, initialState, nextEvent, NOW } from "./support.ts";

const npcCommand = (state: WorldState, input: Record<string, unknown>) => resolveCommand(state, parseInput(commandSchema, {
  role: "npc", requestId: "npc", expectedRevision: state.revision, actorId: "tamsin", ...input,
}), { roll: fixed(10), recordedAt: NOW });

/** The starter world with Bram moved to the aqueduct mouth, beside Elowen and the bars. */
function atTheBars(seed: WorldSeed = starterWorld("rulings")): WorldState {
  return commitTurn(initialState(seed), { actorId: "bram", action: { type: "move", destinationId: "mouth" } }).state;
}

const climb: RulingInput = {
  decision: "new", name: "Climb the arch", ability: "dexterity", difficulty: "hard", failureDamage: 2, seconds: 180,
  reason: "Crumbling brick.",
};

test("speech can be addressed to one conscious person present", () => {
  const state = initialState(sampleWorld("address"));
  const [said] = commitTurn(state, { speech: "Bram?", addresseeId: "bram" }).committed;
  assert.deepEqual(said?.event.data, { type: "utterance", actorId: "mira", locationId: "gate", text: "Bram?", seconds: 10, addresseeId: "bram" });
  assert.deepEqual(said?.perceivers, ["bram", "mira"]);
  for (const addresseeId of ["elowen", "mira", "nobody"]) {
    assert.throws(() => commitTurn(state, { speech: "Hey.", addresseeId }), errorCode("INVALID_ACTION"));
  }
  const fallen = structuredClone(state);
  fallen.characters.find((character) => character.id === "bram")!.hp = 0;
  assert.throws(() => commitTurn(fallen, { speech: "Bram?", addresseeId: "bram" }), /bram is not here to hear mira/);
  assert.throws(() => commitTurn(state, { addresseeId: "bram", action: { type: "wait", seconds: 60 } }), errorCode("INVALID_INPUT"));
  // Replay applies the same rule.
  const forged = nextEvent(state, { type: "utterance", actorId: "mira", locationId: "gate", text: "Hi.", seconds: 10, addresseeId: "elowen" });
  assert.throws(() => applyEvent(state, forged), errorCode("CORRUPT_STORAGE"));
});

test("NPCs act only through the DM, and characters only through character commands", () => {
  const state = initialState(starterWorld("npcs"));
  assert.throws(() => commitTurn(state, { actorId: "tamsin", speech: "Hello." }), /tamsin is an NPC, voiced by the DM/);
  assert.throws(() => npcCommand(state, { actorId: "mira", speech: "Hello." }), /mira is not an NPC/);
  assert.throws(() => npcCommand(state, {}), errorCode("INVALID_INPUT"));
  assert.throws(() => npcCommand(state, { destinationId: "channel" }), errorCode("INVALID_ACTION"));

  const replayer = new Replayer();
  replayer.apply(creationEvent(starterWorld("npcs")));
  const result = npcCommand(state, { speech: "Follow me.", addresseeId: "mira", destinationId: "mouth" });
  assert.deepEqual(result.committed.map(({ event }) => [event.source, event.data.type]), [["dm", "utterance"], ["dm", "character_moved"]]);
  assert.equal(result.state.characters.find((character) => character.id === "tamsin")?.locationId, "mouth");
  assert.equal(result.state.elapsedSeconds, 310);
  for (const { event, perceivers } of result.committed) assert.deepEqual(replayer.apply(event), perceivers);
  assert.deepEqual(replayer.state, result.state);

  for (const forged of [
    nextEvent(state, { type: "utterance", actorId: "tamsin", locationId: "camp", text: "Hi.", seconds: 10 }),
    nextEvent(state, { type: "character_moved", actorId: "mira", fromId: "camp", destinationId: "mouth", seconds: 300 }, { source: "dm" }),
    nextEvent(state, { type: "time_advanced", actorId: "tamsin", seconds: 60 }),
  ]) {
    assert.throws(() => applyEvent(state, forged), errorCode("CORRUPT_STORAGE"));
  }
});

test("a ruling commits before the roll it calls for", () => {
  const state = atTheBars();
  const existing = commitTurn(state, {
    actorId: "bram", speech: "Stand back.", action: { type: "attempt", intent: "heave the bars apart" },
    ruling: { decision: "existing", challengeId: "pry-bars", reason: "That is what the crowbar is for." },
  }, fixed(15));
  assert.deepEqual(existing.committed.map(({ event }) => [event.sequence, event.source, event.data.type]), [
    [3, "character", "utterance"], [4, "dm", "ruling"], [5, "character", "check_resolved"],
  ]);
  assert.equal(existing.state.challenges.find((challenge) => challenge.id === "pry-bars")?.resolved, true);

  const ruled = commitTurn(state, { actorId: "elowen", action: { type: "attempt", intent: "climb the arch" }, ruling: climb }, fixed(15));
  const [ruling, check] = ruled.committed.map(({ event }) => event.data);
  assert.deepEqual(ruling, {
    type: "ruling", actorId: "elowen", intent: "climb the arch", decision: "new", challengeId: "ruled-3", reason: "Crumbling brick.",
    challenge: {
      id: "ruled-3", name: "Climb the arch", locationId: "mouth", ability: "dexterity", difficulty: 16,
      seconds: 180, failureDamage: 2, resolved: false,
    },
  });
  assert.ok(check?.type === "check_resolved");
  assert.deepEqual([check.challengeId, check.difficulty, check.success], ["ruled-3", 16, true]);
  assert.equal(ruled.state.elapsedSeconds, state.elapsedSeconds + 180);

  const automatic = commitTurn(state, {
    actorId: "elowen", action: { type: "attempt", intent: "sit on a rock" },
    ruling: { decision: "automatic", seconds: 60, reason: "Anyone can sit." },
  });
  assert.deepEqual(automatic.committed.map(({ event }) => event.data.type), ["ruling"]);
  assert.equal(automatic.state.elapsedSeconds, state.elapsedSeconds + 60);

  // Replay reproduces every ruling, including the check it defined.
  for (const result of [existing, ruled, automatic]) {
    const replayer = new Replayer();
    replayer.apply(creationEvent(starterWorld("rulings")));
    replayer.apply(commitTurn(replayer.state!, { actorId: "bram", action: { type: "move", destinationId: "mouth" } }).committed[0]!.event);
    for (const { event, perceivers } of result.committed) assert.deepEqual(replayer.apply(event), perceivers);
    assert.deepEqual(replayer.state, result.state);
  }
});

test("rulings stay within the world's limits", () => {
  const state = atTheBars();
  const problem = (ruling: RulingInput, actorId = "elowen", world = state) => checkRuling(world, actorId, "try something", ruling);
  assert.equal(problem(climb), null);
  assert.equal(problem({ ...climb, difficulty: "very hard" }), "Difficulty must be a band up to hard");
  assert.equal(problem({ ...climb, failureDamage: 4 }), "Failure damage must be at most 3");
  assert.equal(problem({ ...climb, seconds: 900 }), "A ruled check takes at most 600 seconds");
  assert.equal(problem({ decision: "automatic", seconds: 900, reason: "Slow." }), "A ruled action takes at most 600 seconds");
  assert.equal(problem({ decision: "existing", challengeId: "clear-rubble", reason: "x" }), "There is no challenge clear-rubble here");
  assert.equal(problem({ decision: "existing", challengeId: "nonexistent", reason: "x" }), "There is no challenge nonexistent here");
  assert.match(problem(climb, "tamsin") ?? "", /tamsin is not here|NPC/);

  const wisdomOnly = starterWorld("wisdom-only");
  wisdomOnly.rulings = { ...wisdomOnly.rulings!, abilities: ["wisdom"] };
  assert.equal(problem(climb, "elowen", atTheBars(wisdomOnly)), "Rulings in this world cannot test dexterity");
  assert.equal(problem(climb, "mira", initialState(sampleWorld("no-limits"))), "This world does not allow open-ended attempts");

  const resolved = commitTurn(state, {
    actorId: "bram", action: { type: "attempt_check", challengeId: "pry-bars" },
  }, fixed(15)).state;
  assert.equal(problem({ decision: "existing", challengeId: "pry-bars", reason: "x" }, "bram", resolved), "pry-bars is already resolved");

  // An attempt needs a ruling, and only an attempt has one.
  assert.throws(() => commitTurn(state, { actorId: "elowen", action: { type: "attempt", intent: "climb" } }), errorCode("INVALID_INPUT"));
  assert.throws(() => commitTurn(state, { actorId: "elowen", speech: "Hm.", ruling: climb }), errorCode("INVALID_INPUT"));
  assert.throws(
    () => commitTurn(state, { actorId: "elowen", action: { type: "attempt", intent: "climb" }, ruling: { ...climb, difficulty: "very hard" } }),
    /Difficulty must be a band up to hard/,
  );
});

test("replay rejects rulings that break the world's limits or come from a character", () => {
  const state = atTheBars();
  const ruled = commitTurn(state, { actorId: "elowen", action: { type: "attempt", intent: "climb" }, ruling: climb }).committed[0]!.event;
  assert.ok(ruled.data.type === "ruling" && ruled.data.challenge);
  applyEvent(state, ruled);
  const challenge = ruled.data.challenge;
  for (const forged of [
    { ...ruled, source: "character" as const },
    { ...ruled, data: { ...ruled.data, challenge: { ...challenge, difficulty: 13 } } },
    { ...ruled, data: { ...ruled.data, challenge: { ...challenge, difficulty: 21 } } },
    { ...ruled, data: { ...ruled.data, challenge: { ...challenge, onSuccess: { grantItems: [{ itemId: "seal", quantity: 1 }] } } } },
    { ...ruled, data: { ...ruled.data, challengeId: "pry-bars" } },
  ]) {
    assert.throws(() => applyEvent(state, forged), errorCode("CORRUPT_STORAGE"));
  }
});
