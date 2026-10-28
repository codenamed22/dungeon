import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_OPENROUTER_MODEL, fetchOpenRouterModels, OpenRouterProvider,
  openRouterSettingsFromEnv,
} from "../src/agents/openrouter.ts";
import type { OpenRouterSettings } from "../src/agents/openrouter.ts";
import { ProviderConfigError, ProviderError } from "../src/agents/provider.ts";
import type { ModelRequest, ProviderFailure } from "../src/agents/provider.ts";

const KEY = "sk-or-test-key";

const CATALOG = [
  {
    id: "test/structured", name: "Structured", context_length: 1000,
    pricing: { prompt: "0.000001", completion: "0.000002" },
    supported_parameters: ["max_tokens", "reasoning", "response_format", "structured_outputs"],
    reasoning: { supported_efforts: ["none", "low", "high"], default_effort: "high" },
  },
  { id: "test/json", supported_parameters: ["max_tokens", "response_format"] },
  { id: "test/plain", supported_parameters: [] },
  {
    id: "test/deep", supported_parameters: ["reasoning", "response_format", "structured_outputs"],
    reasoning: { supported_efforts: ["none", "high", "xhigh"], default_effort: "high" },
  },
];

const request: ModelRequest = {
  role: "character",
  system: "You are Mira.",
  prompt: "Your turn.",
  schema: z.strictObject({ speech: z.string().nullable(), quantity: z.number().int().nullable() }),
  schemaName: "take_turn",
};

type Reply = Response | Error;

function completion(
  content: string | null,
  body: Record<string, unknown> = {},
  choice: Record<string, unknown> = {},
): Response {
  return Response.json({
    id: "gen-1",
    model: "test/structured-0001",
    choices: [{ finish_reason: "stop", message: { role: "assistant", content }, ...choice }],
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
    ...body,
  });
}

function errorReply(status: number, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error: { code: status, message } }, { status, headers });
}

const networkError = () => new TypeError("fetch failed", { cause: new Error("read ECONNRESET") });

/** A provider whose fetch serves the catalog, then the given chat replies in order. */
async function setUp(replies: Reply[], overrides: Partial<OpenRouterSettings> = {}) {
  const requests: { url: string; init: RequestInit }[] = [];
  const delays: number[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    if (String(input).endsWith("/models")) return Response.json({ data: CATALOG });
    requests.push({ url: String(input), init });
    const reply = replies.shift();
    if (reply === undefined) throw new Error("No reply left");
    if (reply instanceof Error) throw reply;
    return reply;
  }) as typeof globalThis.fetch;
  const provider = await OpenRouterProvider.create({
    apiKey: KEY,
    models: { character: "test/structured", dm: "test/structured" },
    efforts: { character: undefined, dm: undefined },
    maxOutputTokens: 512,
    fetch,
    sleep: async (ms) => {
      delays.push(ms);
    },
    ...overrides,
  });
  const bodies = () => requests.map((entry) => JSON.parse(String(entry.init.body)) as Record<string, unknown>);
  return { provider, requests, bodies, delays };
}

async function failureOf(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ProviderError, String(error));
    return error;
  }
  assert.fail("Expected a provider error");
}

function configError(pattern: RegExp): (error: unknown) => boolean {
  return (error) => error instanceof ProviderConfigError && pattern.test(error.message);
}

test("settings come from the environment, with defaults, per-role overrides, and a model override", () => {
  assert.deepEqual(openRouterSettingsFromEnv({ OPENROUTER_API_KEY: KEY }), {
    apiKey: KEY,
    models: { character: DEFAULT_OPENROUTER_MODEL, dm: DEFAULT_OPENROUTER_MODEL },
    efforts: { character: undefined, dm: undefined },
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });
  const env = {
    OPENROUTER_API_KEY: ` ${KEY} `,
    DUNGEONS_MODEL: "a/shared",
    DUNGEONS_DM_MODEL: "a/narrator",
    DUNGEONS_REASONING_EFFORT: "medium",
    DUNGEONS_CHARACTER_EFFORT: "default",
    DUNGEONS_MAX_OUTPUT_TOKENS: "2048",
  };
  const settings = openRouterSettingsFromEnv(env);
  assert.equal(settings.apiKey, KEY);
  assert.deepEqual(settings.models, { character: "a/shared", dm: "a/narrator" });
  assert.deepEqual(settings.efforts, { character: "default", dm: "medium" });
  assert.equal(settings.maxOutputTokens, 2048);
  // --model replaces both roles' models, per-role ones included. Blank values count as unset.
  assert.deepEqual(openRouterSettingsFromEnv(env, "b/override").models, { character: "b/override", dm: "b/override" });
  assert.deepEqual(
    openRouterSettingsFromEnv({ ...env, DUNGEONS_DM_MODEL: " ", DUNGEONS_REASONING_EFFORT: "" }, " "),
    { ...settings, models: { character: "a/shared", dm: "a/shared" }, efforts: { character: "default", dm: undefined } },
  );
});

