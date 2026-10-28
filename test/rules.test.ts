import assert from "node:assert/strict";
import test from "node:test";
import { starterWorld } from "../src/adventures/starter.ts";
import { commandSchema, parseInput, validateWorld } from "../src/model.ts";
import type { WorldSeed } from "../src/model.ts";
import { applyEvent, Replayer, resolveAction, resolveCommand } from "../src/rules.ts";
import type { CommittedEvent } from "../src/rules.ts";
import { sampleWorld } from "../src/sample-world.ts";
import { commitTurn, creationEvent, errorCode, fixed, initialState, nextEvent, NOW } from "./support.ts";

const initial = (seed: WorldSeed = sampleWorld("test-world")) => initialState(seed);

test("movement uses the route's defined travel time", () => {
  const state = initial();
  assert.deepEqual(resolveAction(state, "mira", { type: "move", destinationId: "ridge" }), {
    type: "character_moved", actorId: "mira", fromId: "gate", destinationId: "ridge", seconds: 300,
  });
  assert.equal(state.characters[0]?.locationId, "gate");
});

test("transferring the last item removes it from the sender", () => {
  const state = initial();
  const next = applyEvent(state, nextEvent(state, {
    type: "item_transferred", actorId: "mira", recipientId: "bram", itemId: "rope", quantity: 1,
  }));
  assert.deepEqual(next.characters[0]?.inventory, {});
  assert.equal(next.characters[1]?.inventory.rope, 1);
  assert.equal(state.characters[0]?.inventory.rope, 1);
  assert.throws(() => resolveAction(next, "mira", {
    type: "transfer_item", recipientId: "bram", itemId: "rope", quantity: 1,
  }), errorCode("INVALID_ACTION"));
});

test("unknown actors, unreachable routes, absent recipients and remote transfers fail", () => {
  const state = initial();
  for (const [actorId, action] of [
    ["nobody", { type: "wait", seconds: 60 }],
    ["mira", { type: "move", destinationId: "nowhere" }],
    ["mira", { type: "transfer_item", recipientId: "nobody", itemId: "rope", quantity: 1 }],
    ["mira", { type: "transfer_item", recipientId: "mira", itemId: "rope", quantity: 1 }],
    ["mira", { type: "transfer_item", recipientId: "elowen", itemId: "rope", quantity: 1 }],
  ] as const) {
    assert.throws(() => resolveAction(state, actorId, action), errorCode("INVALID_ACTION"));
  }
});

test("runtime validation rejects malformed commands", () => {
  const base = { role: "character", requestId: "invalid", expectedRevision: 1, actorId: "mira" };
  const narrate = { role: "dm", requestId: "n", expectedRevision: 1 };
  for (const input of [
    { ...base, action: { type: "wait", seconds: 0 } },
    { ...base, action: { type: "wait", seconds: 3601 } },
    { ...base, action: { type: "wait", seconds: 1.5 } },
    { ...base, action: { type: "transfer_item", recipientId: "bram", itemId: "rope", quantity: -1 } },
    { ...base, action: { type: "transfer_item", recipientId: "bram", itemId: "rope", quantity: 0 } },
    { ...base, action: { type: "attempt_check", challengeId: "gate-trap", difficulty: 1, success: true } },
    base,
    { ...base, speech: "   " },
    { ...base, speech: "x".repeat(501) },
    { ...base, role: undefined, action: { type: "wait", seconds: 60 } },
    { ...narrate, action: { type: "narrate", aboutSequences: [], text: "Nothing." } },
    { ...narrate, action: { type: "narrate", aboutSequences: [2], text: "x".repeat(1001) } },
    { ...narrate, actorId: "mira", action: { type: "narrate", aboutSequences: [2], text: "Nothing." } },
  ]) {
    assert.throws(() => parseInput(commandSchema, input), errorCode("INVALID_INPUT"));
  }
});

