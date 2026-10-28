import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { AdventureEngine } from "../src/engine.ts";
import type { Command } from "../src/model.ts";
import { sampleWorld } from "../src/sample-world.ts";
import { errorCode, fixed } from "./support.ts";

const connectionString = process.env.TEST_DATABASE_URL;

function waitCommand(requestId: string, expectedRevision = 1, actorId = "mira"): Command {
  return { role: "character", requestId, expectedRevision, actorId, action: { type: "wait", seconds: 60 } };
}

function speak(requestId: string, expectedRevision: number, actorId: string, speech: string): Command {
  return { role: "character", requestId, expectedRevision, actorId, speech };
}

function narrate(requestId: string, expectedRevision: number, aboutSequences: number[], text = "Something happens."): Command {
  return { role: "dm", requestId, expectedRevision, action: { type: "narrate", aboutSequences, text } };
}

test("PostgreSQL engine integration", {
  skip: connectionString ? false : "Set TEST_DATABASE_URL to run real PostgreSQL integration tests",
}, async (t) => {
  assert.ok(connectionString);
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  let engine = new AdventureEngine(connectionString, { schema });
  const other = new AdventureEngine(connectionString, { schema });
  try {
    await Promise.all([engine.initialize(), other.initialize()]);

    await t.test("creation validates input and is resumable without resetting state", async () => {
      const seed = sampleWorld("creation");
      const initial = await engine.createWorld(seed);
      assert.equal(initial.revision, 1);
      assert.equal((await engine.getEvents(seed.id)).length, 1);
      await engine.execute(seed.id, waitCommand("wait"));
      assert.equal((await engine.createWorld(seed)).revision, 2);
      await assert.rejects(engine.createWorld({ ...seed, name: "Different" }), errorCode("REQUEST_CONFLICT"));
      await assert.rejects(engine.createWorld({ ...seed, id: "invalid", characters: [] }), errorCode("INVALID_INPUT"));
      await assert.rejects(engine.getWorld("invalid"), errorCode("NOT_FOUND"));
      await assert.rejects(engine.getWorld("missing"), errorCode("NOT_FOUND"));
    });

    await t.test("restart reconstructs identical state from durable events", async () => {
      const seed = sampleWorld("restart");
      await engine.createWorld(seed);
      await engine.execute(seed.id, {
        role: "character", requestId: "give-rope", expectedRevision: 1, actorId: "mira",
        action: { type: "transfer_item", recipientId: "bram", itemId: "rope", quantity: 1 },
      });
      await engine.execute(seed.id, {
        role: "character", requestId: "walk", expectedRevision: 2, actorId: "mira",
        action: { type: "move", destinationId: "ridge" },
      });
      const before = await engine.getWorld(seed.id);
      await engine.close();
      engine = new AdventureEngine(connectionString, { schema });
      await engine.initialize();
      assert.deepEqual(await engine.getWorld(seed.id), before);
      assert.deepEqual(await engine.replayWorld(seed.id), before);
      assert.equal(before.elapsedSeconds, 300);
      assert.equal(before.characters[1]?.inventory.rope, 1);
      assert.equal(before.characters[0]?.locationId, "ridge");
    });

    await t.test("identical retries return the original result, even after subsequent turns", async () => {
      await engine.createWorld(sampleWorld("retry"));
      const command = waitCommand("original");
      const first = await engine.execute("retry", command);
      await engine.execute("retry", waitCommand("later", 2));
      const retried = await engine.execute("retry", command);
      assert.deepEqual(retried, first);
      assert.equal((await engine.getWorld("retry")).revision, 3);
      assert.equal((await engine.getEvents("retry")).length, 3);
      await assert.rejects(engine.execute("retry", {
        ...command, action: { type: "wait", seconds: 120 },
      }), errorCode("REQUEST_CONFLICT"));
      await assert.rejects(engine.execute("retry", { ...command, expectedRevision: 3 }), errorCode("REQUEST_CONFLICT"));
    });

    await t.test("speech and action commit together or not at all, and retries return both", async () => {
      const initial = await engine.createWorld(sampleWorld("turns"));
      await assert.rejects(engine.execute(initial.id, {
        role: "character", requestId: "nowhere", expectedRevision: 1, actorId: "mira",
        speech: "Off I go.", action: { type: "move", destinationId: "nowhere" },
      }), errorCode("INVALID_ACTION"));
      assert.equal((await engine.getEvents(initial.id)).length, 1);
      const command: Command = {
        role: "character", requestId: "give", expectedRevision: 1, actorId: "mira",
        speech: "Take the rope, Bram.", action: { type: "transfer_item", recipientId: "bram", itemId: "rope", quantity: 1 },
      };
      const first = await engine.execute(initial.id, command);
      assert.deepEqual(first.events.map((event) => [event.sequence, event.requestId, event.data.type]), [
        [2, "give", "utterance"],
        [3, "give", "item_transferred"],
      ]);
      assert.equal(first.state.revision, 3);
      assert.equal(first.state.elapsedSeconds, 10);
      await engine.execute(initial.id, waitCommand("later", 3));
      assert.deepEqual(await other.execute(initial.id, command), first);
    });

    await t.test("retried dice checks retain the original roll and apply damage only once", async () => {
      const seed = sampleWorld("dice-retry");
      seed.challenges[0]!.difficulty = 40;
      await engine.createWorld(seed);
      const command: Command = {
        role: "character", requestId: "roll-once", expectedRevision: 1, actorId: "mira",
        action: { type: "attempt_check", challengeId: "gate-trap" },
      };
      const first = await engine.execute(seed.id, command);
      assert.equal(first.state.characters[0]?.hp, 7);
      assert.equal(first.state.elapsedSeconds, 120);
      assert.deepEqual(await other.execute(seed.id, command), first);
      assert.deepEqual(await engine.replayWorld(seed.id), first.state);
      assert.equal((await engine.getEvents(seed.id)).length, 2);
    });

    await t.test("an injected dice source decides checks", async () => {
      const lucky = new AdventureEngine(connectionString, { schema, roll: fixed(20) });
      try {
        await lucky.createWorld(sampleWorld("dice-fixed"));
        const result = await lucky.execute("dice-fixed", {
          role: "character", requestId: "lucky", expectedRevision: 1, actorId: "mira",
          action: { type: "attempt_check", challengeId: "gate-trap" },
        });
        const check = result.events[0]?.data;
        assert.ok(check?.type === "check_resolved");
        assert.equal(check.roll, 20);
        assert.equal(check.success, true);
      } finally {
        await lucky.close();
      }
    });

    await t.test("concurrent same-ID retries across engine instances commit exactly once", async () => {
      await engine.createWorld(sampleWorld("concurrent-retry"));
      const command = waitCommand("same");
      const results = await Promise.all([
        engine.execute("concurrent-retry", command),
        other.execute("concurrent-retry", command),
      ]);
      assert.deepEqual(results[0], results[1]);
      assert.equal((await engine.getEvents("concurrent-retry")).length, 2);
    });

    await t.test("concurrent conflicting proposals allow one commit and reject the stale proposal", async () => {
      await engine.createWorld(sampleWorld("concurrent-stale"));
      const results = await Promise.allSettled([
        engine.execute("concurrent-stale", waitCommand("a")),
        other.execute("concurrent-stale", waitCommand("b")),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = results.find((result) => result.status === "rejected");
      assert.ok(rejected?.status === "rejected");
      assert.ok(errorCode("STALE_REVISION")(rejected.reason));
      assert.equal((await engine.getWorld("concurrent-stale")).elapsedSeconds, 60);
    });

    await t.test("invalid and stale actions leave state and history unchanged", async () => {
      const initial = await engine.createWorld(sampleWorld("invalid-action"));
      await assert.rejects(engine.execute(initial.id, {
        role: "character", requestId: "bad-transfer", expectedRevision: 1, actorId: "mira",
        action: { type: "transfer_item", recipientId: "bram", itemId: "rope", quantity: 2 },
      }), errorCode("INVALID_ACTION"));
      await assert.rejects(engine.execute(initial.id, waitCommand("stale", 2)), errorCode("STALE_REVISION"));
      await assert.rejects(engine.execute(initial.id, {
        ...waitCommand("bad-input"), action: { type: "wait", seconds: -1 },
      }), errorCode("INVALID_INPUT"));
      await assert.rejects(engine.execute(initial.id, waitCommand("world-created")), errorCode("INVALID_INPUT"));
      assert.deepEqual(await engine.getWorld(initial.id), initial);
      assert.equal((await engine.getEvents(initial.id)).length, 1);
      // Rejected requests do not reserve an idempotency key.
      assert.equal((await engine.execute(initial.id, waitCommand("bad-transfer"))).state.revision, 2);
    });

    await t.test("each event records who perceived it", async () => {
      const world = await engine.createWorld(sampleWorld("perceivers"));
      await engine.execute(world.id, speak("hello", 1, "mira", "Bram, the trap."));
      await engine.execute(world.id, speak("far", 2, "elowen", "The aqueduct is close."));
      await engine.execute(world.id, {
        role: "character", requestId: "climb", expectedRevision: 3, actorId: "bram",
        action: { type: "move", destinationId: "ridge" },
      });
      const sequences = async (characterId: string, limit?: number) => (
        await engine.getPerceivedEvents(world.id, characterId, limit)
      ).map((event) => event.sequence);
      assert.deepEqual(await sequences("mira"), [2, 4]);
      assert.deepEqual(await sequences("bram"), [2, 4]);
      assert.deepEqual(await sequences("elowen"), [3, 4]);
      assert.deepEqual(await sequences("elowen", 1), [4]);
      assert.deepEqual(await engine.getPerceivers(world.id, 4), ["bram", "elowen", "mira"]);
      assert.deepEqual(await engine.getPerceivers(world.id, 1), []);
      await assert.rejects(engine.getPerceivedEvents(world.id, "nobody"), errorCode("NOT_FOUND"));
      await assert.rejects(engine.getPerceivedEvents(world.id, "mira", 0), errorCode("INVALID_INPUT"));
    });

    await t.test("narration reaches only the perceivers of the actions it describes", async () => {
      // Continues the previous world: Bram has joined Elowen on the ridge, Mira is alone at the gate.
      await engine.execute("perceivers", waitCommand("mira-waits", 4));
      for (const [requestId, about] of [["n-speech", [2]], ["n-future", [9]], ["n-creation", [1]], ["n-order", [5, 4]]] as const) {
        await assert.rejects(engine.execute("perceivers", narrate(requestId, 5, [...about])), errorCode("INVALID_ACTION"));
      }
      const alone = await engine.execute("perceivers", narrate("n5-5", 5, [5], "Mira waits alone."));
      assert.equal(alone.events[0]?.source, "dm");
      assert.deepEqual(await engine.getPerceivers("perceivers", 6), ["mira"]);
      await engine.execute("perceivers", narrate("n4-4", 6, [4], "Bram reaches the ridge."));
      assert.deepEqual(await engine.getPerceivers("perceivers", 7), ["bram", "elowen", "mira"]);
      assert.deepEqual(await engine.replayWorld("perceivers"), await engine.getWorld("perceivers"));
    });

    await t.test("replay detects tampered perceivers", async () => {
      await engine.createWorld(sampleWorld("tampered"));
      await engine.execute("tampered", speak("far", 1, "elowen", "Only I hear this."));
      await admin.query(`INSERT INTO "${schema}".adventure_deliveries (world_id, sequence, character_id)
        VALUES ('tampered', 2, 'mira')`);
      await assert.rejects(engine.replayWorld("tampered"), errorCode("CORRUPT_STORAGE"));
    });

    await t.test("receipt-write failures roll back events, perceivers and snapshot", async () => {
      const initial = await engine.createWorld(sampleWorld("rollback"));
      await admin.query(`ALTER TABLE "${schema}".adventure_receipts
        ADD CONSTRAINT test_receipt_failure CHECK (request_id <> 'fail-write')`);
      try {
        await assert.rejects(engine.execute(initial.id, waitCommand("fail-write")), /test_receipt_failure/);
        assert.deepEqual(await engine.getWorld(initial.id), initial);
        assert.equal((await engine.getEvents(initial.id)).length, 1);
        const deliveries = await admin.query(
          `SELECT count(*)::int AS count FROM "${schema}".adventure_deliveries WHERE world_id = 'rollback'`,
        );
        assert.equal(deliveries.rows[0].count, 0);
        assert.deepEqual(await engine.replayWorld(initial.id), initial);
      } finally {
        await admin.query(`ALTER TABLE "${schema}".adventure_receipts DROP CONSTRAINT test_receipt_failure`);
      }
      assert.equal((await engine.execute(initial.id, waitCommand("fail-write"))).state.revision, 2);
    });

    await t.test("history, perceivers and receipts reject SQL updates, deletes and truncation", async () => {
      for (const table of ["adventure_events", "adventure_receipts", "adventure_deliveries"]) {
        for (const sql of [
          `UPDATE "${schema}".${table} SET world_id = world_id`,
          `DELETE FROM "${schema}".${table}`,
          `TRUNCATE "${schema}".${table} CASCADE`,
        ]) {
          await assert.rejects(admin.query(sql), /append-only/);
        }
      }
      assert.equal((await engine.getEvents("retry")).length, 3);
    });

    await t.test("event pagination is bounded and ordered", async () => {
      const page = await engine.getEvents("retry", 1, 1);
      assert.equal(page.length, 1);
      assert.equal(page[0]?.sequence, 2);
      assert.deepEqual(await engine.getEvents("retry", 3), []);
      await assert.rejects(engine.getEvents("retry", -1), errorCode("INVALID_INPUT"));
      await assert.rejects(engine.getEvents("retry", 0, 1001), errorCode("INVALID_INPUT"));
    });

    await t.test("model-call traces are stored and listed oldest first", async () => {
      await engine.createWorld(sampleWorld("traces"));
      for (const attempt of [1, 2]) {
        await engine.recordTrace({
          worldId: "traces", turnId: "t1-mira", role: "character", actorId: "mira", attempt,
          provider: "scripted", model: "scripted", promptVersion: "test",
          request: { system: "system", prompt: "prompt" }, response: { speech: "Hi.", action: null },
          outcome: attempt === 1 ? "invalid_action" : "committed",
          error: attempt === 1 ? "INVALID_ACTION: No route" : null,
          requestId: "t1-mira", inputTokens: 10, outputTokens: 2, latencyMs: 12.6,
        });
      }
      const traces = await engine.getTraces("traces");
      assert.deepEqual(traces.map((trace) => [trace.attempt, trace.outcome, trace.latencyMs]), [
        [1, "invalid_action", 13],
        [2, "committed", 13],
      ]);
      assert.deepEqual(traces[0]?.response, { speech: "Hi.", action: null });
      assert.deepEqual(traces[0]?.request, { system: "system", prompt: "prompt" });
      assert.deepEqual((await engine.getTraces("traces", 1)).map((trace) => trace.attempt), [2]);
    });

    await t.test("invalid snapshots and valid-but-divergent snapshots fail explicitly", async () => {
      await engine.createWorld(sampleWorld("corrupt"));
      await admin.query(`UPDATE "${schema}".adventure_worlds
        SET state = jsonb_set(state, '{elapsedSeconds}', '99'::jsonb) WHERE id = 'corrupt'`);
      await assert.rejects(engine.replayWorld("corrupt"), errorCode("CORRUPT_STORAGE"));
      await admin.query(`UPDATE "${schema}".adventure_worlds
        SET state = jsonb_set(state, '{characters,0,hp}', '-1'::jsonb) WHERE id = 'corrupt'`);
      await assert.rejects(engine.getWorld("corrupt"), errorCode("CORRUPT_STORAGE"));
    });
  } finally {
    await Promise.all([engine.close(), other.close()]);
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  }
});