test("missing or invalid settings fail with a configuration error", () => {
  const key = { OPENROUTER_API_KEY: KEY };
  const fails = (env: NodeJS.ProcessEnv, pattern: RegExp) => {
    assert.throws(() => openRouterSettingsFromEnv(env), configError(pattern));
  };
  fails({}, /^Set OPENROUTER_API_KEY/);
  fails({ OPENROUTER_API_KEY: "  " }, /^Set OPENROUTER_API_KEY/);
  fails({ ...key, DUNGEONS_REASONING_EFFORT: "extreme" }, /^DUNGEONS_REASONING_EFFORT must be one of none, .*, or default$/);
  fails({ ...key, DUNGEONS_DM_EFFORT: "LOW" }, /^DUNGEONS_DM_EFFORT/);
  for (const value of ["0", "-3", "1.5", "lots"]) {
    fails({ ...key, DUNGEONS_MAX_OUTPUT_TOKENS: value }, /^DUNGEONS_MAX_OUTPUT_TOKENS must be a positive integer$/);
  }
});

test("listing models needs no key, and a failed listing is a configuration error", async () => {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const models = await fetchOpenRouterModels((async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return Response.json({ data: CATALOG });
  }) as typeof fetch);
  assert.deepEqual(models.map((model) => model.id), CATALOG.map((model) => model.id));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, "https://openrouter.ai/api/v1/models");
  assert.equal(seen[0]?.init?.headers, undefined);
  const listing = (reply: () => Response | Promise<Response>) => fetchOpenRouterModels((async () => reply()) as typeof fetch);
  await assert.rejects(listing(() => new Response("busy", { status: 503 })), configError(/Could not list .*HTTP 503/));
  await assert.rejects(listing(() => Response.json({ models: [] })), configError(/unexpected format/));
  await assert.rejects(
    listing(() => Promise.reject(new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") }))),
    configError(/fetch failed \(getaddrinfo ENOTFOUND\)/),
  );
});

test("each role's model and effort are checked against the catalog when the provider is created", async () => {
  await assert.rejects(
    setUp([], { models: { character: "test/structured", dm: "test/missing" } }),
    configError(/^OpenRouter has no model test\/missing\. List models with: npm run director -- models$/),
  );
  await assert.rejects(
    setUp([], { efforts: { character: "medium", dm: undefined } }),
    configError(/^test\/structured accepts reasoning efforts none, low, high, not medium$/),
  );
  const { provider: defaults } = await setUp([], { efforts: { character: undefined, dm: "default" } });
  assert.equal(defaults.describe("character"), "test/structured (structured output, reasoning low)");
  assert.equal(defaults.describe("dm"), "test/structured (structured output, reasoning at the model default (high))");
  assert.equal(defaults.modelFor("dm"), "test/structured");
  // With no effort configured, a model that lacks low gets the nearest effort it offers; ties go to more reasoning.
  // An effort for a model that cannot reason is accepted and never sent.
  const { provider: mixed } = await setUp([], {
    models: { character: "test/deep", dm: "test/json" },
    efforts: { character: undefined, dm: "max" },
  });
  assert.equal(mixed.describe("character"), "test/deep (structured output, reasoning high, the nearest it offers to low)");
  assert.equal(mixed.describe("dm"), "test/json (JSON mode, no reasoning)");
});

