import { Pool } from "pg";
import type { PoolClient } from "pg";
import { migrate } from "./migrations.ts";
import {
  canonicalJson,
  commandSchema,
  EngineError,
  EVENT_FORMAT,
  parseInput,
  parseStored,
  validateWorld,
  worldSeedSchema,
  worldStateSchema,
} from "./model.ts";
import type { AdventureEvent, WorldState } from "./model.ts";
import { applyEvent, d20, isNarratable, Replayer, resolveCommand } from "./rules.ts";
import type { CommittedEvent, Roll } from "./rules.ts";
import { parseStoredEvent } from "./upcast.ts";

export interface TurnResult {
  events: AdventureEvent[];
  state: WorldState;
}

export interface EngineOptions {
  /** PostgreSQL schema holding the engine's tables. Defaults to `public`. */
  schema?: string;
  /** Dice source for checks. Defaults to a cryptographically random d20. */
  roll?: Roll;
}

export interface TraceInput {
  worldId: string;
  turnId: string;
  role: "character" | "dm";
  actorId: string | null;
  attempt: number;
  provider: string;
  model: string;
  promptVersion: string;
  request: { system: string; prompt: string };
  response: unknown;
  outcome: string;
  error: string | null;
  requestId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
}

export interface TraceRecord extends TraceInput {
  id: number;
  createdAt: string;
}

type Queryable = Pool | PoolClient;

const PAGE_SIZE = 500;

export class AdventureEngine {
  private readonly pool: Pool;
  private readonly schema: string;
  private readonly namespace: string;
  private readonly roll: Roll;