test("a turn commits speech first, and speech costs world time", () => {
  const state = initial();
  const result = commitTurn(state, { speech: "Bram, the trap.", action: { type: "wait", seconds: 60 } });
  assert.deepEqual(result.committed.map(({ event }) => [event.sequence, event.requestId, event.data.type]), [
    [2, "turn", "utterance"],
    [3, "turn", "time_advanced"],
  ]);
  assert.deepEqual(result.committed[0]?.event.data, {
    type: "utterance", actorId: "mira", locationId: "gate", text: "Bram, the trap.", seconds: 10,
  });
  assert.equal(result.committed[0]?.event.elapsedSeconds, 10);
  assert.equal(result.state.elapsedSeconds, 70);
  assert.equal(result.state.revision, 3);
  assert.equal(state.revision, 1);
});

test("an invalid action rejects the whole turn, speech included", () => {
  const state = initial();
  assert.throws(
    () => commitTurn(state, { speech: "Off I go.", action: { type: "move", destinationId: "nowhere" } }),
    errorCode("INVALID_ACTION"),
  );
  assert.throws(() => commitTurn(state, { actorId: "nobody", speech: "Hello?" }), errorCode("INVALID_ACTION"));
});

test("perceivers are conscious characters where an event happens; moves are seen at both ends", () => {
  const state = initial();
  assert.deepEqual(commitTurn(state, { speech: "Anyone up there?" }).committed[0]?.perceivers, ["bram", "mira"]);
  const moved = commitTurn(state, { action: { type: "move", destinationId: "ridge" } });
  assert.deepEqual(moved.committed[0]?.perceivers, ["bram", "elowen", "mira"]);
  assert.deepEqual(commitTurn(moved.state, { speech: "Found you." }).committed[0]?.perceivers, ["elowen", "mira"]);
  moved.state.characters.find((character) => character.id === "elowen")!.hp = 0;
  assert.deepEqual(commitTurn(moved.state, { speech: "Elowen?" }).committed[0]?.perceivers, ["mira"]);
});

test("checks use world-owned difficulty and consequences, with capped damage", () => {
  const state = initial();
  state.characters[0]!.hp = 2;
  state.challenges[0]!.difficulty = 40;
  const data = resolveAction(state, "mira", { type: "attempt_check", challengeId: "gate-trap" }, fixed(20));
  assert.deepEqual(data, {
    type: "check_resolved", actorId: "mira", challengeId: "gate-trap", roll: 20, modifier: 3,
    difficulty: 40, success: false, damage: 2, seconds: 120, effects: { unlockedRoutes: [], grantedItems: [] },
  });
  const next = applyEvent(state, nextEvent(state, data));
  assert.equal(next.characters[0]?.hp, 0);
  assert.throws(() => resolveAction(next, "mira", { type: "wait", seconds: 60 }), errorCode("INVALID_ACTION"));
});

test("successful checks resolve once; remote and unknown checks are rejected", () => {
  const state = initial();
  const attempt = { action: { type: "attempt_check", challengeId: "gate-trap" } };
  const { state: next } = commitTurn(state, attempt, fixed(10));
  assert.equal(next.challenges[0]?.resolved, true);
  assert.equal(next.characters[0]?.hp, 10);
  assert.throws(() => commitTurn(next, attempt), errorCode("INVALID_ACTION"));
  for (const challengeId of ["scout-aqueduct", "missing"]) {
    assert.throws(
      () => commitTurn(state, { action: { type: "attempt_check", challengeId } }),
      errorCode("INVALID_ACTION"),
    );
  }
});

test("the dice source must return an integer from 1 to 20", () => {
  const state = initial();
  for (const value of [0, 21, 1.5]) {
    assert.throws(
      () => resolveAction(state, "mira", { type: "attempt_check", challengeId: "gate-trap" }, fixed(value)),
      /dice source/,
    );
  }
});