test("requests use only the parameters each model supports", async () => {
  const { provider, requests, bodies } = await setUp([completion("{}")]);
  await provider.generate(request);
  assert.equal(requests[0]?.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(requests[0]?.init.method, "POST");
  assert.deepEqual(requests[0]?.init.headers, {
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json",
    "X-Title": "Dungeons",
  });
  assert.ok(requests[0]?.init.signal instanceof AbortSignal);
  assert.deepEqual(bodies()[0], {
    model: "test/structured",
    messages: [{ role: "system", content: "You are Mira." }, { role: "user", content: "Your turn." }],
    max_tokens: 512,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "take_turn",
        strict: true,
        // No $schema and no ±2^53 integer bounds, which some strict-mode providers reject.
        schema: {
          type: "object",
          properties: {
            speech: { type: ["string", "null"] },
            quantity: { anyOf: [{ type: "integer" }, { type: "null" }] },
          },
          required: ["speech", "quantity"],
          additionalProperties: false,
        },
      },
    },
    reasoning: { effort: "low" },
    provider: { require_parameters: true },
  });

  const other = await setUp([completion("{}"), completion("{}")], {
    models: { character: "test/json", dm: "test/plain" },
    efforts: { character: "high", dm: "high" },
  });
  await other.provider.generate(request);
  await other.provider.generate({ ...request, role: "dm" });
  const [json, plain] = other.bodies();
  assert.deepEqual(json?.response_format, { type: "json_object" });
  assert.equal(json?.max_tokens, 512);
  assert.equal(json?.reasoning, undefined);
  assert.deepEqual(plain, {
    model: "test/plain",
    messages: [{ role: "system", content: "You are Mira." }, { role: "user", content: "Your turn." }],
    provider: { require_parameters: true },
  });

  const modelDefault = await setUp([completion("{}")], { efforts: { character: "default", dm: undefined } });
  await modelDefault.provider.generate(request);
  assert.equal(modelDefault.bodies()[0]?.reasoning, undefined);
});

test("replies are parsed as JSON, with or without a code fence, and other text is passed on for feedback", async () => {
  const { provider } = await setUp([
    completion('{"speech": "Hello.", "quantity": null}'),
    completion('```json\n{"speech": "Fenced."}\n```', { model: undefined }),
    completion("I walk to the ridge."),
    completion(null),
  ]);
  const first = await provider.generate(request);
  assert.deepEqual(first.output, { speech: "Hello.", quantity: null });
  assert.equal(first.model, "test/structured-0001");
  assert.deepEqual(first.usage, { inputTokens: 120, outputTokens: 30 });
  assert.equal((first.raw as { id: string }).id, "gen-1");
  const fenced = await provider.generate(request);
  assert.deepEqual(fenced.output, { speech: "Fenced." });
  assert.equal(fenced.model, "test/structured", "a reply without a model records the configured one");
  assert.equal((await provider.generate(request)).output, "I walk to the ridge.");
  assert.equal((await provider.generate(request)).output, null);
});

