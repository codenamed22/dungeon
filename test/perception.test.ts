import assert from "node:assert/strict";
import test from "node:test";
import { starterWorld } from "../src/adventures/starter.ts";
import type { WorldState } from "../src/model.ts";
import { availableActions, conditionOf, difficultyBand, perceive } from "../src/perception.ts";
import { resolveAction, resolveCommand } from "../src/rules.ts";
import { sampleWorld } from "../src/sample-world.ts";
import { commitTurn, errorCode, fixed, initialState, NOW } from "./support.ts";

test("perception shows difficulty bands and others' condition, never numbers or inventories", () => {
  const state = initialState(sampleWorld("perception"));
  state.characters[1]!.hp = 6;
  const view = perceive(state, "mira");
  assert.deepEqual(view.present, [{ id: "bram", name: "Bram", condition: "badly wounded" }]);
  assert.deepEqual(view.challenges, [{
    id: "gate-trap", name: "Disarm the gate trap", description: null, ability: "dexterity",
    difficulty: "moderate", dangerous: true, requires: null, resolved: false,
  }]);
  assert.deepEqual(view.inventory, [{ id: "rope", name: "Rope", quantity: 1 }]);
  const text = JSON.stringify(view);
  for (const hidden of ["torch", "elowen", "scout-aqueduct", "failureDamage", "13"]) {
    assert.ok(!text.includes(hidden), `perception must not contain ${hidden}`);
  }
  assert.throws(() => perceive(state, "nobody"), errorCode("NOT_FOUND"));
});

test("conditions and difficulty bands", () => {
  assert.deepEqual([10, 6, 5, 0].map((hp) => conditionOf(hp, 10)), ["unhurt", "wounded", "badly wounded", "incapacitated"]);
  assert.deepEqual(
    [10, 11, 15, 16, 20, 21].map(difficultyBand),
    ["easy", "moderate", "moderate", "hard", "hard", "very hard"],
  );
});

test("locked exits and unmet requirements are visible but not available", () => {
  const state = initialState(starterWorld("requirements"));
  const view = perceive(state, "elowen");
  assert.deepEqual(view.exits, [
    { id: "camp", name: "Ridge Camp", seconds: 300, blocked: false },
    { id: "channel", name: "Dry Channel", seconds: 120, blocked: true },
  ]);
  assert.deepEqual(view.challenges[0]?.requires, { id: "crowbar", name: "Crowbar", carried: false });
  assert.deepEqual(availableActions(state, "elowen"), {
    move: ["camp"], transfer: { recipients: [], items: [{ id: "lantern", quantity: 1 }] }, attempt: [], intent: true, maxWaitMinutes: 60,
  });
  const withBram = commitTurn(state, { actorId: "bram", action: { type: "move", destinationId: "mouth" } }).state;
  assert.deepEqual(availableActions(withBram, "bram").attempt, ["pry-bars"]);
  assert.deepEqual(availableActions(withBram, "bram").transfer.recipients, ["elowen"]);
  withBram.characters.find((character) => character.id === "bram")!.hp = 0;
  assert.deepEqual(availableActions(withBram, "bram"), {
    move: [], transfer: { recipients: [], items: [] }, attempt: [], intent: false, maxWaitMinutes: 0,
  });
});

test("every available action is one the engine accepts", () => {
  let state: WorldState = initialState(starterWorld("consistency"));
  const states = [state];
  for (const input of [
    { actorId: "bram", action: { type: "move", destinationId: "mouth" } },
    { actorId: "bram", action: { type: "attempt_check", challengeId: "pry-bars" } },
    { actorId: "elowen", action: { type: "move", destinationId: "channel" } },
  ]) {
    state = commitTurn(state, input, fixed(15)).state;
    states.push(state);
  }
  for (const current of states) {
    for (const npc of current.characters.filter((character) => character.npc)) {
      // NPCs act through the DM's npc commands, along the same open exits.
      for (const exit of perceive(current, npc.id).exits.filter((entry) => !entry.blocked)) {
        resolveCommand(current, {
          role: "npc", requestId: "npc", expectedRevision: current.revision, actorId: npc.id, destinationId: exit.id,
        }, { roll: fixed(10), recordedAt: NOW });
      }
    }
    for (const character of current.characters.filter((entry) => !entry.npc)) {
      const actions = availableActions(current, character.id);
      for (const destinationId of actions.move) resolveAction(current, character.id, { type: "move", destinationId });
      for (const challengeId of actions.attempt) {
        resolveAction(current, character.id, { type: "attempt_check", challengeId }, fixed(10));
      }
      for (const recipientId of actions.transfer.recipients) {
        for (const item of actions.transfer.items) {
          resolveAction(current, character.id, { type: "transfer_item", recipientId, itemId: item.id, quantity: item.quantity });
        }
      }
      for (const exit of perceive(current, character.id).exits.filter((entry) => entry.blocked)) {
        assert.throws(
          () => resolveAction(current, character.id, { type: "move", destinationId: exit.id }),
          errorCode("INVALID_ACTION"),
        );
      }
    }
  }
});