test("locked routes open only after a successful check unlocks them", () => {
  const atMouth = commitTurn(initial(starterWorld("locked")), {
    actorId: "bram", action: { type: "move", destinationId: "mouth" },
  }).state;
  const enter = { actorId: "bram", action: { type: "move", destinationId: "channel" } };
  const pry = { actorId: "bram", action: { type: "attempt_check", challengeId: "pry-bars" } };
  assert.throws(() => commitTurn(atMouth, enter), errorCode("INVALID_ACTION"));
  assert.throws(() => applyEvent(atMouth, nextEvent(atMouth, {
    type: "character_moved", actorId: "bram", fromId: "mouth", destinationId: "channel", seconds: 120,
  })), errorCode("CORRUPT_STORAGE"));

  const failed = commitTurn(atMouth, pry, fixed(2));
  const failure = failed.committed[0]?.event.data;
  assert.ok(failure?.type === "check_resolved" && !failure.success);
  assert.deepEqual(failure.effects, { unlockedRoutes: [], grantedItems: [] });
  assert.throws(() => commitTurn(failed.state, enter), errorCode("INVALID_ACTION"));

  const pried = commitTurn(failed.state, pry, fixed(15));
  const success = pried.committed[0]?.event.data;
  assert.ok(success?.type === "check_resolved" && success.success);
  assert.deepEqual(success.effects.unlockedRoutes, [{ fromId: "mouth", destinationId: "channel" }]);
  const inside = commitTurn(pried.state, enter).state;
  assert.equal(inside.characters.find((character) => character.id === "bram")?.locationId, "channel");
});

test("replay rejects check outcomes with forged effects", () => {
  const state = commitTurn(initial(starterWorld("forged")), {
    actorId: "bram", action: { type: "move", destinationId: "mouth" },
  }).state;
  const success = {
    type: "check_resolved", actorId: "bram", challengeId: "pry-bars", roll: 15, modifier: 3,
    difficulty: 13, success: true, damage: 0, seconds: 120,
  } as const;
  const unlock = [{ fromId: "mouth", destinationId: "channel" }];
  for (const data of [
    { ...success, effects: { unlockedRoutes: [], grantedItems: [] } },
    { ...success, effects: { unlockedRoutes: unlock, grantedItems: [{ itemId: "seal", quantity: 1 }] } },
    { ...success, roll: 2, success: false, damage: 2, effects: { unlockedRoutes: unlock, grantedItems: [] } },
  ]) {
    assert.throws(() => applyEvent(state, nextEvent(state, data)), errorCode("CORRUPT_STORAGE"));
  }
  applyEvent(state, nextEvent(state, { ...success, effects: { unlockedRoutes: unlock, grantedItems: [] } }));
});

test("a character cannot use an item they gave away", () => {
  const seed = starterWorld("gave-away");
  for (const character of seed.characters) character.locationId = "cistern";
  const search = { action: { type: "attempt_check", challengeId: "search-ledge" } };
  const state = commitTurn(initialState(seed), {
    actorId: "elowen", action: { type: "transfer_item", recipientId: "mira", itemId: "lantern", quantity: 1 },
  }).state;
  assert.throws(() => commitTurn(state, { actorId: "elowen", ...search }, fixed(20)), errorCode("INVALID_ACTION"));
  assert.throws(() => applyEvent(state, nextEvent(state, {
    type: "check_resolved", actorId: "elowen", challengeId: "search-ledge", roll: 20, modifier: 3,
    difficulty: 12, success: true, damage: 0, seconds: 180,
    effects: { unlockedRoutes: [], grantedItems: [{ itemId: "seal", quantity: 1 }] },
  })), errorCode("CORRUPT_STORAGE"));
  const found = commitTurn(state, { actorId: "mira", ...search }, fixed(15)).state;
  assert.deepEqual(found.characters.find((character) => character.id === "mira")?.inventory, {
    rope: 1, lantern: 1, seal: 1,
  });
});

test("world validation rejects duplicates, missing references and excessive HP", () => {
  const changes: ((seed: WorldSeed) => void)[] = [
    (seed) => seed.characters.push(structuredClone(seed.characters[0]!)),
    (seed) => { seed.locations[0]!.routes[0]!.destinationId = "missing"; },
    (seed) => { seed.characters[0]!.hp = 100; },
    (seed) => { seed.characters[0]!.inventory = { missing: 1 }; },
    (seed) => { seed.challenges[0]!.requiresItemId = "missing"; },
    (seed) => { seed.challenges[0]!.onSuccess = { unlockRoutes: [{ fromId: "camp", destinationId: "cistern" }] }; },
    (seed) => { seed.challenges[0]!.onSuccess = { grantItems: [{ itemId: "missing", quantity: 1 }] }; },
  ];
  for (const change of changes) {
    const seed = starterWorld();
    change(seed);
    assert.throws(() => validateWorld(seed), errorCode("INVALID_INPUT"));
  }
  validateWorld(starterWorld());
  validateWorld(sampleWorld());
});

