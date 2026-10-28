import type { z } from "zod";

export type AgentRole = "character" | "dm";

export interface ModelRequest {
  role: AgentRole;
  system: string;
  prompt: string;
  /** Structured output the reply must match; the runner validates it again. */
  schema: z.ZodType;
  schemaName: string;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelResponse {
  /** The structured reply, not yet validated. */
  output: unknown;
  /** The provider's raw reply, kept for traces. */
  raw: unknown;
  model: string;
  usage: ModelUsage;
}

export type ProviderFailure =
  | "timeout"
  | "network"
  | "rate_limited"
  | "refused"
  | "truncated"
  | "invalid_output"
  | "api_error"
  | "script_exhausted";

/** An expected provider failure; the turn that hit it is recorded as failed. */
export class ProviderError extends Error {
  readonly kind: ProviderFailure;
  readonly raw: unknown;
  readonly usage: ModelUsage | undefined;

  constructor(kind: ProviderFailure, message: string, details: { raw?: unknown; usage?: ModelUsage } = {}) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.raw = details.raw;
    this.usage = details.usage;
  }
}

/** A provider that cannot start: missing credentials, an unknown model, an unsupported setting. */
export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

export interface ModelProvider {
  readonly name: string;
  modelFor(role: AgentRole): string;
  generate(request: ModelRequest): Promise<ModelResponse>;
}

/** A scripted reply, or a function computing one from the request. */
export type ScriptStep =
  | { role: AgentRole; output: unknown }
  | { role: AgentRole; error: ProviderError }
  | { role: AgentRole; respond: (request: ModelRequest) => unknown | Promise<unknown> };

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Replays a fixed sequence of replies with no network, so scheduler behaviour is
 * deterministic. Fails explicitly if the scheduler asks out of order or too often.
 */
export class ScriptedProvider implements ModelProvider {
  readonly name = "scripted";
  readonly requests: ModelRequest[] = [];
  private readonly steps: ScriptStep[];

  constructor(steps: ScriptStep[]) {
    this.steps = [...steps];
  }

  get remaining(): number {
    return this.steps.length;
  }

  modelFor(): string {
    return "scripted";
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const step = this.steps.shift();
    if (!step) throw new ProviderError("script_exhausted", `No scripted reply left for the ${request.role}`);
    if (step.role !== request.role) {
      throw new ProviderError("script_exhausted", `Script expected a ${step.role} request, got ${request.role}`);
    }
    if ("error" in step) throw step.error;
    const output = "respond" in step ? await step.respond(request) : step.output;
    return {
      output,
      raw: output,
      model: "scripted",
      usage: {
        inputTokens: estimateTokens(request.system + request.prompt),
        outputTokens: estimateTokens(JSON.stringify(output) ?? ""),
      },
    };
  }
}
