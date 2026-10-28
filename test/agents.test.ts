import assert from "node:assert/strict";
import test from "node:test";
import { starterCast, starterWorld } from "../src/adventures/starter.ts";
import { describeEvent, formatClock, renderCharacterPrompt } from "../src/agents/context.ts";
import { characterSystemPrompt } from "../src/agents/prompts.ts";
import { characterTurnSchema, ProposalError, toTurnParts } from "../src/agents/protocol.ts";
import { ProviderError, ScriptedProvider } from "../src/agents/provider.ts";
import { availableActions, perceive } from "../src/perception.ts";
import { sampleWorld } from "../src/sample-world.ts";
import { commitTurn, fixed, initialState } from "./support.ts";

const none = {
  destinationId: null, recipientId: null, itemId: null, quantity: null, challengeId: null, minutes: null,
};

test("model output converts to engine commands with per-action checks", () => {
  assert.deepEqual(toTurnParts({ speech: "  Hello.  ", action: null }), { speech: "Hello." });
  assert.deepEqual(toTurnParts({ speech: null, action: { ...none, type: "move", destinationId: "ridge" } }), {
    action: { type: "move", destinationId: "ridge" },
  });
  assert.deepEqual(toTurnParts({ speech: "", action: { ...none, type: "wait", minutes: 5 } }), {
    action: { type: "wait", seconds: 300 },
  });
  assert.deepEqual(toTurnParts({
    speech: "Take it.",
    action: { ...none, type: "transfer_item", recipientId: "bram", itemId: "rope", quantity: 1 },
  }), {
    speech: "Take it.", action: { type: "transfer_item", recipientId: "bram", itemId: "rope", quantity: 1 },
  });
  for (const [output, message] of [
    [{ speech: "   ", action: null }, /Say something/],
    [{ speech: "x".repeat(501), action: null }, /at most 500/],
    [{ speech: null, action: { ...none, type: "move" } }, /move requires destinationId/],
    [{ speech: null, action: { ...none, type: "transfer_item", recipientId: "bram", itemId: "rope" } }, /requires quantity/],
    [{ speech: null, action: { ...none, type: "wait", minutes: 0 } }, /between 1 and 60/],
    [{ speech: null, action: { ...none, type: "wait", minutes: 61 } }, /between 1 and 60/],
  ] as const) {
    assert.throws(() => toTurnParts(output), (error) => error instanceof ProposalError && message.test(error.message));
  }
});

test("the turn schema is strict about fields", () => {
  assert.ok(characterTurnSchema.safeParse({ speech: null, action: { ...none, type: "wait", minutes: 1 } }).success);
  for (const output of [
    { speech: null },
    { speech: "Hi.", action: null, mood: "happy" },
    { speech: null, action: { type: "wait", minutes: 1 } },
    { speech: null, action: { ...none, type: "fly" } },
    { speech: 5, action: null },
  ]) {
    assert.equal(characterTurnSchema.safeParse(output).success, false);
  }
});

test("characters see 'you' and outcomes; only the admin view shows dice", () => {
  const state = initialState(sampleWorld("describe"));
  const check = commitTurn(state, { action: { type: "attempt_check", challengeId: "gate-trap" } }, fixed(15)).committed[0]!.event;
  assert.equal(describeEvent(check, state, "mira"), "[0:02:00] You attempted \"Disarm the gate trap\" and succeeded.");
  assert.equal(describeEvent(check, state, "bram"), "[0:02:00] Mira attempted \"Disarm the gate trap\" and succeeded.");
  assert.match(describeEvent(check, state, null), /\(Rolled 15 \+3 against 13\.\)$/);
  assert.equal(formatClock(3725), "1:02:05");
});

test("a character prompt lists IDs and legal actions, and carries feedback", () => {
  const state = initialState(starterWorld("prompt"));
  const prompt = renderCharacterPrompt(
    perceive(state, "elowen"), availableActions(state, "elowen"), [], ["pry-bars requires crowbar"],
  );
  assert.match(prompt, /Aqueduct Mouth \(mouth\)/);
  assert.match(prompt, /Dry Channel \(channel\): 2 minutes away, blocked/);
  assert.match(prompt, /- move: destinationId one of camp\n/);
  assert.match(prompt, /needs Crowbar \(you do not carry it\)/);
  assert.match(prompt, /## Your previous proposal was rejected\n- pry-bars requires crowbar/);
  assert.doesNotMatch(prompt, /attempt_check/);
  const system = characterSystemPrompt("Elowen", starterCast.characters.elowen!);
  assert.match(system, /You are Elowen/);
  assert.match(system, /Attitude to risk: balanced/);
});

test("prompts never contain hidden facts (canary)", () => {
  const seed = starterWorld("canary");
  seed.items.push({ id: "canary-item", name: "CANARY-INVENTORY-5d1e" });
  seed.characters.find((character) => character.id === "bram")!.inventory["canary-item"] = 1;
  seed.challenges.find((challenge) => challenge.id === "clear-rubble")!.description = "CANARY-ELSEWHERE-90b2";
  seed.challenges.find((challenge) => challenge.id === "pry-bars")!.difficulty = 37;
  const state = initialState(seed);
  for (const viewer of ["mira", "elowen"]) {
    const prompt = renderCharacterPrompt(perceive(state, viewer), availableActions(state, viewer), [], []);
    for (const canary of ["CANARY-INVENTORY-5d1e", "canary-item", "CANARY-ELSEWHERE-90b2", "37"]) {
      assert.ok(!prompt.includes(canary), `${viewer}'s prompt must not contain ${canary}`);
    }
  }
  const bram = renderCharacterPrompt(perceive(state, "bram"), availableActions(state, "bram"), [], []);
  assert.ok(bram.includes("CANARY-INVENTORY-5d1e"), "positive control: Bram sees his own inventory");
});

test("the scripted provider fails explicitly when used out of order or too often", async () => {
  const request = { role: "character" as const, system: "", prompt: "", schema: characterTurnSchema, schemaName: "t" };
  const provider = new ScriptedProvider([
    { role: "dm", output: { narration: "x" } },
    { role: "character", error: new ProviderError("refused", "No.") },
  ]);
  await assert.rejects(provider.generate(request), (error) => error instanceof ProviderError && error.kind === "script_exhausted");
  await assert.rejects(provider.generate(request), (error) => error instanceof ProviderError && error.kind === "refused");
  await assert.rejects(provider.generate(request), (error) => error instanceof ProviderError && error.kind === "script_exhausted");
  assert.equal(provider.remaining, 0);
});
