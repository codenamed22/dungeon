import { readFileSync } from "node:fs";
import { z } from "zod";
import { ProviderConfigError, ProviderError } from "./provider.ts";
import type { AgentRole, ModelProvider, ModelRequest, ModelResponse, ModelUsage, ProviderFailure } from "./provider.ts";

// OpenRouter's chat completions API, called with fetch: no SDK dependency.

export const DEFAULT_OPENROUTER_MODEL = "~deepseek/deepseek-v4-flash-latest";
export const DEFAULT_REASONING_EFFORT = "low";
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
/** Writing a world takes many tool calls in one reply, with reasoning counted against the limit too. */
export const DEFAULT_CREATOR_MAX_TOKENS = 16_000;
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const API = "https://openrouter.ai/api/v1";
const TIMEOUT_MS = 120_000;
const CATALOG_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 30_000;

export interface OpenRouterSettings {
  apiKey: string;
  models: Record<AgentRole, string>;
  /**
   * Reasoning effort per role: an effort the model must support, "default" to
   * leave it to the model, or undefined for low or the nearest effort it offers.
   */
  efforts: Record<AgentRole, string | undefined>;
  maxOutputTokens: number;
  /** Sent as the first system message of every request. */
  systemPrompt?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

function setting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

function effortSetting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = setting(env, name);
  if (value !== undefined && value !== "default" && !(REASONING_EFFORTS as readonly string[]).includes(value)) {
    throw new ProviderConfigError(`${name} must be one of ${REASONING_EFFORTS.join(", ")}, or default`);
  }
  return value;
}

/** Reads OpenRouter settings from the environment; `model` overrides both roles' models. */
export function openRouterSettingsFromEnv(env: NodeJS.ProcessEnv, model?: string): OpenRouterSettings {
  const apiKey = setting(env, "OPENROUTER_API_KEY");
  if (!apiKey) throw new ProviderConfigError("Set OPENROUTER_API_KEY to use OpenRouter models (see .env.example)");
  const override = model?.trim() || undefined;
  const shared = override ?? setting(env, "DUNGEONS_MODEL") ?? DEFAULT_OPENROUTER_MODEL;
  const effort = effortSetting(env, "DUNGEONS_REASONING_EFFORT");
  const maxOutputTokens = Number(setting(env, "DUNGEONS_MAX_OUTPUT_TOKENS") ?? DEFAULT_MAX_OUTPUT_TOKENS);
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new ProviderConfigError("DUNGEONS_MAX_OUTPUT_TOKENS must be a positive integer");
  }
  return {
    apiKey,
    models: {
      character: override ?? setting(env, "DUNGEONS_CHARACTER_MODEL") ?? shared,
      dm: override ?? setting(env, "DUNGEONS_DM_MODEL") ?? shared,
    },
    efforts: {
      character: effortSetting(env, "DUNGEONS_CHARACTER_EFFORT") ?? effort,
      dm: effortSetting(env, "DUNGEONS_DM_EFFORT") ?? effort,
    },
    maxOutputTokens,
    ...systemPromptSetting(env),
  };
}

/** The text of DUNGEONS_SYSTEM_PROMPT_FILE, else DUNGEONS_SYSTEM_PROMPT with a literal \n read as a line break. */
function systemPromptSetting(env: NodeJS.ProcessEnv): { systemPrompt?: string } {
  const file = setting(env, "DUNGEONS_SYSTEM_PROMPT_FILE");
  let prompt: string | undefined;
  if (file !== undefined) {
    try {
      prompt = readFileSync(file, "utf8").trim() || undefined;
    } catch (error) {
      throw new ProviderConfigError(`Could not read DUNGEONS_SYSTEM_PROMPT_FILE (${file}): ${describeError(error)}`);
    }
  } else {
    prompt = setting(env, "DUNGEONS_SYSTEM_PROMPT")?.replaceAll("\\n", "\n");
  }
  return prompt === undefined ? {} : { systemPrompt: prompt };
}

