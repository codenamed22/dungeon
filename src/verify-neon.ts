import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { TLSSocket } from "node:tls";
import { Pool } from "pg";
import { databaseConfig, openConfiguredEngine } from "./config.ts";
import { AdventureEngine } from "./engine.ts";
import { EngineError } from "./model.ts";
import { sampleWorld } from "./sample-world.ts";

const config = databaseConfig();
const schema = `verify_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString: config.databaseUrlUnpooled });
let engine: AdventureEngine | undefined;
try {
  const client = await admin.connect();
  try {
    // Neon terminates client TLS at its proxy, before the backend pg_stat_ssl observes.
    const stream = client.connection.stream;
    assert.ok(stream instanceof TLSSocket, "The direct connection must use TLS");
    assert.equal(stream.authorized, true, "The database certificate must be verified");
    const connection = await client.query("SELECT 1 AS connected");
    assert.equal(connection.rows[0].connected, 1);
    console.log("PASS direct PostgreSQL connection uses verified TLS");
  } finally {
    client.release();
  }

  engine = await openConfiguredEngine({ schema });
  console.log("PASS schema initialization through DATABASE_URL_UNPOOLED");
  const initial = await engine.createWorld(sampleWorld("neon-verification"));
  const command = {
    role: "character", requestId: "give-rope", expectedRevision: initial.revision, actorId: "mira",
    speech: "Take the rope, Bram.",
    action: { type: "transfer_item", recipientId: "bram", itemId: "rope", quantity: 1 },
  };
  const transfer = await engine.execute(initial.id, command);
  assert.equal(transfer.state.characters[1]?.inventory.rope, 1);
  assert.equal(Object.hasOwn(transfer.state.characters[0]!.inventory, "rope"), false);
  assert.deepEqual(transfer.events.map((event) => event.data.type), ["utterance", "item_transferred"]);
  console.log("PASS pooled runtime writes, speech, and inventory transfer in one turn");

  const moved = await engine.execute(initial.id, {
    role: "character", requestId: "walk-to-ridge", expectedRevision: transfer.state.revision, actorId: "mira",
    action: { type: "move", destinationId: "ridge" },
  });
  assert.equal(moved.state.characters[0]?.locationId, "ridge");
  assert.equal(moved.state.elapsedSeconds, 310);
  const heardByElowen = await engine.getPerceivedEvents(initial.id, "elowen");
  assert.deepEqual(heardByElowen.map((event) => event.data.type), ["character_moved"]);
  console.log("PASS movement, in-world time, and perception boundaries");

  await engine.close();
  engine = new AdventureEngine(config.databaseUrl, { schema });
  assert.deepEqual(await engine.getWorld(initial.id), moved.state);
  assert.deepEqual(await engine.replayWorld(initial.id), moved.state);
  console.log("PASS reconnect, durable state, and event replay");

  assert.deepEqual(await engine.execute(initial.id, command), transfer);
  assert.equal((await engine.getEvents(initial.id)).length, 4);
  console.log("PASS original retry receipt survives reconnect without duplicate events");

  await assert.rejects(engine.execute(initial.id, {
    role: "character", requestId: "stale", expectedRevision: 1, actorId: "mira",
    action: { type: "wait", seconds: 60 },
  }), (error: unknown) => error instanceof EngineError && error.code === "STALE_REVISION");
  console.log("PASS stale action rejected");
} finally {
  try {
    if (engine) await engine.close();
  } finally {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      console.log("PASS isolated verification schema removed; existing worlds untouched");
    } finally {
      await admin.end();
    }
  }
}
console.log("Neon PostgreSQL end-to-end verification passed.");
