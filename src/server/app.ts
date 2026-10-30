import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { z } from "zod";
import { ADVENTURES, castForWorld, findAdventure } from "../adventures/index.ts";
import { describeEvent, formatClock } from "../agents/context.ts";
import { agentPrompts, direct, memoryReport } from "../agents/inspect.ts";
import { computeMetrics } from "../agents/metrics.ts";
import {
  capabilitiesOf, creatorModelFromEnv, creatorSettingsFromEnv, DEFAULT_OPENROUTER_MODEL, fetchOpenRouterModels, OpenRouterChat,
  REASONING_EFFORTS,
} from "../agents/openrouter.ts";
import type { OpenRouterModel } from "../agents/openrouter.ts";
import { frameOf, judgeSystemPrompt, narratorSystemPrompt, refereeSystemPrompt } from "../agents/prompts.ts";
import { ProviderConfigError } from "../agents/provider.ts";
import { Lease } from "../agents/runner.ts";
import { BUILD_STEP_IDS } from "../creator/steps.ts";
import { loadSetup, parseSetup, placeholderCast, resolvedModels } from "../agents/setup.ts";
import type { Setup } from "../agents/setup.ts";
import type { AdventureEngine } from "../engine.ts";
import { exportDesign, exportSave, importWorldFile, worldFileName } from "../exchange.ts";
import type { WorldFile } from "../exchange.ts";
import { EngineError } from "../model.ts";
import type { AdventureEvent, WorldState } from "../model.ts";
import { allowedEmail, AUTH_BASE_PATH, createAuth } from "./auth.ts";
import type { AuthSettings, DirectorAuth } from "./auth.ts";
import { DraftService } from "./drafts.ts";
import { EditorService } from "./editor.ts";
import { isRehearsable, requireRehearsable } from "./runs.ts";
import type { RunManager, RunStatus } from "./runs.ts";

// The web director's HTTP API, its live event stream, and the built web UI.
// It exposes every character's private context and spends model credit, so it
// answers only to the host names it is given (localhost by default), only
// accepts writes that come from them, and, with Google sign-in on, serves its
// API only to allowed accounts.

export interface AppOptions {
  engine: AdventureEngine;
  runs: RunManager;
  env: NodeJS.ProcessEnv;
  /** Host names the server answers to; a guard against DNS rebinding. */
  allowedHosts: readonly string[];
  /** The built web UI; null serves only the API. */
  staticDir: string | null;
  /** Google sign-in; null or absent means no login, for a server kept to this machine. */
  auth?: AuthSettings | null;
  /** How often an event stream checks for new events. */
  pollMs?: number;
  fetchModels?: () => Promise<OpenRouterModel[]>;
  /** How the AI creator reaches OpenRouter; tests simulate it. */
  creatorFetch?: typeof fetch;
}

/** An event as the director sees it: everything, described for the admin, with who perceived it. */
export interface EventView {
  sequence: number;
  requestId: string;
  source: AdventureEvent["source"];
  elapsedSeconds: number;
  clock: string;
  type: AdventureEvent["data"]["type"];
  data: AdventureEvent["data"];
  line: string;
  perceivers: string[];
}

/** A world as the director's page shows it. Never send any of it to an agent. */
export interface WorldView {
  world: WorldState;
  muted: string[];
  setup: Setup;
  /** Whether the setup was saved, or is the default for the world's adventure. */
  setupSaved: boolean;
  /** The models the setup plays, after fallbacks. */
  models: { character: string; dm: string };
  run: RunStatus | null;
  /** Whether OPENROUTER_API_KEY is set; never the key itself. */
  keyConfigured: boolean;
  /** Whether the scripted opening can play: a new Dry Aqueduct world only. */
  rehearsable: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  isDefault: boolean;
  output: "structured" | "json" | "text";
  promptPerMillion: number | null;
  completionPerMillion: number | null;
  contextLength: number | null;
  /** Whether it can call tools, which the AI creator needs. */
  tools: boolean;
  reasoning: boolean;
  efforts: string[] | null;
  defaultEffort: string | null;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const STATUS_BY_CODE: Record<EngineError["code"], number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  STALE_REVISION: 409,
  REQUEST_CONFLICT: 409,
  INVALID_ACTION: 422,
  WORLD_BUSY: 409,
  DRAFT_BUSY: 409,
  CORRUPT_STORAGE: 500,
};