const catalogSchema = z.object({
  data: z.array(z.object({
    id: z.string(),
    name: z.string().nullish(),
    context_length: z.number().nullish(),
    pricing: z.object({ prompt: z.string().nullish(), completion: z.string().nullish() }).nullish(),
    supported_parameters: z.array(z.string()).nullish(),
    reasoning: z.object({
      supported_efforts: z.array(z.string()).nullish(),
      default_effort: z.string().nullish(),
    }).nullish(),
    alias_target: z.object({ slug: z.string() }).nullish(),
  })),
});
export type OpenRouterModel = z.infer<typeof catalogSchema>["data"][number];

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // Node's fetch reports "fetch failed" and keeps the reason in `cause`.
  return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
}

/** OpenRouter's public model list; needs no API key. */
export async function fetchOpenRouterModels(fetchImpl: typeof fetch = fetch): Promise<OpenRouterModel[]> {
  let body: unknown;
  try {
    const response = await fetchImpl(`${API}/models`, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = await response.json();
  } catch (error) {
    throw new ProviderConfigError(`Could not list OpenRouter models: ${describeError(error)}`);
  }
  const parsed = catalogSchema.safeParse(body);
  if (!parsed.success) throw new ProviderConfigError("OpenRouter's model list has an unexpected format");
  return parsed.data.data;
}

export interface ModelCapabilities {
  id: string;
  structuredOutputs: boolean;
  jsonMode: boolean;
  maxTokens: boolean;
  tools: boolean;
  reasoning: boolean;
  /** Efforts the model accepts; null means any. */
  efforts: string[] | null;
  defaultEffort: string | null;
}

export function capabilitiesOf(model: OpenRouterModel): ModelCapabilities {
  const parameters = new Set(model.supported_parameters ?? []);
  return {
    id: model.id,
    structuredOutputs: parameters.has("structured_outputs"),
    jsonMode: parameters.has("response_format"),
    maxTokens: parameters.has("max_tokens"),
    tools: parameters.has("tools"),
    reasoning: parameters.has("reasoning"),
    efforts: model.reasoning?.supported_efforts ?? null,
    defaultEffort: model.reasoning?.default_effort ?? null,
  };
}

/**
 * The effort to send. An explicit effort must be one the model supports. With
 * none configured, use the default if the model offers it, otherwise the nearest
 * effort it does offer, preferring more reasoning on a tie.
 */
export function resolveEffort(requested: string | undefined, capabilities: ModelCapabilities): string {
  const supported = capabilities.reasoning ? capabilities.efforts : null;
  if (requested !== undefined) {
    if (requested !== "default" && supported && !supported.includes(requested)) {
      throw new ProviderConfigError(
        `${capabilities.id} accepts reasoning efforts ${supported.join(", ")}, not ${requested}`,
      );
    }
    return requested;
  }
  if (!supported || supported.includes(DEFAULT_REASONING_EFFORT)) return DEFAULT_REASONING_EFFORT;
  const rank = (effort: string) => (REASONING_EFFORTS as readonly string[]).indexOf(effort);
  const target = rank(DEFAULT_REASONING_EFFORT);
  const known = supported.filter((effort) => rank(effort) >= 0);
  if (known.length === 0) return "default";
  return known.reduce((best, effort) => {
    const gap = Math.abs(rank(effort) - target) - Math.abs(rank(best) - target);
    return gap < 0 || (gap === 0 && rank(effort) > rank(best)) ? effort : best;
  });
}

/** Drops keys some strict-mode providers reject: `$schema` and the ±2^53 bounds zod gives integers. */
export function sanitizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeSchema);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key, entry]) => (
      key !== "$schema"
      && !((key === "minimum" || key === "maximum") && Math.abs(Number(entry)) === Number.MAX_SAFE_INTEGER)
    ))
    .map(([key, entry]) => [key, sanitizeSchema(entry)]));
}

/** Parses a JSON reply, tolerating a Markdown code fence. Other text is returned as is for the runner to reject. */
function parseReply(content: string | null | undefined): unknown {
  if (typeof content !== "string") return null;
  const unfenced = content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1");
  try {
    return JSON.parse(unfenced);
  } catch {
    return content;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function retryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_RETRY_DELAY_MS) : undefined;
}

