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
import type { AdventureEvent, EventData, WorldState } from "./model.ts";
import { actorOf, applyEvent, d20, isNarratable, MENTAL_EVENTS, Replayer, resolveCommand, retractionProblem } from "./rules.ts";
import type { CommittedEvent, Evidence, Roll } from "./rules.ts";
import { parseStoredEvent } from "./upcast.ts";

export interface TurnResult {
  events: AdventureEvent[];
  state: WorldState;
}

export interface DraftSummary {
  id: string;
  name: string;
  revision: number;
  worldId: string | null;
  publishedAt: string | null;
  updatedAt: string;
}

export interface DraftRecord extends DraftSummary {
  draft: unknown;
  chat: unknown[];
  createdAt: string;
}

export interface DraftChanges {
  draft?: unknown;
  chat?: unknown[];
  worldId?: string;
  published?: boolean;
}

interface DraftRow {
  id: string;
  draft: { seed?: { name?: unknown } } | null;
  chat: unknown;
  revision: number;
  world_id: string | null;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function draftRecord(row: DraftRow): DraftRecord {
  const name = row.draft?.seed?.name;
  return {
    id: row.id,
    name: typeof name === "string" ? name : row.id,
    revision: row.revision,
    worldId: row.world_id,
    publishedAt: row.published_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    draft: row.draft,
    chat: Array.isArray(row.chat) ? row.chat : [],
  };
}

export interface EngineOptions {
  /** PostgreSQL schema holding the engine's tables. Defaults to `public`. */
  schema?: string;
  /** Dice source for checks. Defaults to a cryptographically random d20. */
  roll?: Roll;
}

/** What a model call was for. */
export type TraceTask = "character_turn" | "npc_turn" | "ruling" | "narration";

export interface TraceInput {
  worldId: string;
  turnId: string;
  role: "character" | "dm";
  /** Null for traces recorded before Phase 2b. */
  task: TraceTask | null;
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
  /** What the provider charged, in its billing unit (OpenRouter credits); null if unreported. */
  cost: number | null;
  latencyMs: number;
}

export interface TraceRecord extends TraceInput {
  id: number;
  createdAt: string;
}

/** An event a character perceived that matched a memory search. */
export interface MemoryMatch {
  event: AdventureEvent;
  /** Full-text relevance; higher is better. */
  rank: number;
  /** The event's text around the matching words, which are marked «like this»; null for events without text. */
  snippet: string | null;
}

/** A world as listed for the director. */
export interface WorldSummary {
  id: string;
  name: string;
  revision: number;
  elapsedSeconds: number;
  /** When its latest event was recorded. */
  updatedAt: string;
}

export interface PerceivedFilter {
  /** Only events of these types. */
  types?: readonly EventData["type"][];
  /** No events of these types. */
  exclude?: readonly EventData["type"][];
}

type Queryable = Pool | PoolClient;

const PAGE_SIZE = 500;

/** The words of an event's string fields; migration 5 indexes this exact expression. */
const SEARCH_VECTOR = `jsonb_to_tsvector('english'::regconfig, e.event -> 'data', '["string"]'::jsonb)`;

/** SQL true for an event `e` that a later retcon withdrew; agents never see those. `ns` is the schema. */
const retracted = (ns: string) => `EXISTS (
  SELECT 1 FROM ${ns}.adventure_events r
  WHERE r.world_id = e.world_id AND r.sequence > e.sequence
    AND r.event -> 'data' ->> 'type' = 'retraction'
    AND (r.event -> 'data' ->> 'targetSequence')::bigint = e.sequence)`;

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

  /** The world's current revision, read cheaply, for watchers polling for new events. */
  async getRevision(worldId: string): Promise<number> {
    const result = await this.pool.query(`SELECT revision FROM ${this.namespace}.adventure_worlds WHERE id = $1`, [worldId]);
    if (!result.rows[0]) throw new EngineError("NOT_FOUND", `Unknown world: ${worldId}`);
    return Number(result.rows[0].revision);
  }