const MAX_BODY_BYTES = 512 * 1024;
/** A world's whole history can be large; only an import may send this much. */
const MAX_IMPORT_BYTES = 16 * 1024 * 1024;
const MAX_FORM_BYTES = 64 * 1024;
/** A sample chat file's characters take up to three bytes each, and up to six escaped in JSON. */
const MAX_SAMPLE_BYTES = 8 * 1024 * 1024;
const MODEL_CACHE_MS = 10 * 60_000;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const routeRef = z.object({ fromId: z.string(), destinationId: z.string() });
const bodies = {
  createWorld: z.object({
    id: z.string(),
    name: z.string().optional(),
    adventureId: z.string().optional(),
    seed: z.record(z.string(), z.unknown()).optional(),
  }),
  branch: z.object({ through: z.number(), id: z.string(), name: z.string().optional() }),
  mute: z.object({ characterIds: z.array(z.string()).min(1).max(50), muted: z.boolean() }),
  steer: z.object({ text: z.string(), targetId: z.string().optional() }),
  introduce: z.object({
    text: z.string(),
    locationIds: z.array(z.string()).optional(),
    lockRoutes: z.array(routeRef).optional(),
    unlockRoutes: z.array(routeRef).optional(),
  }),
  /** `replacement` rewords the line; otherwise it is withdrawn, with `text` as a correction if given. */
  retcon: z.object({ sequence: z.number(), text: z.string().optional(), replacement: z.string().optional() }),
  /** Takes the story back to before `fromSequence`, which starts a turn. */
  wipe: z.object({ fromSequence: z.number() }),
  enter: z.object({ characterId: z.string(), locationId: z.string(), text: z.string().optional() }),
  exit: z.object({ characterId: z.string(), text: z.string().optional() }),
  step: z.object({ actorId: z.string().optional() }),
  createDraft: z.object({ adventureId: z.string().optional(), name: z.string().max(100).optional() }),
  saveDraft: z.object({ draft: z.unknown(), expectedRevision: z.number().int().positive() }),
  publishDraft: z.object({ worldId: z.string(), expectedRevision: z.number().int().positive() }),
  addSample: z.object({ name: z.string(), text: z.string() }),
  assistant: z.object({
    message: z.string().trim().min(1).max(16_000),
    model: z.string().max(200).optional(),
    effort: z.enum([...REASONING_EFFORTS, "default"]).optional(),
    step: z.enum(BUILD_STEP_IDS).optional(),
    expectedRevision: z.number().int().positive(),
  }),
  editor: z.object({
    message: z.string().trim().min(1).max(16_000),
    pass: z.enum(["review", "fix"]),
    model: z.string().max(200).optional(),
  }),
  run: z.object({
    turns: z.number(),
    maxModelCalls: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    maxCost: z.number().positive().optional(),
  }),
};

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, `Invalid request body: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ")}`);
  return parsed.data;
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, "Request body is too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const body = await readBody(request, maxBytes);
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body is not valid JSON");
  }
}

/** Passes a request under /api/auth to Auth.js and writes its answer, every cookie included. */
async function answerAuth(request: IncomingMessage, response: ServerResponse, auth: DirectorAuth): Promise<void> {
  const method = request.method ?? "GET";
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, item);
  }
  const body = method === "GET" || method === "HEAD" ? null : new Uint8Array(await readBody(request, MAX_FORM_BYTES));
  const reply = await auth.handle(new Request(new URL(request.url ?? "/", auth.origin), { method, headers, body }));
  const out: Record<string, string | string[]> = {};
  reply.headers.forEach((value, name) => {
    if (name !== "set-cookie") out[name] = value;
  });
  const cookies = reply.headers.getSetCookie();
  if (cookies.length > 0) out["set-cookie"] = cookies;
  response.writeHead(reply.status, out);
  response.end(Buffer.from(await reply.arrayBuffer()));
}