const errorSchema = z.object({
  error: z.object({ code: z.union([z.number(), z.string()]).nullish(), message: z.string().nullish() }),
});

const completionSchema = z.object({
  model: z.string().nullish(),
  choices: z.array(z.object({
    finish_reason: z.string().nullish(),
    message: z.object({
      content: z.string().nullish(),
      refusal: z.string().nullish(),
      tool_calls: z.array(z.object({
        id: z.string(),
        function: z.object({ name: z.string(), arguments: z.string().nullish() }),
      })).nullish(),
    }).nullish(),
    error: z.object({ code: z.union([z.number(), z.string()]).nullish(), message: z.string().nullish() }).nullish(),
  })),
  usage: z.object({
    prompt_tokens: z.number().nullish(),
    completion_tokens: z.number().nullish(),
    // OpenRouter reports what it charged, in credits.
    cost: z.number().nullish(),
  }).nullish(),
});

type Completion = z.infer<typeof completionSchema>;

type Failure = { ok: false; error: ProviderError; retryable: boolean; retryAfterMs?: number | undefined };
type Attempt<T> = { ok: true; value: T } | Failure;

function failure(
  kind: ProviderFailure,
  message: string,
  options: { retryable?: boolean; raw?: unknown; usage?: ModelUsage; retryAfterMs?: number | undefined } = {},
): Failure {
  return {
    ok: false,
    error: new ProviderError(kind, message, {
      ...(options.raw === undefined ? {} : { raw: options.raw }),
      ...(options.usage === undefined ? {} : { usage: options.usage }),
    }),
    retryable: options.retryable ?? false,
    retryAfterMs: options.retryAfterMs,
  };
}

const cancelled = () => new ProviderError("cancelled", "The call was cancelled");

/** Waits, unless the signal aborts first. */
async function wait(sleep: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return sleep;
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(cancelled());
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    sleep.then(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, reject);
  });
}

/** Maps an OpenRouter error status, from HTTP or an error body, to a failure. */
function statusFailure(status: number, detail: string, raw: unknown, retryAfter?: number): Failure {
  if (status === 401) return failure("api_error", `OpenRouter rejected the API key (401): ${detail}. Check OPENROUTER_API_KEY.`, { raw });
  if (status === 402) return failure("api_error", `OpenRouter needs more credits (402): ${detail}`, { raw });
  if (status === 403) return failure("refused", `OpenRouter blocked the request (403): ${detail}`, { raw });
  if (status === 408 || status === 504) return failure("timeout", `OpenRouter timed out (${status}): ${detail}`, { raw });
  if (status === 429) return failure("rate_limited", `Rate limited (429): ${detail}`, { raw, retryable: true, retryAfterMs: retryAfter });
  return failure("api_error", `OpenRouter error ${status}: ${detail}`, { raw, retryable: status >= 500, retryAfterMs: retryAfter });
}

interface Connection {
  apiKey: string;
  fetch: typeof fetch;
  timeoutMs: number;
  maxRetries: number;
  sleep: (ms: number) => Promise<void>;
}