test("replay rejects sequence gaps, wrong sources, contradictory outcomes and clocks", () => {
  const state = initial();
  const wait = nextEvent(state, { type: "time_advanced", actorId: "mira", seconds: 60 });
  applyEvent(state, wait);
  for (const forged of [
    { ...wait, sequence: 3 },
    { ...wait, elapsedSeconds: 120 },
    { ...wait, source: "dm" as const },
    nextEvent(state, { type: "character_moved", actorId: "mira", fromId: "gate", destinationId: "ridge", seconds: 60 }),
    nextEvent(state, { type: "utterance", actorId: "mira", locationId: "gate", text: "Hi.", seconds: 5 }),
    nextEvent(state, { type: "utterance", actorId: "mira", locationId: "ridge", text: "Hi.", seconds: 10 }),
    nextEvent(state, { type: "narration", aboutSequences: [2], text: "Nothing happens." }),
  ]) {
    assert.throws(() => applyEvent(state, forged), errorCode("CORRUPT_STORAGE"));
  }
});

test("replay reproduces commit-time perceivers, and narration reaches only its audience", () => {
  const replayer = new Replayer();
  replayer.apply(creationEvent(sampleWorld("test-world")));
  let state = replayer.state!;
  const committed: CommittedEvent[] = [];
  for (const input of [
    { actorId: "mira", speech: "To the ridge.", action: { type: "move", destinationId: "ridge" } },
    { actorId: "bram", speech: "Alone again." },
    { actorId: "elowen", action: { type: "wait", seconds: 60 } },
  ]) {
    const result = commitTurn(state, input);
    committed.push(...result.committed);
    state = result.state;
  }
  const narration = resolveCommand(state, parseInput(commandSchema, {
    role: "dm", requestId: "n5-5", expectedRevision: state.revision,
    action: { type: "narrate", aboutSequences: [5], text: "Elowen watches the clouds." },
  }), { roll: fixed(10), recordedAt: NOW, audience: ["mira", "elowen", "mira"] });
  committed.push(...narration.committed);
  assert.deepEqual(committed.map(({ event, perceivers }) => [event.sequence, event.data.type, perceivers]), [
    [2, "utterance", ["bram", "mira"]],
    [3, "character_moved", ["bram", "elowen", "mira"]],
    [4, "utterance", ["bram"]],
    [5, "time_advanced", ["elowen", "mira"]],
    [6, "narration", ["elowen", "mira"]],
  ]);
  for (const { event, perceivers } of committed) assert.deepEqual(replayer.apply(event), perceivers);
  assert.deepEqual(replayer.state, narration.state);
});

test("replay rejects narration of speech or of the world's creation", () => {
  const replayer = new Replayer();
  replayer.apply(creationEvent(sampleWorld("test-world")));
  replayer.apply(commitTurn(replayer.state!, { speech: "Hello." }).committed[0]!.event);
  const state = replayer.state!;
  for (const aboutSequences of [[2], [1]]) {
    assert.throws(
      () => replayer.apply(nextEvent(state, { type: "narration", aboutSequences, text: "Something happens." })),
      errorCode("CORRUPT_STORAGE"),
    );
  }
  assert.equal(replayer.state?.revision, 2);
});

test("inventory IDs matching object prototype names do not count as owned items", () => {
  const state = initial();
  const transfer = { type: "transfer_item", recipientId: "bram", itemId: "constructor", quantity: 1 } as const;
  assert.throws(() => resolveAction(state, "mira", transfer), errorCode("INVALID_ACTION"));
  state.items.push({ id: "constructor", name: "Constructor's kit" });
  Object.defineProperty(state.characters[0]!.inventory, "constructor", {
    value: 1, enumerable: true, configurable: true, writable: true,
  });
  const next = applyEvent(state, nextEvent(state, resolveAction(state, "mira", transfer)));
  assert.equal(Object.hasOwn(next.characters[0]!.inventory, "constructor"), false);
  assert.equal(next.characters[1]!.inventory.constructor, 1);
});
