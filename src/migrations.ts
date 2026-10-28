import type { Pool, PoolClient } from "pg";
import { EngineError } from "./model.ts";
import { Replayer } from "./rules.ts";
import { parseStoredEvent } from "./upcast.ts";

interface Migration {
  version: number;
  name: string;
  up(client: PoolClient, namespace: string): Promise<void>;
}

const PAGE_SIZE = 500;

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "phase1_event_log",
    // The Phase 1 schema, verbatim, so databases created by Phase 1 adopt it as a no-op.
    async up(client, ns) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${ns}.adventure_worlds (
          id text PRIMARY KEY,
          state jsonb NOT NULL,
          revision bigint NOT NULL CHECK (revision > 0)
        );
        CREATE TABLE IF NOT EXISTS ${ns}.adventure_events (
          world_id text NOT NULL REFERENCES ${ns}.adventure_worlds(id),
          sequence bigint NOT NULL CHECK (sequence > 0),
          request_id text NOT NULL,
          event jsonb NOT NULL,
          PRIMARY KEY (world_id, sequence),
          UNIQUE (world_id, request_id)
        );
        CREATE TABLE IF NOT EXISTS ${ns}.adventure_receipts (
          world_id text NOT NULL,
          request_id text NOT NULL,
          command jsonb NOT NULL,
          sequence bigint NOT NULL,
          result_state jsonb NOT NULL,
          PRIMARY KEY (world_id, request_id),
          FOREIGN KEY (world_id, sequence)
            REFERENCES ${ns}.adventure_events(world_id, sequence)
        );
        CREATE OR REPLACE FUNCTION ${ns}.reject_history_mutation()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'Adventure history is append-only';
        END;
        $$;
        CREATE OR REPLACE TRIGGER adventure_events_immutable
          BEFORE UPDATE OR DELETE OR TRUNCATE ON ${ns}.adventure_events
          FOR EACH STATEMENT EXECUTE FUNCTION ${ns}.reject_history_mutation();
        CREATE OR REPLACE TRIGGER adventure_receipts_immutable
          BEFORE UPDATE OR DELETE OR TRUNCATE ON ${ns}.adventure_receipts
          FOR EACH STATEMENT EXECUTE FUNCTION ${ns}.reject_history_mutation();
      `);
    },
  },
  {
    version: 2,
    name: "phase2a_turns_and_perception",
    async up(client, ns) {
      await client.query(`
        -- A turn's speech and action events share one request ID.
        ALTER TABLE ${ns}.adventure_events
          DROP CONSTRAINT IF EXISTS adventure_events_world_id_request_id_key;
        -- Receipts reference their first event and count; results come from replay.
        -- Existing receipts each produced exactly one event. result_state is no longer
        -- written; old rows keep theirs because receipts are append-only.
        ALTER TABLE ${ns}.adventure_receipts
          ADD COLUMN event_count integer NOT NULL DEFAULT 1 CHECK (event_count > 0),
          ALTER COLUMN result_state DROP NOT NULL;
        CREATE TABLE ${ns}.adventure_deliveries (
          world_id text NOT NULL,
          sequence bigint NOT NULL,
          character_id text NOT NULL,
          PRIMARY KEY (world_id, character_id, sequence),
          FOREIGN KEY (world_id, sequence)
            REFERENCES ${ns}.adventure_events(world_id, sequence)
        );
        CREATE INDEX adventure_deliveries_event
          ON ${ns}.adventure_deliveries (world_id, sequence);
        CREATE TRIGGER adventure_deliveries_immutable
          BEFORE UPDATE OR DELETE OR TRUNCATE ON ${ns}.adventure_deliveries
          FOR EACH STATEMENT EXECUTE FUNCTION ${ns}.reject_history_mutation();
        -- Diagnostic record of every model call; not part of the canonical history.
        CREATE TABLE ${ns}.adventure_turn_traces (
          id bigserial PRIMARY KEY,
          world_id text NOT NULL REFERENCES ${ns}.adventure_worlds(id),
          turn_id text NOT NULL,
          role text NOT NULL CHECK (role IN ('character', 'dm')),
          actor_id text,
          attempt integer NOT NULL CHECK (attempt > 0),
          provider text NOT NULL,
          model text NOT NULL,
          prompt_version text NOT NULL,
          request jsonb NOT NULL,
          response jsonb,
          outcome text NOT NULL,
          error text,
          request_id text,
          input_tokens integer,
          output_tokens integer,
          latency_ms integer NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX adventure_turn_traces_world
          ON ${ns}.adventure_turn_traces (world_id, id);
      `);
      await rebuildWorlds(client, ns);
    },
  },
  {
    version: 3,
    name: "phase2b_leases_and_costs",
    async up(client, ns) {
      await client.query(`
        -- One scheduler per world. A holder keeps its lease by renewing it before
        -- it expires; an expired lease can be taken over.
        CREATE TABLE ${ns}.adventure_leases (
          world_id text PRIMARY KEY REFERENCES ${ns}.adventure_worlds(id),
          holder text NOT NULL,
          expires_at timestamptz NOT NULL
        );
        -- What each model call was for, and what the provider charged for it.
        ALTER TABLE ${ns}.adventure_turn_traces
          ADD COLUMN task text,
          ADD COLUMN cost double precision;
      `);
    },
  },
  {
    version: 4,
    name: "director_mutes",
    async up(client, ns) {
      await client.query(`
        -- Characters the director has muted: the scheduler skips them until they
        -- are unmuted or cued. Director state, never part of the fiction.
        CREATE TABLE ${ns}.adventure_mutes (
          world_id text NOT NULL REFERENCES ${ns}.adventure_worlds(id),
          character_id text NOT NULL,
          muted_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (world_id, character_id)
        );
      `);
    },
  },
  {
    version: 5,
    name: "phase3_memory_search",
    async up(client, ns) {
      await client.query(`
        -- Full-text search over each event's string fields, for scoped recall.
        -- Queries must use this exact expression to use the index.
        CREATE INDEX adventure_events_search ON ${ns}.adventure_events
          USING gin (jsonb_to_tsvector('english'::regconfig, event -> 'data', '["string"]'::jsonb));
      `);
    },
  },
  {
    version: 6,
    name: "director_setups",
    async up(client, ns) {
      await client.query(`
        -- How the director set up each world's agents: personas, narrator style,
        -- and models. Director state, never part of the fiction; the application
        -- validates its shape.
        CREATE TABLE ${ns}.adventure_setups (
          world_id text PRIMARY KEY REFERENCES ${ns}.adventure_worlds(id),
          setup jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
      `);
    },
  },
  {
    version: 7,
    name: "world_drafts",
    async up(client, ns) {
      await client.query(`
        -- Worlds being written in the creator, with the AI creator's chat log.
        -- Director state like setups; the application validates its shape.
        -- world_id is the world it becomes, chosen when it is published, so it
        -- has no foreign key: the world may not exist yet.
        CREATE TABLE ${ns}.world_drafts (
          id text PRIMARY KEY,
          draft jsonb NOT NULL,
          chat jsonb NOT NULL DEFAULT '[]'::jsonb,
          revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
          world_id text,
          published_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX world_drafts_updated_at ON ${ns}.world_drafts (updated_at DESC);
      `);
    },
  },
];

export const LATEST_SCHEMA_VERSION = migrations.at(-1)!.version;

/**
 * Replays every world with the current rules: rewrites its snapshot in the current
 * state format and records the perceivers of every historical event.
 */
async function rebuildWorlds(client: PoolClient, ns: string): Promise<void> {
  const worlds = await client.query(`SELECT id FROM ${ns}.adventure_worlds ORDER BY id FOR UPDATE`);
  for (const { id } of worlds.rows as { id: string }[]) {
    const replayer = new Replayer();
    let after = 0;
    for (;;) {
      const page = await client.query(
        `SELECT event FROM ${ns}.adventure_events
         WHERE world_id = $1 AND sequence > $2 ORDER BY sequence LIMIT $3`,
        [id, after, PAGE_SIZE],
      );
      for (const row of page.rows) {
        const event = parseStoredEvent(row.event);
        const perceivers = replayer.apply(event);
        if (perceivers.length > 0) {
          await client.query(
            `INSERT INTO ${ns}.adventure_deliveries (world_id, sequence, character_id)
             SELECT $1, $2, unnest($3::text[])`,
            [id, event.sequence, perceivers],
          );
        }
        after = event.sequence;
      }
      if (page.rows.length < PAGE_SIZE) break;
    }
    if (!replayer.state) throw new EngineError("CORRUPT_STORAGE", `World ${id} has no events`);
    await client.query(
      `UPDATE ${ns}.adventure_worlds SET state = $2::jsonb, revision = $3 WHERE id = $1`,
      [id, JSON.stringify(replayer.state), replayer.state.revision],
    );
  }
}

/**
 * Applies pending migrations in one transaction. The advisory lock key matches
 * Phase 1's schema initialization, so old and new processes cannot interleave DDL.
 */
export async function migrate(pool: Pool, schema: string, targetVersion = LATEST_SCHEMA_VERSION): Promise<void> {
  const ns = `"${schema}"`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`dungeons:${ns}`]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${ns}`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${ns}.schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const result = await client.query(`SELECT version FROM ${ns}.schema_migrations`);
    const applied = new Set((result.rows as { version: number }[]).map((row) => row.version));
    const newest = Math.max(0, ...applied);
    if (newest > LATEST_SCHEMA_VERSION) {
      throw new EngineError(
        "CORRUPT_STORAGE",
        `Database schema version ${newest} is newer than this application supports (${LATEST_SCHEMA_VERSION})`,
      );
    }
    for (const migration of migrations) {
      if (migration.version > targetVersion || applied.has(migration.version)) continue;
      await migration.up(client, ns);
      await client.query(
        `INSERT INTO ${ns}.schema_migrations (version, name) VALUES ($1, $2)`,
        [migration.version, migration.name],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
