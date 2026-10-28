import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "../src/model.ts";
import { Replayer } from "../src/rules.ts";
import { sampleWorld } from "../src/sample-world.ts";
import { parseStoredEvent, upcastEvent } from "../src/upcast.ts";
import { errorCode, phase1Events } from "./support.ts";

test("Phase 1 events upcast to the current format", () => {
  const [created, give, trap, walk, rest] = phase1Events().map(parseStoredEvent);
  assert.equal(created?.source, "director");
  assert.ok(created?.data.type === "world_created");
  assert.equal(canonicalJson(created.data.seed), canonicalJson(sampleWorld()));
  assert.deepEqual(give?.data, { type: "item_transferred", actorId: "mira", recipientId: "bram", itemId: "rope", quantity: 1 });
  assert.deepEqual(trap?.data, {
    type: "check_resolved", actorId: "mira", challengeId: "gate-trap", roll: 4, modifier: 3, difficulty: 13,
    success: false, damage: 3, seconds: 120, effects: { unlockedRoutes: [], grantedItems: [] },
  });
  assert.deepEqual(walk?.data, { type: "character_moved", actorId: "mira", fromId: "gate", destinationId: "ridge", seconds: 300 });
  assert.deepEqual(rest?.data, { type: "time_advanced", actorId: "elowen", seconds: 60 });
  assert.deepEqual([give, trap, walk, rest].map((event) => [event?.v, event?.source, event?.elapsedSeconds]), [
    [2, "character", 0], [2, "character", 120], [2, "character", 420], [2, "character", 480],
  ]);
});

test("an upcast Phase 1 history replays under the current rules", () => {
  const replayer = new Replayer();
  const perceivers = phase1Events().map((raw) => replayer.apply(parseStoredEvent(raw)));
  assert.deepEqual(perceivers, [[], ["bram", "mira"], ["bram", "mira"], ["bram", "elowen", "mira"], ["elowen", "mira"]]);
  assert.equal(replayer.state?.elapsedSeconds, 480);
  assert.equal(replayer.state?.characters[0]?.hp, 7);
});

test("current events pass through, and malformed Phase 1 events still fail validation", () => {
  const current = { v: 2, anything: true };
  assert.equal(upcastEvent(current), current);
  const [, , , walk] = phase1Events();
  for (const broken of [
    { ...walk, elapsedMinutes: "7" },
    { ...walk, data: { ...walk?.data, minutes: "5" } },
    { ...walk, data: null },
    "not an event",
  ]) {
    assert.throws(() => parseStoredEvent(broken), errorCode("CORRUPT_STORAGE"));
  }
});