test("failures map to provider error kinds, and only transient ones are retried", async () => {
  const cases: { name: string; replies: Reply[]; kind: ProviderFailure; message: RegExp; delays?: number[] }[] = [
    { name: "bad key", replies: [errorReply(401, "No auth credentials found")], kind: "api_error", message: /\(401\).*Check OPENROUTER_API_KEY/ },
    { name: "no credits", replies: [errorReply(402, "Insufficient credits")], kind: "api_error", message: /more credits \(402\)/ },
    { name: "moderation", replies: [errorReply(403, "Input was flagged")], kind: "refused", message: /blocked .*flagged/ },
    { name: "upstream timeout", replies: [errorReply(408, "Request timed out")], kind: "timeout", message: /timed out \(408\)/ },
    {
      name: "outage", replies: [errorReply(503, "No providers"), errorReply(503, "No providers"), errorReply(503, "No providers")],
      kind: "api_error", message: /error 503: No providers/, delays: [1000, 2000],
    },
    {
      name: "network", replies: [networkError(), networkError(), networkError()],
      kind: "network", message: /fetch failed \(read ECONNRESET\)/, delays: [1000, 2000],
    },
    {
      name: "proxy error page", replies: [1, 2, 3].map(() => new Response("<html>Bad gateway</html>", { status: 502 })),
      kind: "api_error", message: /error 502: <html>Bad gateway<\/html>/, delays: [1000, 2000],
    },
    { name: "client error", replies: [errorReply(400, "Bad request")], kind: "api_error", message: /error 400: Bad request/ },
    {
      name: "client timeout", replies: [new DOMException("The operation was aborted due to timeout", "TimeoutError")],
      kind: "timeout", message: /within 120 s/,
    },
    {
      name: "truncated", replies: [completion('{"speech": "Hel', {}, { finish_reason: "length" })],
      kind: "truncated", message: /512-token output limit, which includes reasoning/,
    },
    {
      name: "content filter", replies: [completion(null, {}, { finish_reason: "content_filter" })],
      kind: "refused", message: /declined: content filter/,
    },
    {
      name: "refusal", replies: [completion(null, {}, { message: { content: null, refusal: "I can't help with that." } })],
      kind: "refused", message: /declined: I can't help/,
    },
    {
      name: "choice error", replies: [completion(null, {}, { finish_reason: "error", error: { code: 400, message: "Invalid schema" } })],
      kind: "api_error", message: /failed \(400\): Invalid schema/,
    },
    { name: "non-JSON success", replies: [new Response("<html>ok</html>")], kind: "invalid_output", message: /unexpected response/ },
  ];
  for (const { name, replies, kind, message, delays = [] } of cases) {
    const attempts = replies.length;
    const fake = await setUp(replies);
    const error = await failureOf(fake.provider.generate(request));
    assert.equal(error.kind, kind, name);
    assert.match(error.message, message, name);
    assert.doesNotMatch(error.message, new RegExp(KEY), name);
    assert.equal(fake.requests.length, attempts, name);
    assert.deepEqual(fake.delays, delays, name);
  }

  // A truncated reply keeps its usage for budgets; every failure with a reply keeps it for traces.
  const truncated = await setUp([completion('{"speech": "Hel', {}, { finish_reason: "length" })]);
  const error = await failureOf(truncated.provider.generate(request));
  assert.deepEqual(error.usage, { inputTokens: 120, outputTokens: 30 });
  assert.equal((error.raw as { id: string }).id, "gen-1");
  const plain = await setUp([completion(null, {}, { finish_reason: "length" })], { models: { character: "test/plain", dm: "test/plain" } });
  assert.match((await failureOf(plain.provider.generate(request))).message, /hit the model's output limit$/);
});

test("rate limits, outages, and network failures are retried with backoff, honoring a capped Retry-After", async () => {
  const fake = await setUp([
    errorReply(429, "Rate limit exceeded", { "Retry-After": "3" }), errorReply(502, "Bad gateway"), completion('{"speech": "One."}'),
    networkError(), completion('{"speech": "Two."}'),
    Response.json({ error: { code: 429, message: "Upstream rate limit" } }), completion('{"speech": "Three."}'),
    completion(null, {}, { finish_reason: "error", error: { code: 502, message: "Provider disconnected" } }),
    completion('{"speech": "Four."}'),
    errorReply(429, "Slow down", { "Retry-After": "120" }), completion('{"speech": "Five."}'),
  ]);
  for (const speech of ["One.", "Two.", "Three.", "Four.", "Five."]) {
    assert.deepEqual((await fake.provider.generate(request)).output, { speech });
  }
  assert.equal(fake.requests.length, 11);
  assert.deepEqual(fake.delays, [3000, 2000, 1000, 1000, 1000, 30_000]);
});

test("a cancelled call stops at once and is never retried; reported cost is kept", async () => {
  const { provider } = await setUp([
    completion('{"speech": "Hi.", "quantity": null}', { usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.0004 } }),
  ]);
  assert.deepEqual((await provider.generate(request)).usage, { inputTokens: 10, outputTokens: 2, cost: 0.0004 });

  const { provider: idle, requests: unsent } = await setUp([completion("{}")]);
  assert.equal((await failureOf(idle.generate({ ...request, signal: AbortSignal.abort() }))).kind, "cancelled");
  assert.equal(unsent.length, 0);

  // Pausing while the request is in flight aborts it.
  const inFlight = new AbortController();
  let sent = 0;
  const { provider: cancelling } = await setUp([], {
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      if (String(input).endsWith("/models")) return Response.json({ data: CATALOG });
      sent += 1;
      inFlight.abort();
      init.signal?.throwIfAborted();
      return completion("{}");
    }) as typeof globalThis.fetch,
  });
  assert.equal((await failureOf(cancelling.generate({ ...request, signal: inFlight.signal }))).kind, "cancelled");
  assert.equal(sent, 1);

  // Pausing during a retry's backoff ends the wait.
  const backoff = new AbortController();
  const { provider: retrying, requests } = await setUp([errorReply(503, "Overloaded"), completion("{}")], {
    sleep: () => {
      backoff.abort();
      return new Promise(() => {});
    },
  });
  assert.equal((await failureOf(retrying.generate({ ...request, signal: backoff.signal }))).kind, "cancelled");
  assert.equal(requests.length, 1);
});