/** A world file, as a download. A design is indented, since people read and change it; a save can be large. */
function sendWorldFile(response: ServerResponse, file: WorldFile): void {
  const text = JSON.stringify(file, null, file.kind === "design" ? 2 : undefined);
  response.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Content-Disposition": `attachment; filename="${worldFileName(file)}"`,
    "Cache-Control": "no-store",
  });
  response.end(text);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  response.end(text);
}

function hostnameOf(host: string | undefined): string | null {
  if (!host) return null;
  try {
    return new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

function perMillion(price: string | null | undefined): number | null {
  const value = price ? Number(price) : Number.NaN;
  return Number.isFinite(value) && value >= 0 ? value * 1_000_000 : null;
}

export function createApp(options: AppOptions): (request: IncomingMessage, response: ServerResponse) => void {
  const { engine, runs, env } = options;
  const pollMs = options.pollMs ?? 700;
  const allowed = new Set(options.allowedHosts);
  const fetchModels = options.fetchModels ?? (() => fetchOpenRouterModels());
  const drafts = new DraftService(engine);
  const editor = new EditorService(engine);
  const auth = options.auth ? createAuth(options.auth, env) : null;
  let modelCache: { at: number; models: OpenRouterModel[] } | null = null;

  const keyConfigured = () => Boolean(env.OPENROUTER_API_KEY?.trim());

  async function eventViews(worldId: string, state: WorldState, after: number, limit: number): Promise<EventView[]> {
    const events = await engine.getEvents(worldId, after, limit);
    if (events.length === 0) return [];
    const perceivers = await engine.getPerceiverMap(worldId, events[0]!.sequence, events.at(-1)!.sequence);
    return events.map((event) => ({
      sequence: event.sequence,
      requestId: event.requestId,
      source: event.source,
      elapsedSeconds: event.elapsedSeconds,
      clock: formatClock(event.elapsedSeconds),
      type: event.data.type,
      data: event.data,
      line: describeEvent(event, state, null),
      perceivers: perceivers.get(event.sequence) ?? [],
    }));
  }

  async function worldView(worldId: string): Promise<WorldView> {
    const state = await engine.getWorld(worldId);
    const setup = await loadSetup(engine, worldId, state, castForWorld);
    return {
      world: state,
      muted: await engine.getMuted(worldId),
      setup,
      setupSaved: (await engine.getSetup(worldId)) !== null,
      models: resolvedModels(setup.models, env),
      run: runs.status(worldId),
      keyConfigured: keyConfigured(),
      rehearsable: await isRehearsable(engine, worldId),
    };
  }

  function requirePlayable(): void {
    if (!keyConfigured()) throw new ProviderConfigError("Set OPENROUTER_API_KEY in .env.local and restart the server to play with models");
  }

  async function createWorld(body: z.infer<typeof bodies.createWorld>) {
    const existing = await engine.listWorlds();
    if (existing.some((world) => world.id === body.id)) throw new EngineError("REQUEST_CONFLICT", `World ${body.id} already exists`);
    let seed: unknown;
    let cast;
    if (body.adventureId !== undefined) {
      const adventure = findAdventure(body.adventureId);
      if (!adventure) throw new EngineError("NOT_FOUND", `Unknown adventure: ${body.adventureId}`);
      seed = { ...adventure.world(body.id), ...(body.name ? { name: body.name } : {}) };
      cast = adventure.cast;
    } else if (body.seed !== undefined) {
      seed = { ...body.seed, id: body.id, ...(body.name ? { name: body.name } : {}) };
    } else {
      throw new HttpError(400, "Choose an adventure, or give a world seed");
    }
    const state = await engine.createWorld(seed);
    await engine.saveSetup(state.id, { cast: cast ?? placeholderCast(state), models: {} });
    return worldView(state.id);
  }

  async function catalog(): Promise<OpenRouterModel[]> {
    if (!modelCache || Date.now() - modelCache.at > MODEL_CACHE_MS) modelCache = { at: Date.now(), models: await fetchModels() };
    return modelCache.models;
  }

  async function listModels(query: string): Promise<ModelInfo[]> {
    const needles = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (await catalog())
      .filter((model) => needles.every((needle) => `${model.id} ${model.name ?? ""}`.toLowerCase().includes(needle)))
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, 100)
      .map((model) => {
        const capabilities = capabilitiesOf(model);
        return {
          id: model.id,
          name: model.name ?? model.id,
          isDefault: model.id === DEFAULT_OPENROUTER_MODEL,
          output: capabilities.structuredOutputs ? "structured" as const : capabilities.jsonMode ? "json" as const : "text" as const,
          promptPerMillion: perMillion(model.pricing?.prompt),
          completionPerMillion: perMillion(model.pricing?.completion),
          contextLength: model.context_length ?? null,
          tools: capabilities.tools,
          reasoning: capabilities.reasoning,
          efforts: capabilities.efforts,
          defaultEffort: capabilities.defaultEffort,
        };
      });
  }

  /** Server-sent events: new events as they commit, and run progress. Resumes after Last-Event-ID. */
  async function stream(request: IncomingMessage, response: ServerResponse, worldId: string, url: URL): Promise<void> {
    const state = await engine.getWorld(worldId);
    let after = Number(request.headers["last-event-id"] ?? url.searchParams.get("after") ?? state.revision);
    if (!Number.isSafeInteger(after) || after < 0) after = state.revision;
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: string, data: unknown, id?: number) => {
      response.write(`${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send("run", runs.status(worldId));
    let polling = false;
    let names = state;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const revision = await engine.getRevision(worldId);
        while (revision > after) {
          // Rulings can add challenges mid-run, so names come from the latest state.
          names = await engine.getWorld(worldId);
          const events = await eventViews(worldId, names, after, 200);
          if (events.length === 0) break;
          after = events.at(-1)!.sequence;
          send("events", events, after);
        }
      } catch (error) {
        send("problem", { message: error instanceof Error ? error.message : String(error) });
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => void poll(), pollMs);
    const heartbeat = setInterval(() => response.write(": ping\n\n"), 20_000);
    const unsubscribe = runs.subscribe((status: RunStatus) => {
      if (status.worldId === worldId) send("run", status);
      // A run's events may land between polls; look now.
      void poll();
    });
    await poll();
    // The request's own "close" can fire once it has been read; the response's fires when the client goes.
    response.on("close", () => {
      clearInterval(timer);
      clearInterval(heartbeat);
      unsubscribe();
    });
  }

  /**
   * The AI creator at work on a draft, streamed as one JSON event per line:
   * fetch can read it as it arrives, which EventSource cannot do for a POST.
   */
  async function assistant(request: IncomingMessage, response: ServerResponse, draftId: string): Promise<void> {
    const body = parseBody(bodies.assistant, await readJson(request));
    requirePlayable();
    const settings = creatorSettingsFromEnv(env, body.model, body.effort);
    const chat = OpenRouterChat.create(options.creatorFetch ? { ...settings, fetch: options.creatorFetch } : settings, await catalog());
    const controller = new AbortController();
    let heartbeat: NodeJS.Timeout | undefined;
    const send = (event: unknown) => {
      if (!response.writableEnded && !response.destroyed) response.write(`${JSON.stringify(event)}\n`);
    };
    try {
      const { entry, view } = await drafts.assist(draftId, {
        message: body.message,
        step: body.step,
        expectedRevision: body.expectedRevision,
        chat,
        signal: controller.signal,
        onStart: () => {
          response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
          // The request's own "close" fires once its body is read; the response's fires when the client goes.
          response.on("close", () => {
            if (!response.writableEnded) controller.abort();
          });
          // A model call can be silent for a minute or more; keep proxies from closing the stream.
          heartbeat = setInterval(() => send({ type: "heartbeat" }), 15_000);
          send({ type: "start", model: chat.model });
        },
        onEvent: send,
      });
      send({ type: "done", entry, draft: view });
    } catch (error) {
      if (!response.headersSent) throw error;
      if (!(error instanceof EngineError)) console.error(error);
      send({ type: "error", message: error instanceof EngineError ? error.message : "The AI creator failed; see the server log" });
    } finally {
      clearInterval(heartbeat);
      if (response.headersSent) response.end();
    }
  }

  /**
   * The story editor at work on a world, streamed like the AI creator: one
   * JSON event per line. The last, "done", carries the world as it is now.
   */
  async function editorStream(request: IncomingMessage, response: ServerResponse, worldId: string): Promise<void> {
    const body = parseBody(bodies.editor, await readJson(request));
    requirePlayable();
    if (runs.status(worldId)?.state === "running" || runs.status(worldId)?.state === "pausing") {
      throw new EngineError("WORLD_BUSY", "This world is running; pause it, then ask the story editor");
    }
    const settings = creatorSettingsFromEnv(env, body.model);
    const chat = OpenRouterChat.create(options.creatorFetch ? { ...settings, fetch: options.creatorFetch } : settings, await catalog());
    const controller = new AbortController();
    let heartbeat: NodeJS.Timeout | undefined;
    const send = (event: unknown) => {
      if (!response.writableEnded && !response.destroyed) response.write(`${JSON.stringify(event)}\n`);
    };
    try {
      const { entry, view } = await editor.assist(worldId, {
        message: body.message,
        pass: body.pass,
        chat,
        signal: controller.signal,
        onStart: () => {
          response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
          response.on("close", () => {
            if (!response.writableEnded) controller.abort();
          });
          heartbeat = setInterval(() => send({ type: "heartbeat" }), 15_000);
          send({ type: "start", model: chat.model });
        },
        onEvent: send,
      });
      send({ type: "done", entry, editor: view, world: await worldView(worldId) });
    } catch (error) {
      if (!response.headersSent) throw error;
      if (!(error instanceof EngineError)) console.error(error);
      send({ type: "error", message: error instanceof EngineError ? error.message : "The story editor failed; see the server log" });
    } finally {
      clearInterval(heartbeat);
      if (response.headersSent) response.end();
    }
  }

  /** Runs and the story editor never overlap: a run waits for the editor to finish. */
  function requireNoEditor(worldId: string): void {
    if (editor.isBusy(worldId)) throw new EngineError("WORLD_BUSY", "The story editor is working on this world; wait for it or stop it");
  }

  async function serveStatic(response: ServerResponse, pathname: string): Promise<void> {
    if (options.staticDir === null) throw new HttpError(404, "Not found");
    const root = path.resolve(options.staticDir);
    const candidate = path.resolve(root, `.${decodeURIComponent(pathname)}`);
    if (candidate !== root && !candidate.startsWith(root + path.sep)) throw new HttpError(404, "Not found");
    let file = candidate;
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      // Client-side routes all load the app.
      file = path.join(root, "index.html");
      if (!(await stat(file).catch(() => null))?.isFile()) {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<!doctype html><title>Dungeons</title><p>The web UI is not built yet. Run <code>npm run build:web</code>, or use the Vite dev server (<code>npm run dev:web</code>).</p>");
        return;
      }
    }
    const immutable = file.includes(`${path.sep}assets${path.sep}`);
    response.writeHead(200, {
      "Content-Type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    createReadStream(file).pipe(response);
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = hostnameOf(request.headers.host);
    // Platform health probes arrive with an internal host name and read nothing.
    if (request.url === "/api/health" && (request.method === "GET" || request.method === "HEAD")) {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (host === null || !allowed.has(host)) throw new HttpError(403, "This server only answers on its own host names");
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://localhost");
    // Auth.js checks its own form posts with a CSRF token, and Google's callback is a GET.
    if (auth && (url.pathname === AUTH_BASE_PATH || url.pathname.startsWith(`${AUTH_BASE_PATH}/`))) {
      await answerAuth(request, response, auth);
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      // Writes spend credit and change worlds: only same-site JSON requests may make them.
      const origin = request.headers.origin;
      if (origin !== undefined && !allowed.has(hostnameOf(URL.canParse(origin) ? new URL(origin).host : undefined) ?? "")) {
        throw new HttpError(403, "Cross-site requests are not allowed");
      }
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        throw new HttpError(415, "Send JSON with Content-Type: application/json");
      }
    }
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== "api") {
      if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method not allowed");
      await serveStatic(response, url.pathname);
      return;
    }
    const json = (body: unknown, status = 200) => sendJson(response, status, body);
    const [, resource, worldId, sub, characterId] = parts;
    const key = `${method} ${[resource, worldId === undefined ? "" : ":world", sub ?? "", characterId === undefined ? "" : ":character"].filter(Boolean).join("/")}`;
    if (key === "GET health") return json({ ok: true });
    const user = auth ? await auth.session(request.headers.cookie) : null;
    const allowedUser = user !== null && allowedEmail(user.email, env);
    if (key === "GET session") return json({ login: auth !== null, email: user?.email ?? null, allowed: allowedUser });
    if (auth) {
      if (!user) throw new HttpError(401, "Sign in first.", "SIGN_IN");
      if (!allowedUser) throw new HttpError(403, "This Google account is not allowed to use the director", "NOT_ALLOWED");
    }
    switch (key) {
      case "GET adventures":
        return json(ADVENTURES.map((adventure) => ({ id: adventure.id, name: adventure.name, summary: adventure.summary })));
      case "GET models":
        return json(await listModels(url.searchParams.get("q") ?? ""));
      case "GET worlds":
        return json({ worlds: await engine.listWorlds(), keyConfigured: keyConfigured() });
      case "POST worlds":
        return json(await createWorld(parseBody(bodies.createWorld, await readJson(request))), 201);
      case "GET worlds/:world":
        return json(await worldView(worldId!));
      case "GET worlds/:world/events": {
        const after = Number(url.searchParams.get("after") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 500);
        const state = await engine.getWorld(worldId!);
        return json(await eventViews(worldId!, state, after, limit));
      }
      case "GET worlds/:world/stream":
        return stream(request, response, worldId!, url);
      case "GET worlds/:world/agents/:character": {
        const state = await engine.getWorld(worldId!);
        const { cast } = await loadSetup(engine, worldId!, state, castForWorld);
        return json(await agentPrompts(engine, worldId!, state, cast, characterId!));
      }
      case "GET worlds/:world/prompts": {
        const state = await engine.getWorld(worldId!);
        const { cast } = await loadSetup(engine, worldId!, state, castForWorld);
        const frame = frameOf(cast, state);
        return json({
          narrator: narratorSystemPrompt(cast.narratorStyle, frame),
          referee: refereeSystemPrompt(frame),
          // A judgment world's referee also judges attempts at listed challenges.
          ...(frame.rules.outcomes === "judgment" ? { judge: judgeSystemPrompt(frame) } : {}),
        });
      }
      case "GET worlds/:world/memory/:character": {
        const state = await engine.getWorld(worldId!);
        const search = url.searchParams.get("search")?.trim() || undefined;
        return json(await memoryReport(engine, worldId!, state, characterId!, search));
      }
      case "GET worlds/:world/traces": {
        const last = Math.min(Math.max(Number(url.searchParams.get("last") ?? 50) || 50, 1), 500);
        return json(await engine.getTraces(worldId!, last));
      }
      case "GET worlds/:world/report": {
        const state = await engine.getWorld(worldId!);
        const events = await engine.getEvents(worldId!, Math.max(0, state.revision - 1000), 1000);
        return json(computeMetrics(events, await engine.getTraces(worldId!, 1000), state));
      }
      case "GET worlds/:world/export": {
        const kind = url.searchParams.get("kind") ?? "design";
        if (kind !== "design" && kind !== "save") throw new HttpError(400, "kind must be design or save");
        return sendWorldFile(response, kind === "save" ? await exportSave(engine, worldId!) : await exportDesign(engine, { worldId: worldId! }));
      }
      case "POST import": {
        const result = await importWorldFile(engine, await readJson(request, MAX_IMPORT_BYTES), { worldId: url.searchParams.get("worldId") || undefined });
        return json(result.kind === "design"
          ? { kind: "design", draft: await drafts.view(result.draft) }
          : { kind: "save", world: await worldView(result.world.id) }, 201);
      }
      case "PUT worlds/:world/setup": {
        const state = await engine.getWorld(worldId!);
        await engine.saveSetup(worldId!, parseSetup(await readJson(request), state));
        return json(await worldView(worldId!));
      }
      case "POST worlds/:world/mute": {
        const body = parseBody(bodies.mute, await readJson(request));
        await engine.setMuted(worldId!, body.characterIds, body.muted);
        return json(await worldView(worldId!));
      }
      case "POST worlds/:world/steer": {
        const body = parseBody(bodies.steer, await readJson(request));
        const result = await direct(engine, worldId!, { type: "steer", text: body.text, ...(body.targetId ? { targetId: body.targetId } : {}) });
        return json({ sequence: result.events[0]!.sequence }, 201);
      }
      case "POST worlds/:world/introduce": {
        const body = parseBody(bodies.introduce, await readJson(request));
        const result = await direct(engine, worldId!, {
          type: "introduce",
          text: body.text,
          ...(body.locationIds?.length ? { locationIds: body.locationIds } : {}),
          ...(body.lockRoutes?.length ? { lockRoutes: body.lockRoutes } : {}),
          ...(body.unlockRoutes?.length ? { unlockRoutes: body.unlockRoutes } : {}),
        });
        return json({ sequence: result.events[0]!.sequence }, 201);
      }
      case "POST worlds/:world/enter": {
        const body = parseBody(bodies.enter, await readJson(request));
        const result = await direct(engine, worldId!, {
          type: "enter",
          characterId: body.characterId,
          locationId: body.locationId,
          ...(body.text?.trim() ? { text: body.text.trim() } : {}),
        });
        return json({ sequence: result.events[0]!.sequence }, 201);
      }
      case "POST worlds/:world/exit": {
        const body = parseBody(bodies.exit, await readJson(request));
        const result = await direct(engine, worldId!, {
          type: "exit",
          characterId: body.characterId,
          ...(body.text?.trim() ? { text: body.text.trim() } : {}),
        });
        return json({ sequence: result.events[0]!.sequence }, 201);
      }
      case "POST worlds/:world/retcon": {
        const body = parseBody(bodies.retcon, await readJson(request));
        const result = await direct(engine, worldId!, {
          type: "retcon",
          sequence: body.sequence,
          ...(body.text?.trim() ? { text: body.text } : {}),
          ...(body.replacement === undefined ? {} : { replacement: body.replacement }),
        });
        return json({ sequence: result.events[0]!.sequence }, 201);
      }
      case "POST worlds/:world/wipe": {
        const body = parseBody(bodies.wipe, await readJson(request));
        await engine.getWorld(worldId!);
        if (runs.status(worldId!)?.state === "running" || runs.status(worldId!)?.state === "pausing") {
          throw new EngineError("WORLD_BUSY", "This world is running; pause it, then wipe");
        }
        requireNoEditor(worldId!);
        // Hold the lease while wiping, so no run elsewhere plays a turn into the old story.
        const lease = new Lease(engine, worldId!, 30_000);
        try {
          await lease.acquire();
        } catch (error) {
          if (error instanceof EngineError && error.code === "WORLD_BUSY") throw new EngineError("WORLD_BUSY", "This world is running elsewhere; stop it, then wipe");
          throw error;
        }
        try {
          const result = await direct(engine, worldId!, { type: "wipe", fromSequence: body.fromSequence });
          return json({ sequence: result.events[0]!.sequence }, 201);
        } finally {
          await lease.release();
        }
      }
      case "POST worlds/:world/branch": {
        const body = parseBody(bodies.branch, await readJson(request));
        const state = await engine.branchWorld(worldId!, body.through, body.id, body.name);
        return json(await worldView(state.id), 201);
      }
      case "POST worlds/:world/step": {
        const body = parseBody(bodies.step, await readJson(request));
        requirePlayable();
        await engine.getWorld(worldId!);
        requireNoEditor(worldId!);
        return json(runs.start(worldId!, { kind: "step", actorId: body.actorId }), 202);
      }
      case "POST worlds/:world/run": {
        const body = parseBody(bodies.run, await readJson(request));
        requirePlayable();
        await engine.getWorld(worldId!);
        requireNoEditor(worldId!);
        return json(runs.start(worldId!, { kind: "run", ...body }), 202);
      }
      case "POST worlds/:world/rehearse":
        await engine.getWorld(worldId!);
        await requireRehearsable(engine, worldId!);
        requireNoEditor(worldId!);
        return json(runs.start(worldId!, { kind: "rehearse" }), 202);
      case "GET worlds/:world/editor":
        return json(await editor.view(worldId!));
      case "POST worlds/:world/editor":
        return editorStream(request, response, worldId!);
      case "DELETE worlds/:world/editor/:character":
        return json(await editor.deleteFrom(worldId!, characterId!));
      case "POST worlds/:world/pause":
        return json(runs.pause(worldId!));
      case "GET creator":
        return json({ model: creatorModelFromEnv(env), keyConfigured: keyConfigured() });
      // Drafts share the route shape; the second segment is the draft's ID.
      case "GET drafts":
        return json({ drafts: await drafts.list() });
      case "POST drafts":
        return json(await drafts.create(parseBody(bodies.createDraft, await readJson(request))), 201);
      case "GET drafts/:world":
        return json(await drafts.get(worldId!));
      case "GET drafts/:world/export":
        return sendWorldFile(response, await exportDesign(engine, { draftId: worldId! }));
      case "PUT drafts/:world": {
        const body = parseBody(bodies.saveDraft, await readJson(request));
        return json(await drafts.save(worldId!, body.draft, body.expectedRevision));
      }
      case "DELETE drafts/:world":
        await readJson(request);
        await drafts.delete(worldId!);
        return json({ ok: true });
      case "DELETE drafts/:world/chat/:character":
        await readJson(request);
        return json(await drafts.deleteFrom(worldId!, characterId!));
      case "POST drafts/:world/assistant":
        return assistant(request, response, worldId!);
      case "POST drafts/:world/samples": {
        const body = parseBody(bodies.addSample, await readJson(request, MAX_SAMPLE_BYTES));
        return json(await drafts.addSample(worldId!, body), 201);
      }
      case "DELETE drafts/:world/samples/:character":
        await readJson(request);
        return json(await drafts.removeSample(worldId!, characterId!));
      case "POST drafts/:world/publish": {
        const body = parseBody(bodies.publishDraft, await readJson(request));
        return json(await drafts.publish(worldId!, body.worldId, body.expectedRevision));
      }
      default:
        throw new HttpError(404, `No such API route: ${method} ${url.pathname}`);
    }
  }

  return (request, response) => {
    route(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof HttpError) return sendJson(response, error.status, { error: error.message, ...(error.code ? { code: error.code } : {}) });
      if (error instanceof EngineError) return sendJson(response, STATUS_BY_CODE[error.code], { error: error.message, code: error.code });
      if (error instanceof ProviderConfigError) return sendJson(response, 400, { error: error.message });
      console.error(error);
      sendJson(response, 500, { error: "Internal server error; see the server log" });
    });
  };
}