function connectionOf(settings: Pick<OpenRouterSettings, "apiKey" | "timeoutMs" | "maxRetries" | "fetch" | "sleep">): Connection {
  return {
    apiKey: settings.apiKey,
    fetch: settings.fetch ?? fetch,
    timeoutMs: settings.timeoutMs ?? TIMEOUT_MS,
    maxRetries: settings.maxRetries ?? MAX_RETRIES,
    sleep: settings.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

interface Reply {
  raw: unknown;
  model: string | null | undefined;
  choice: Completion["choices"][number];
  /** The assistant message exactly as OpenRouter sent it, for a conversation to send back. */
  message: unknown;
  usage: ModelUsage;
}

/**
 * Sends one chat completion request and classifies what comes back. `limit`
 * describes the output limit, for the message when a reply is cut off.
 */
async function send(connection: Connection, body: string, cancel: AbortSignal | undefined, limit: string): Promise<Attempt<Reply>> {
  const timeout = AbortSignal.timeout(connection.timeoutMs);
  let response: Response;
  let text: string;
  try {
    response = await connection.fetch(`${API}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "Dungeons",
      },
      body,
      signal: cancel ? AbortSignal.any([timeout, cancel]) : timeout,
    });
    text = await response.text();
  } catch (error) {
    if (cancel?.aborted) return { ok: false, error: cancelled(), retryable: false };
    const name = typeof error === "object" && error !== null && "name" in error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return failure("timeout", `No reply from OpenRouter within ${connection.timeoutMs / 1000} s`);
    }
    return failure("network", `Could not reach OpenRouter: ${describeError(error)}`, { retryable: true });
  }
  const json = parseJson(text);
  const errorBody = errorSchema.safeParse(json);
  const hasChoices = typeof json === "object" && json !== null && "choices" in json;
  if (!response.ok || (errorBody.success && !hasChoices)) {
    // Once a provider accepts the request, OpenRouter reports failures in a 200 body.
    const code = errorBody.success ? Number(errorBody.data.error.code) : Number.NaN;
    const status = response.ok && Number.isInteger(code) ? code : response.status;
    const detail = errorBody.success ? errorBody.data.error.message ?? "no details" : text.slice(0, 300) || "empty response";
    return statusFailure(status, detail, json, retryAfterMs(response.headers.get("retry-after")));
  }
  const parsed = completionSchema.safeParse(json);
  if (!parsed.success) return failure("invalid_output", "OpenRouter returned an unexpected response", { raw: json });
  const completion = parsed.data;
  const cost = completion.usage?.cost;
  const usage: ModelUsage = {
    inputTokens: completion.usage?.prompt_tokens ?? 0,
    outputTokens: completion.usage?.completion_tokens ?? 0,
    ...(typeof cost === "number" ? { cost } : {}),
  };
  const choice = completion.choices[0];
  if (!choice) return failure("invalid_output", "OpenRouter returned no choices", { raw: json, usage });
  if (choice.error || choice.finish_reason === "error") {
    const code = typeof choice.error?.code === "number" ? choice.error.code : 500;
    return failure("api_error", `The model provider failed (${code}): ${choice.error?.message ?? "no details"}`, {
      raw: json, usage, retryable: code >= 500,
    });
  }
  if (choice.message?.refusal || choice.finish_reason === "content_filter") {
    return failure("refused", `The model declined: ${choice.message?.refusal ?? "content filter"}`, { raw: json, usage });
  }
  if (choice.finish_reason === "length") return failure("truncated", `The reply hit ${limit}`, { raw: json, usage });
  const message = (json as { choices: { message?: unknown }[] }).choices[0]?.message;
  return { ok: true, value: { raw: json, model: completion.model, choice, message, usage } };
}

/** Sends a request, retrying failures that may pass, after the delay OpenRouter asks for or a growing one. */
async function sendWithRetries(connection: Connection, body: string, signal: AbortSignal | undefined, limit: string): Promise<Reply> {
  for (let retry = 0; ; retry += 1) {
    if (signal?.aborted) throw cancelled();
    const attempt = await send(connection, body, signal, limit);
    if (attempt.ok) return attempt.value;
    if (!attempt.retryable || retry >= connection.maxRetries) throw attempt.error;
    await wait(connection.sleep(attempt.retryAfterMs ?? 1000 * 2 ** retry), signal);
  }
}

function limitText(maxTokens: boolean, limit: number, setting: string): string {
  return maxTokens
    ? `the ${limit}-token output limit, which includes reasoning (raise ${setting} or lower the reasoning effort)`
    : "the model's output limit";
}

/**
 * Calls models through OpenRouter. Each role's model is checked against
 * OpenRouter's catalog at startup, and requests only use parameters the model
 * supports. Routing is restricted to providers that honor all of them.
 */
export class OpenRouterProvider implements ModelProvider {
  readonly name = "openrouter";
  private readonly settings: OpenRouterSettings;
  private readonly capabilities: Record<AgentRole, ModelCapabilities>;
  /** The effort each role sends, or "default" to send none. */
  private readonly efforts: Record<AgentRole, string>;
  private readonly connection: Connection;
  private readonly schemas = new WeakMap<z.ZodType, unknown>();

  private constructor(
    settings: OpenRouterSettings,
    capabilities: Record<AgentRole, ModelCapabilities>,
    efforts: Record<AgentRole, string>,
  ) {
    this.settings = settings;
    this.capabilities = capabilities;
    this.efforts = efforts;
    this.connection = connectionOf(settings);
  }

  static async create(settings: OpenRouterSettings): Promise<OpenRouterProvider> {
    const catalog = await fetchOpenRouterModels(settings.fetch ?? fetch);
    const lookUp = (role: AgentRole): ModelCapabilities => {
      const id = settings.models[role];
      const model = catalog.find((entry) => entry.id === id);
      if (!model) {
        throw new ProviderConfigError(`OpenRouter has no model ${id}. List models with: npm run director -- models`);
      }
      return capabilitiesOf(model);
    };
    const capabilities = { character: lookUp("character"), dm: lookUp("dm") };
    return new OpenRouterProvider(settings, capabilities, {
      character: resolveEffort(settings.efforts.character, capabilities.character),
      dm: resolveEffort(settings.efforts.dm, capabilities.dm),
    });
  }

  modelFor(role: AgentRole): string {
    return this.settings.models[role];
  }

  /** The model and the request features a role uses, for display. */
  describe(role: AgentRole): string {
    const capabilities = this.capabilities[role];
    const effort = this.efforts[role];
    const output = capabilities.structuredOutputs ? "structured output" : capabilities.jsonMode ? "JSON mode" : "free-form output";
    let reasoning = `reasoning ${effort}`;
    if (!capabilities.reasoning) reasoning = "no reasoning";
    else if (effort === "default") reasoning = `reasoning at the model default (${capabilities.defaultEffort ?? "unspecified"})`;
    else if (this.settings.efforts[role] === undefined && effort !== DEFAULT_REASONING_EFFORT) {
      reasoning += `, the nearest it offers to ${DEFAULT_REASONING_EFFORT}`;
    }
    return `${this.settings.models[role]} (${output}, ${reasoning})`;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const limit = limitText(this.capabilities[request.role].maxTokens, this.settings.maxOutputTokens, "DUNGEONS_MAX_OUTPUT_TOKENS");
    const reply = await sendWithRetries(this.connection, JSON.stringify(this.body(request)), request.signal, limit);
    return {
      output: parseReply(reply.choice.message?.content),
      raw: reply.raw,
      model: reply.model ?? this.settings.models[request.role],
      usage: reply.usage,
    };
  }

  private jsonSchema(schema: z.ZodType): unknown {
    let converted = this.schemas.get(schema);
    if (converted === undefined) {
      converted = sanitizeSchema(z.toJSONSchema(schema));
      this.schemas.set(schema, converted);
    }
    return converted;
  }

  private body(request: ModelRequest): Record<string, unknown> {
    const capabilities = this.capabilities[request.role];
    const effort = this.efforts[request.role];
    const format = capabilities.structuredOutputs
      ? { type: "json_schema", json_schema: { name: request.schemaName, strict: true, schema: this.jsonSchema(request.schema) } }
      : capabilities.jsonMode ? { type: "json_object" } : undefined;
    return {
      model: this.settings.models[request.role],
      messages: [
        ...(this.settings.systemPrompt ? [{ role: "system", content: this.settings.systemPrompt }] : []),
        { role: "system", content: request.system },
        { role: "user", content: request.prompt },
      ],
      ...(capabilities.maxTokens ? { max_tokens: this.settings.maxOutputTokens } : {}),
      ...(format ? { response_format: format } : {}),
      ...(capabilities.reasoning && effort !== "default" ? { reasoning: { effort } } : {}),
      provider: { require_parameters: true },
    };
  }
}

export interface ChatSettings {
  apiKey: string;
  model: string;
  /** As for a role in OpenRouterSettings: an effort, "default", or undefined for low or the nearest. */
  effort: string | undefined;
  maxOutputTokens: number;
  /** Sent as the first system message of every request. */
  systemPrompt?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Settings for the AI creator;  `model` overrides the configured one. */
/** The AI creator's model unless the director picks another. */
export function creatorModelFromEnv(env: NodeJS.ProcessEnv): string {
  return setting(env, "DUNGEONS_CREATOR_MODEL") || setting(env, "DUNGEONS_MODEL") || DEFAULT_OPENROUTER_MODEL;
}

export function creatorSettingsFromEnv(env: NodeJS.ProcessEnv, model?: string): ChatSettings {
  const apiKey = setting(env, "OPENROUTER_API_KEY");
  if (!apiKey) throw new ProviderConfigError("Set OPENROUTER_API_KEY to use the AI creator (see .env.example)");
  const maxOutputTokens = Number(setting(env, "DUNGEONS_CREATOR_MAX_TOKENS") ?? DEFAULT_CREATOR_MAX_TOKENS);
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new ProviderConfigError("DUNGEONS_CREATOR_MAX_TOKENS must be a positive integer");
  }
  return {
    apiKey,
    model: model?.trim() || creatorModelFromEnv(env),
    effort: effortSetting(env, "DUNGEONS_CREATOR_EFFORT") ?? effortSetting(env, "DUNGEONS_REASONING_EFFORT"),
    maxOutputTokens,
    ...systemPromptSetting(env),
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatReply {
  /** The assistant message as OpenRouter sent it: send it back unchanged, before the tool results. */
  message: unknown;
  content: string | null;
  toolCalls: ToolCall[];
  model: string;
  usage: ModelUsage;
}

/** A conversation with one model that can call tools, for the AI creator. */
export class OpenRouterChat {
  private readonly settings: ChatSettings;
  private readonly capabilities: ModelCapabilities;
  private readonly effort: string;
  private readonly connection: Connection;

  private constructor(settings: ChatSettings, capabilities: ModelCapabilities, effort: string) {
    this.settings = settings;
    this.capabilities = capabilities;
    this.effort = effort;
    this.connection = connectionOf(settings);
  }

  /** Checks the model against OpenRouter's catalog: it must exist and call tools. */
  static create(settings: ChatSettings, catalog: readonly OpenRouterModel[]): OpenRouterChat {
    const model = catalog.find((entry) => entry.id === settings.model);
    if (!model) throw new ProviderConfigError(`OpenRouter has no model ${settings.model}`);
    const capabilities = capabilitiesOf(model);
    if (!capabilities.tools) {
      throw new ProviderConfigError(`${settings.model} cannot call tools, which the AI creator needs. Choose another model.`);
    }
    return new OpenRouterChat(settings, capabilities, resolveEffort(settings.effort, capabilities));
  }

  get model(): string {
    return this.settings.model;
  }

  async complete(messages: readonly unknown[], tools: readonly unknown[], signal?: AbortSignal): Promise<ChatReply> {
    const { capabilities, effort } = this;
    // No tool_choice: "auto" is the default, and requiring the parameter would rule out providers that omit it.
    const body = JSON.stringify({
      model: this.settings.model,
      messages: this.settings.systemPrompt ? [{ role: "system", content: this.settings.systemPrompt }, ...messages] : messages,
      tools,
      ...(capabilities.maxTokens ? { max_tokens: this.settings.maxOutputTokens } : {}),
      ...(capabilities.reasoning && effort !== "default" ? { reasoning: { effort } } : {}),
      provider: { require_parameters: true },
    });
    const limit = limitText(capabilities.maxTokens, this.settings.maxOutputTokens, "DUNGEONS_CREATOR_MAX_TOKENS");
    const reply = await sendWithRetries(this.connection, body, signal, limit);
    return {
      message: reply.message,
      content: reply.choice.message?.content || null,
      toolCalls: (reply.choice.message?.tool_calls ?? []).map((call) => ({
        id: call.id, name: call.function.name, arguments: call.function.arguments ?? "",
      })),
      model: reply.model ?? this.settings.model,
      usage: reply.usage,
    };
  }
}