  /** Every world, most recently active first. */
  async listWorlds(): Promise<WorldSummary[]> {
    const result = await this.pool.query(
      `SELECT w.id, w.state ->> 'name' AS name, w.revision, (w.state ->> 'elapsedSeconds')::bigint AS elapsed,
              e.event ->> 'recordedAt' AS updated_at
       FROM ${this.namespace}.adventure_worlds w
       JOIN ${this.namespace}.adventure_events e ON e.world_id = w.id AND e.sequence = w.revision
       ORDER BY updated_at DESC, w.id`,
    );
    return result.rows.map((row) => ({
      id: row.id, name: row.name, revision: Number(row.revision), elapsedSeconds: Number(row.elapsed), updatedAt: row.updated_at,
    }));
  }

  /**
   * Forks a world at a revision into a new world with the same history up to
   * that point, replayed and checked; its agent setup comes along. The fork
   * point must end a request, so no turn is split.
   */
  async branchWorld(sourceId: string, throughSequence: number, newId: string, name?: string): Promise<WorldState> {
    const source = await this.getWorld(sourceId);
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 1 || throughSequence > source.revision) {
      throw new EngineError("INVALID_INPUT", `A branch point must be a revision from 1 to ${source.revision}`);
    }
    return this.transaction(async (client) => {
      const boundary = await client.query(
        `SELECT sequence, request_id FROM ${this.namespace}.adventure_events
         WHERE world_id = $1 AND sequence IN ($2, $3)`,
        [sourceId, throughSequence, throughSequence + 1],
      );
      const requestAt = (sequence: number) => boundary.rows.find((row) => Number(row.sequence) === sequence)?.request_id;
      if (requestAt(throughSequence + 1) !== undefined && requestAt(throughSequence + 1) === requestAt(throughSequence)) {
        throw new EngineError("INVALID_INPUT", `Revision ${throughSequence} is in the middle of a turn; branch where a turn ends`);
      }
      const replayer = new Replayer();
      const committed: CommittedEvent[] = [];
      for await (const page of this.eventPages(client, sourceId, throughSequence)) {
        for (const stored of page) {
          const event: AdventureEvent = { ...stored, worldId: newId };
          if (event.data.type === "world_created") {
            event.data = { ...event.data, seed: { ...event.data.seed, id: newId, ...(name === undefined ? {} : { name }) } };
          }
          committed.push({ event, perceivers: replayer.apply(event) });
        }
      }
      const state = replayer.state!;
      const inserted = await client.query(
        `INSERT INTO ${this.namespace}.adventure_worlds (id, state, revision)
         VALUES ($1, $2::jsonb, $3) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [newId, JSON.stringify(state), state.revision],
      );
      if (inserted.rowCount !== 1) throw new EngineError("REQUEST_CONFLICT", `World ${newId} already exists`);
      await this.insertCommitted(client, committed);
      await client.query(
        `INSERT INTO ${this.namespace}.adventure_receipts (world_id, request_id, command, sequence, result_state, event_count)
         SELECT $2, request_id, command, sequence, result_state, event_count FROM ${this.namespace}.adventure_receipts
         WHERE world_id = $1 AND sequence + event_count - 1 <= $3`,
        [sourceId, newId, throughSequence],
      );
      await client.query(
        `INSERT INTO ${this.namespace}.adventure_setups (world_id, setup)
         SELECT $2, setup FROM ${this.namespace}.adventure_setups WHERE world_id = $1`,
        [sourceId, newId],
      );
      return state;
    });
  }

  /**
   * Commits one command atomically: a character turn (speech, action, or both,
   * with the DM's ruling on an attempt), an NPC turn, or a narration. An identical
   * retry returns the original events and result.
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
      const audience = command.role === "dm"
        ? await this.narrationAudience(client, worldId, state, command.action.aboutSequences)
        : command.role === "director" && command.action.type === "retcon"
          ? await this.retconAudience(client, worldId, command.action.sequence)
          : undefined;
      const evidence = command.role === "character" && command.note
        ? await this.evidence(client, worldId, command.note.evidence)
        : new Map<number, Evidence>();
      const resolved = resolveCommand(state, command, {
        roll: this.roll,
        recordedAt: new Date().toISOString(),
        evidence: (sequence) => evidence.get(sequence),
        ...(audience ? { audience } : {}),
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
  async getPerceivedEvents(
    worldId: string,
    characterId: string,
    limit = 30,
    filter: PerceivedFilter = {},
  ): Promise<AdventureEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new EngineError("INVALID_INPUT", "Limit must be between 1 and 1000");
    }
    await this.requireCharacter(worldId, characterId);
    const result = await this.pool.query(
      `SELECT e.event FROM ${this.namespace}.adventure_events e
       JOIN ${this.namespace}.adventure_deliveries d
         ON d.world_id = e.world_id AND d.sequence = e.sequence
       WHERE e.world_id = $1 AND d.character_id = $2
         AND ($4::text[] IS NULL OR e.event -> 'data' ->> 'type' = ANY($4::text[]))
         AND NOT (e.event -> 'data' ->> 'type' = ANY($5::text[]))
         AND NOT ${retracted(this.namespace)}
       ORDER BY e.sequence DESC LIMIT $3`,
      [worldId, characterId, limit, filter.types ?? null, filter.exclude ?? []],
    );
    return result.rows.map((row) => parseStoredEvent(row.event)).reverse();
  }

  /**
   * Full-text search over the events a character perceived before `before`,
   * leaving out its thoughts (notes and goals). The deliveries join enforces
   * permission inside the query, so an event the character did not perceive
   * never ranks, and never reaches a snippet, which is made only for results.
   */
  async searchMemories(
    worldId: string,
    characterId: string,
    query: string,
    options: { before?: number; limit?: number } = {},
  ): Promise<MemoryMatch[]> {
    const limit = options.limit ?? 20;
    const before = options.before ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(before) || before < 1) {
      throw new EngineError("INVALID_INPUT", "Limit must be between 1 and 100, and before a positive sequence");
    }
    if (query.length > 500) throw new EngineError("INVALID_INPUT", "A memory search is at most 500 characters");
    await this.requireCharacter(worldId, characterId);
    if (!query.trim()) return [];
    const result = await this.pool.query(
      `WITH matches AS (
         SELECT e.sequence, e.event, q.query, ts_rank(${SEARCH_VECTOR}, q.query) AS rank
         FROM ${this.namespace}.adventure_events e
         JOIN ${this.namespace}.adventure_deliveries d
           ON d.world_id = e.world_id AND d.sequence = e.sequence AND d.character_id = $2
         CROSS JOIN websearch_to_tsquery('english', $3) AS q(query)
         WHERE e.world_id = $1 AND e.sequence < $4
           AND NOT (e.event -> 'data' ->> 'type' = ANY($5::text[]))
           AND NOT ${retracted(this.namespace)}
           AND ${SEARCH_VECTOR} @@ q.query
         ORDER BY rank DESC, e.sequence DESC
         LIMIT $6
       )
       SELECT event, rank,
         CASE WHEN event -> 'data' ? 'text' THEN ts_headline('english', event -> 'data' ->> 'text', query,
           'MaxWords=20, MinWords=8, StartSel=«, StopSel=»') END AS snippet
       FROM matches ORDER BY rank DESC, sequence DESC`,
      [worldId, characterId, query, before, MENTAL_EVENTS, limit],
    );
    return result.rows.map((row) => ({ event: parseStoredEvent(row.event), rank: Number(row.rank), snippet: row.snippet }));
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
       (world_id, turn_id, role, task, actor_id, attempt, provider, model, prompt_version, request,
        response, outcome, error, request_id, input_tokens, output_tokens, cost, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16, $17, $18)`,
      [
        trace.worldId, trace.turnId, trace.role, trace.task, trace.actorId, trace.attempt, trace.provider,
        trace.model, trace.promptVersion, JSON.stringify(trace.request),
        trace.response === undefined ? null : JSON.stringify(trace.response), trace.outcome,
        trace.error, trace.requestId, trace.inputTokens, trace.outputTokens, trace.cost, Math.round(trace.latencyMs),
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
      task: row.task,
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
      cost: row.cost,
      latencyMs: row.latency_ms,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  /**
   * Takes or renews a world's scheduler lease for `ttlMs`. Returns false while
   * another holder's lease is unexpired. Expiry uses the database clock, so
   * schedulers on different machines agree on it.
   */
  async acquireLease(worldId: string, holder: string, ttlMs: number): Promise<boolean> {
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || !holder) {
      throw new EngineError("INVALID_INPUT", "A lease needs a holder and a positive whole number of milliseconds");
    }
    await this.getWorld(worldId);
    const result = await this.pool.query(
      `INSERT INTO ${this.namespace}.adventure_leases (world_id, holder, expires_at)
       VALUES ($1, $2, clock_timestamp() + $3::double precision * interval '1 millisecond')
       ON CONFLICT (world_id) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
       WHERE adventure_leases.holder = EXCLUDED.holder OR adventure_leases.expires_at <= clock_timestamp()
       RETURNING holder`,
      [worldId, holder, ttlMs],
    );
    return result.rowCount === 1;
  }

  /** Gives up a lease; does nothing if the holder no longer has it. */
  async releaseLease(worldId: string, holder: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM ${this.namespace}.adventure_leases WHERE world_id = $1 AND holder = $2`,
      [worldId, holder],
    );
  }

  /** Characters the director has muted, sorted. The scheduler skips them; a cue still runs them. */
  async getMuted(worldId: string): Promise<string[]> {
    await this.getWorld(worldId);
    const result = await this.pool.query(
      `SELECT character_id FROM ${this.namespace}.adventure_mutes WHERE world_id = $1 ORDER BY character_id`,
      [worldId],
    );
    return result.rows.map((row) => row.character_id);
  }

  /** Mutes or unmutes characters, and returns who is muted now. Repeating a change does nothing. */
  async setMuted(worldId: string, characterIds: string[], muted: boolean): Promise<string[]> {
    const state = await this.getWorld(worldId);
    for (const characterId of characterIds) {
      if (!state.characters.some((character) => character.id === characterId)) {
        throw new EngineError("NOT_FOUND", `Unknown character: ${characterId}`);
      }
    }
    await this.pool.query(
      muted
        ? `INSERT INTO ${this.namespace}.adventure_mutes (world_id, character_id)
           SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`
        : `DELETE FROM ${this.namespace}.adventure_mutes WHERE world_id = $1 AND character_id = ANY($2::text[])`,
      [worldId, characterIds],
    );
    return this.getMuted(worldId);
  }

  /** The director's setup for a world's agents, as saved; null if none was saved. The caller validates it. */
  async getSetup(worldId: string): Promise<unknown> {
    await this.getWorld(worldId);
    const result = await this.pool.query(
      `SELECT setup FROM ${this.namespace}.adventure_setups WHERE world_id = $1`,
      [worldId],
    );
    return result.rows[0]?.setup ?? null;
  }

  async saveSetup(worldId: string, setup: unknown): Promise<void> {
    await this.getWorld(worldId);
    await this.pool.query(
      `INSERT INTO ${this.namespace}.adventure_setups (world_id, setup) VALUES ($1, $2::jsonb)
       ON CONFLICT (world_id) DO UPDATE SET setup = EXCLUDED.setup, updated_at = now()`,
      [worldId, JSON.stringify(setup)],
    );
  }

  async listDrafts(): Promise<DraftSummary[]> {
    const result = await this.pool.query(
      `SELECT id, draft -> 'seed' ->> 'name' AS name, revision, world_id, published_at, updated_at
       FROM ${this.namespace}.world_drafts ORDER BY updated_at DESC, id LIMIT 200`,
    );
    return result.rows.map((row) => ({
      id: row.id, name: row.name ?? row.id, revision: row.revision, worldId: row.world_id,
      publishedAt: row.published_at?.toISOString() ?? null, updatedAt: row.updated_at.toISOString(),
    }));
  }

  /** A draft as saved; the caller validates its contents. */
  async getDraft(id: string): Promise<DraftRecord> {
    const result = await this.pool.query(`SELECT * FROM ${this.namespace}.world_drafts WHERE id = $1`, [id]);
    if (result.rowCount === 0) throw new EngineError("NOT_FOUND", `Unknown draft: ${id}`);
    return draftRecord(result.rows[0]);
  }

  async createDraft(id: string, draft: unknown): Promise<DraftRecord> {
    const result = await this.pool.query(
      `INSERT INTO ${this.namespace}.world_drafts (id, draft) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING RETURNING *`,
      [id, JSON.stringify(draft)],
    );
    if (result.rowCount === 0) throw new EngineError("REQUEST_CONFLICT", `Draft ${id} already exists`);
    return draftRecord(result.rows[0]);
  }

  /**
   * Changes a draft that is still at `expectedRevision`. A new draft raises the
   * revision; the chat log, world ID, and publication do not. Published drafts
   * are read-only.
   */
  async updateDraft(id: string, expectedRevision: number, changes: DraftChanges): Promise<DraftRecord> {
    const result = await this.pool.query(
      `UPDATE ${this.namespace}.world_drafts SET
         draft = COALESCE($3::jsonb, draft),
         revision = revision + CASE WHEN $3::jsonb IS NULL THEN 0 ELSE 1 END,
         chat = COALESCE($4::jsonb, chat),
         world_id = COALESCE($5, world_id),
         published_at = CASE WHEN $6 THEN now() ELSE published_at END,
         updated_at = now()
       WHERE id = $1 AND revision = $2 AND published_at IS NULL
       RETURNING *`,
      [
        id, expectedRevision,
        changes.draft === undefined ? null : JSON.stringify(changes.draft),
        changes.chat === undefined ? null : JSON.stringify(changes.chat),
        changes.worldId ?? null,
        changes.published === true,
      ],
    );
    if (result.rowCount === 1) return draftRecord(result.rows[0]);
    const current = await this.getDraft(id);
    if (current.publishedAt !== null) throw new EngineError("REQUEST_CONFLICT", `Draft ${id} has become a world and can no longer change`);
    throw new EngineError("STALE_REVISION", `Draft ${id} is at revision ${current.revision}, not ${expectedRevision}`);
  }

  async deleteDraft(id: string): Promise<void> {
    const result = await this.pool.query(`DELETE FROM ${this.namespace}.world_drafts WHERE id = $1`, [id]);
    if (result.rowCount === 0) throw new EngineError("NOT_FOUND", `Unknown draft: ${id}`);
  }

  /** Who perceived each event in a range of sequences, for the admin view. */
  async getPerceiverMap(worldId: string, fromSequence: number, toSequence: number): Promise<Map<number, string[]>> {
    await this.getWorld(worldId);
    return this.deliveries(this.pool, worldId, fromSequence, toSequence);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async requireCharacter(worldId: string, characterId: string): Promise<void> {
    const state = await this.getWorld(worldId);
    if (!state.characters.some((character) => character.id === characterId)) {
      throw new EngineError("NOT_FOUND", `Unknown character: ${characterId}`);
    }
  }

  /** Committed events a note cites, with their perceivers; resolution checks the writer perceived each. */
  private async evidence(client: PoolClient, worldId: string, sequences: number[]): Promise<Map<number, Evidence>> {
    const cited = new Map<number, Evidence>();
    if (sequences.length === 0) return cited;
    const events = await client.query(
      `SELECT event FROM ${this.namespace}.adventure_events WHERE world_id = $1 AND sequence = ANY($2::bigint[])`,
      [worldId, sequences],
    );
    const perceivers = await client.query(
      `SELECT sequence, character_id FROM ${this.namespace}.adventure_deliveries
       WHERE world_id = $1 AND sequence = ANY($2::bigint[])`,
      [worldId, sequences],
    );
    for (const row of events.rows) {
      const event = parseStoredEvent(row.event);
      cited.set(event.sequence, {
        type: event.data.type,
        actorId: actorOf(event.data),
        perceivers: perceivers.rows
          .filter((entry) => Number(entry.sequence) === event.sequence)
          .map((entry) => entry.character_id as string),
      });
    }
    return cited;
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

  /** A retcon reaches whoever perceived the event it withdraws, which must be withdrawable. */
  private async retconAudience(client: PoolClient, worldId: string, sequence: number): Promise<string[]> {
    const target = await client.query(
      `SELECT event FROM ${this.namespace}.adventure_events WHERE world_id = $1 AND sequence = $2 AND sequence > 1`,
      [worldId, sequence],
    );
    const earlier = await client.query(
      `SELECT 1 FROM ${this.namespace}.adventure_events
       WHERE world_id = $1 AND event -> 'data' ->> 'type' = 'retraction' AND (event -> 'data' ->> 'targetSequence')::bigint = $2`,
      [worldId, sequence],
    );
    const event = target.rows[0] ? parseStoredEvent(target.rows[0].event) : undefined;
    const problem = retractionProblem(event, (earlier.rowCount ?? 0) > 0);
    if (problem) throw new EngineError("INVALID_ACTION", `Cannot retcon #${sequence}: ${problem}`);
    return (await this.deliveries(client, worldId, sequence, sequence)).get(sequence) ?? [];
  }

  private async deliveries(
    client: Queryable,
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
