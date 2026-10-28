import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { AdventureEngine } from "../src/engine.ts";
import { migrate, migrations } from "../src/migrations.ts";
import { sampleWorld } from "../src/sample-world.ts";
import { errorCode, PHASE1_SEED, phase1Events } from "./support.ts";

const connectionString = process.env.TEST_DATABASE_URL;

/** Creates the Phase 1 schema (no migrations table) holding a Phase 1 world. */
async function phase1Database(admin: Pool, schema: string, events = phase1Events()): Promise<void> {
  const ns = `"${schema}"`;
  await migrate(admin, schema, 1);
  await admin.query(`DROP TABLE ${ns}.schema_migrations`);
  // The Phase 1 snapshot after phase1Events(): Mira gave Bram the rope, failed the
  // trap, and walked to the ridge; Elowen waited.
  const snapshot = JSON.parse(JSON.stringify({ ...PHASE1_SEED, revision: events.length, elapsedMinutes: 8 }));
  Object.assign(snapshot.characters[0], { hp: 7, locationId: "ridge", inventory: {} });
  snapshot.characters[1].inventory = { torch: 2, rope: 1 };
  await admin.query(
    `INSERT INTO ${ns}.adventure_worlds (id, state, revision) VALUES ($1, $2, $3)`,
    [PHASE1_SEED.id, JSON.stringify(snapshot), events.length],
  );
  for (const event of events) {
    await admin.query(
      `INSERT INTO ${ns}.adventure_events (world_id, sequence, request_id, event) VALUES ($1, $2, $3, $4)`,
      [event.worldId, event.sequence, event.requestId, JSON.stringify(event)],
    );
  }
  await admin.query(
    `INSERT INTO ${ns}.adventure_receipts (world_id, request_id, command, sequence, result_state)
     VALUES ($1, 'rest', $2, $3, $4)`,
    [
      PHASE1_SEED.id,
      JSON.stringify({ requestId: "rest", expectedRevision: 4, actorId: "elowen", action: { type: "wait", minutes: 1 } }),
      events.length,
      JSON.stringify(snapshot),
    ],
  );
}

async function versions(admin: Pool, schema: string): Promise<number[]> {
  const result = await admin.query(`SELECT version FROM "${schema}".schema_migrations ORDER BY version`);
  return result.rows.map((row) => row.version);
}

test("schema migrations", {
  skip: connectionString ? false : "Set TEST_DATABASE_URL to run real PostgreSQL integration tests",
}, async (t) => {
  assert.ok(connectionString);
  const admin = new Pool({ connectionString });
  const schemas: string[] = [];
  const freshSchema = () => {
    const schema = `test_${randomUUID().replaceAll("-", "")}`;
    schemas.push(schema);
    return schema;
  };
  try {
    await t.test("a Phase 1 database upgrades in place and keeps playing", async () => {
      const schema = freshSchema();
      await phase1Database(admin, schema);
      const engine = new AdventureEngine(connectionString, { schema });
      try {
        await engine.initialize();
        assert.deepEqual(await versions(admin, schema), migrations.map((migration) => migration.version));
        assert.deepEqual(await engine.listDrafts(), []);
        const upgraded = await engine.getWorld(PHASE1_SEED.id);
        assert.equal(upgraded.elapsedSeconds, 480);
        assert.equal(upgraded.speechSeconds, 10);
        assert.equal(upgraded.characters[0]?.hp, 7);
        assert.deepEqual(await engine.replayWorld(PHASE1_SEED.id), upgraded);
        assert.deepEqual((await engine.getPerceivedEvents(PHASE1_SEED.id, "elowen")).map((event) => event.sequence), [4, 5]);
        // The converted sample world matches the upcast Phase 1 seed, so it resumes.
        assert.deepEqual(await engine.createWorld(sampleWorld()), upgraded);
        const next = await engine.execute(PHASE1_SEED.id, {
          role: "character", requestId: "hello", expectedRevision: 5, actorId: "mira",
          speech: "Elowen, I'm here.", action: { type: "wait", seconds: 60 },
        });
        assert.deepEqual(next.events.map((event) => event.sequence), [6, 7]);
        assert.deepEqual(await engine.replayWorld(PHASE1_SEED.id), next.state);
        await engine.initialize();
        assert.deepEqual(await engine.getWorld(PHASE1_SEED.id), next.state);
      } finally {
        await engine.close();
      }
    });

    await t.test("a failed migration changes nothing", async () => {
      const schema = freshSchema();
      const events = phase1Events();
      // A Phase 1 event that contradicts the rules: the walk takes one minute, not five.
      events[3]!.data.minutes = 1;
      await phase1Database(admin, schema, events);
      await assert.rejects(migrate(admin, schema), errorCode("CORRUPT_STORAGE"));
      const tables = await admin.query(
        `SELECT to_regclass($1) AS deliveries, to_regclass($2) AS migrations`,
        [`"${schema}".adventure_deliveries`, `"${schema}".schema_migrations`],
      );
      assert.deepEqual(tables.rows[0], { deliveries: null, migrations: null });
    });

    await t.test("migrations are idempotent and concurrent runs serialize", async () => {
      const schema = freshSchema();
      await Promise.all([migrate(admin, schema), migrate(admin, schema)]);
      await migrate(admin, schema);
      assert.deepEqual(await versions(admin, schema), migrations.map((migration) => migration.version));
    });

    await t.test("a database newer than this application is refused", async () => {
      const schema = freshSchema();
      await migrate(admin, schema);
      await admin.query(`INSERT INTO "${schema}".schema_migrations (version, name) VALUES (999, 'future')`);
      await assert.rejects(migrate(admin, schema), errorCode("CORRUPT_STORAGE"));
    });
  } finally {
    try {
      for (const schema of schemas) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  }
});