  constructor(connectionString: string, options: EngineOptions = {}) {
    if (!connectionString) throw new EngineError("INVALID_INPUT", "A database connection string is required");
    const schema = options.schema ?? "public";
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) {
      throw new EngineError("INVALID_INPUT", "Invalid database schema name");
    }
    this.pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 10_000 });
    this.schema = schema;
    this.namespace = `"${schema}"`;
    this.roll = options.roll ?? d20;
  }

  /** Creates or upgrades the engine's tables. Run with a direct (unpooled) connection. */
  async initialize(): Promise<void> {
    await migrate(this.pool, this.schema);
  }

  async createWorld(input: unknown): Promise<WorldState> {
    const seed = parseInput(worldSeedSchema, input);
    validateWorld(seed);
    const event: AdventureEvent = {
      v: EVENT_FORMAT,
      worldId: seed.id,
      sequence: 1,
      requestId: "world-created",
      source: "director",
      recordedAt: new Date().toISOString(),
      elapsedSeconds: 0,
      data: { type: "world_created", seed },
    };
    const initial = applyEvent(undefined, event);
    return this.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO ${this.namespace}.adventure_worlds (id, state, revision)
         VALUES ($1, $2::jsonb, 1) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [seed.id, JSON.stringify(initial)],
      );
      if (inserted.rowCount === 1) {
        await this.insertCommitted(client, [{ event, perceivers: [] }]);
        return initial;
      }
      const existing = await client.query(
        `SELECT event FROM ${this.namespace}.adventure_events WHERE world_id = $1 AND sequence = 1`,
        [seed.id],
      );
      const creation = parseStoredEvent(existing.rows[0]?.event);
      if (creation.data.type !== "world_created" || canonicalJson(creation.data.seed) !== canonicalJson(seed)) {
        throw new EngineError("REQUEST_CONFLICT", `World ${seed.id} already exists with a different seed`);
      }
      return this.readState(client, seed.id);
    });
  }

  async getWorld(worldId: string): Promise<WorldState> {
    return this.readState(this.pool, worldId);
  }

  /**
   * Commits one command atomically: a character turn (speech, action, or both) or
   * a DM narration. An identical retry returns the original events and result.
   */
  async execute(worldId: string, input: unknown): Promise<TurnResult> {
    const command = parseInput(commandSchema, input);
    if (command.requestId === "world-created") {
      throw new EngineError("INVALID_INPUT", "The world-created request ID is reserved");
    }
    return this.transaction(async (client) => {
      const state = await this.readState(client, worldId, true);
      const receipt = await client.query(
        `SELECT command, sequence, event_count FROM ${this.namespace}.adventure_receipts
         WHERE world_id = $1 AND request_id = $2`,
        [worldId, command.requestId],
      );
      const previous = receipt.rows[0];
      if (previous) {
        if (canonicalJson(previous.command) !== canonicalJson(command)) {
          throw new EngineError("REQUEST_CONFLICT", "Request ID was already used with different input");
        }
        return this.replayResult(client, worldId, Number(previous.sequence), Number(previous.event_count));
      }
      if (command.expectedRevision !== state.revision) {
        throw new EngineError("STALE_REVISION", `Expected revision ${command.expectedRevision}; current revision is ${state.revision}`);
      }
      const narrationAudience = command.role === "dm"
        ? await this.narrationAudience(client, worldId, state, command.action.aboutSequences)
        : undefined;
      const resolved = resolveCommand(state, command, {
        roll: this.roll,
        recordedAt: new Date().toISOString(),
        ...(narrationAudience ? { narrationAudience } : {}),
      });
      await this.insertCommitted(client, resolved.committed);
      await client.query(
        `UPDATE ${this.namespace}.adventure_worlds SET state = $2::jsonb, revision = $3 WHERE id = $1`,
        [worldId, JSON.stringify(resolved.state), resolved.state.revision],
      );
      await client.query(
        `INSERT INTO ${this.namespace}.adventure_receipts
         (world_id, request_id, command, sequence, event_count)
         VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [worldId, command.requestId, JSON.stringify(command), state.revision + 1, resolved.committed.length],
      );
      return { events: resolved.committed.map((entry) => entry.event), state: resolved.state };
    });
  }

  /** Admin view of the full history. Never send this to a character agent. */
  async getEvents(worldId: string, afterSequence = 0, limit = 100): Promise<AdventureEvent[]> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new EngineError("INVALID_INPUT", "Event cursor must be nonnegative and limit must be between 1 and 1000");
    }
    await this.getWorld(worldId);
    const result = await this.pool.query(
      `SELECT event FROM ${this.namespace}.adventure_events
       WHERE world_id = $1 AND sequence > $2 ORDER BY sequence LIMIT $3`,
      [worldId, afterSequence, limit],
    );
    return result.rows.map((row) => parseStoredEvent(row.event));
  }

  /** The most recent events a character perceived, oldest first. */
  async getPerceivedEvents(worldId: string, characterId: string, limit = 30): Promise<AdventureEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new EngineError("INVALID_INPUT", "Limit must be between 1 and 1000");
    }
    const state = await this.getWorld(worldId);
    if (!state.characters.some((character) => character.id === characterId)) {
      throw new EngineError("NOT_FOUND", `Unknown character: ${characterId}`);
    }
    const result = await this.pool.query(
      `SELECT e.event FROM ${this.namespace}.adventure_events e
       JOIN ${this.namespace}.adventure_deliveries d
         ON d.world_id = e.world_id AND d.sequence = e.sequence
       WHERE e.world_id = $1 AND d.character_id = $2
       ORDER BY e.sequence DESC LIMIT $3`,
      [worldId, characterId, limit],
    );
    return result.rows.map((row) => parseStoredEvent(row.event)).reverse();
  }

  /** Characters who perceived one event, sorted. */
  async getPerceivers(worldId: string, sequence: number): Promise<string[]> {
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new EngineError("INVALID_INPUT", "Sequence must be a positive integer");
    }
    await this.getWorld(worldId);
    const result = await this.pool.query(
      `SELECT character_id FROM ${this.namespace}.adventure_deliveries WHERE world_id = $1 AND sequence = $2`,
      [worldId, sequence],
    );
    return result.rows.map((row) => row.character_id as string).sort();
  }

  /** Rebuilds state and perceivers from events and checks both against storage. */
  async replayWorld(worldId: string): Promise<WorldState> {
    return this.transaction(async (client) => {
      // Hold the world lock so replay and its snapshot comparison see the same history.
      const snapshot = await this.readState(client, worldId, true);
      const replayer = new Replayer();
      for await (const page of this.eventPages(client, worldId)) {
        const stored = await this.deliveries(client, worldId, page[0]!.sequence, page.at(-1)!.sequence);
        for (const event of page) {
          const perceivers = replayer.apply(event);
          if (canonicalJson(stored.get(event.sequence) ?? []) !== canonicalJson(perceivers)) {
            throw new EngineError("CORRUPT_STORAGE", `Stored perceivers of event ${event.sequence} do not match replay`);
          }
        }
      }
      if (!replayer.state || canonicalJson(replayer.state) !== canonicalJson(snapshot)) {
        throw new EngineError("CORRUPT_STORAGE", "Event history does not match the stored world snapshot");
      }
      return replayer.state;
    });
  }

  async recordTrace(trace: TraceInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.namespace}.adventure_turn_traces
       (world_id, turn_id, role, actor_id, attempt, provider, model, prompt_version, request,
        response, outcome, error, request_id, input_tokens, output_tokens, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15, $16)`,
      [
        trace.worldId, trace.turnId, trace.role, trace.actorId, trace.attempt, trace.provider,
        trace.model, trace.promptVersion, JSON.stringify(trace.request),
        trace.response === undefined ? null : JSON.stringify(trace.response), trace.outcome,
        trace.error, trace.requestId, trace.inputTokens, trace.outputTokens, Math.round(trace.latencyMs),
      ],
    );
  }

  /** The most recent model-call traces for a world, oldest first. */
  async getTraces(worldId: string, limit = 20): Promise<TraceRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new EngineError("INVALID_INPUT", "Limit must be between 1 and 1000");
    }
    const result = await this.pool.query(
      `SELECT * FROM ${this.namespace}.adventure_turn_traces
       WHERE world_id = $1 ORDER BY id DESC LIMIT $2`,
      [worldId, limit],
    );
    return result.rows.reverse().map((row) => ({
      id: Number(row.id),
      worldId: row.world_id,
      turnId: row.turn_id,
      role: row.role,
      actorId: row.actor_id,
      attempt: row.attempt,
      provider: row.provider,
      model: row.model,
      promptVersion: row.prompt_version,
      request: row.request,
      response: row.response,
      outcome: row.outcome,
      error: row.error,
      requestId: row.request_id,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      latencyMs: row.latency_ms,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async readState(client: Queryable, worldId: string, lock = false): Promise<WorldState> {
    const result = await client.query(
      `SELECT state, revision FROM ${this.namespace}.adventure_worlds WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
      [worldId],
    );
    const row = result.rows[0];
    if (!row) throw new EngineError("NOT_FOUND", `Unknown world: ${worldId}`);
    const state = parseStored(worldStateSchema, row.state);
    if (state.id !== worldId || String(state.revision) !== String(row.revision)) {
      throw new EngineError("CORRUPT_STORAGE", "Snapshot identity or revision is inconsistent");
    }
    try {
      validateWorld(state);
    } catch (error) {
      if (!(error instanceof EngineError)) throw error;
      throw new EngineError("CORRUPT_STORAGE", error.message);
    }
    return state;
  }

  /** Narration reaches the perceivers of the character actions it describes. */
  private async narrationAudience(
    client: PoolClient,
    worldId: string,
    state: WorldState,
    sequences: number[],
  ): Promise<string[]> {
    if (sequences.some((sequence, index) => (
      sequence < 2 || sequence > state.revision || (index > 0 && sequence <= sequences[index - 1]!)
    ))) {
      throw new EngineError("INVALID_ACTION", "Narration must reference committed events in ascending order");
    }
    const events = await client.query(
      `SELECT event FROM ${this.namespace}.adventure_events WHERE world_id = $1 AND sequence = ANY($2::bigint[])`,
      [worldId, sequences],
    );
    if (events.rows.some((row) => !isNarratable(parseStoredEvent(row.event).data.type))) {
      throw new EngineError("INVALID_ACTION", "Only committed character actions can be narrated");
    }
    const stored = await this.deliveries(client, worldId, sequences[0]!, sequences.at(-1)!);
    return [...new Set(sequences.flatMap((sequence) => stored.get(sequence) ?? []))].sort();
  }

  private async deliveries(
    client: PoolClient,
    worldId: string,
    fromSequence: number,
    toSequence: number,
  ): Promise<Map<number, string[]>> {
    const result = await client.query(
      `SELECT sequence, character_id FROM ${this.namespace}.adventure_deliveries
       WHERE world_id = $1 AND sequence BETWEEN $2 AND $3`,
      [worldId, fromSequence, toSequence],
    );
    const bySequence = new Map<number, string[]>();
    for (const row of result.rows) {
      const sequence = Number(row.sequence);
      bySequence.set(sequence, [...(bySequence.get(sequence) ?? []), row.character_id]);
    }
    // Sort in JavaScript: SQL ordering depends on the database collation.
    for (const characters of bySequence.values()) characters.sort();
    return bySequence;
  }

  private async *eventPages(client: PoolClient, worldId: string, throughSequence = Number.MAX_SAFE_INTEGER) {
    let after = 0;
    for (;;) {
      const result = await client.query(
        `SELECT event FROM ${this.namespace}.adventure_events
         WHERE world_id = $1 AND sequence > $2 AND sequence <= $3 ORDER BY sequence LIMIT $4`,
        [worldId, after, throughSequence, PAGE_SIZE],
      );
      const page = result.rows.map((row) => parseStoredEvent(row.event));
      if (page.length > 0) yield page;
      if (page.length < PAGE_SIZE) return;
      after = page.at(-1)!.sequence;
    }
  }

  /** Reconstructs a committed command's events and the state right after them. */
  private async replayResult(
    client: PoolClient,
    worldId: string,
    firstSequence: number,
    eventCount: number,
  ): Promise<TurnResult> {
    const replayer = new Replayer();
    const events: AdventureEvent[] = [];
    for await (const page of this.eventPages(client, worldId, firstSequence + eventCount - 1)) {
      for (const event of page) {
        replayer.apply(event);
        if (event.sequence >= firstSequence) events.push(event);
      }
    }
    if (!replayer.state || events.length !== eventCount) {
      throw new EngineError("CORRUPT_STORAGE", "Receipt references missing events");
    }
    return { events, state: replayer.state };
  }

  private async insertCommitted(client: PoolClient, committed: CommittedEvent[]): Promise<void> {
    for (const { event, perceivers } of committed) {
      await client.query(
        `INSERT INTO ${this.namespace}.adventure_events (world_id, sequence, request_id, event)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [event.worldId, event.sequence, event.requestId, JSON.stringify(event)],
      );
      if (perceivers.length > 0) {
        await client.query(
          `INSERT INTO ${this.namespace}.adventure_deliveries (world_id, sequence, character_id)
           SELECT $1, $2, unnest($3::text[])`,
          [event.worldId, event.sequence, perceivers],
        );
      }
    }
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
