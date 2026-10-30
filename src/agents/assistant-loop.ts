import type { ChatReply } from "./openrouter.ts";
import { ProviderError } from "./provider.ts";
import type { ModelUsage } from "./provider.ts";

// The loop an assistant runs for one message from the director: the model
// calls tools, sees their results, and calls more, until it replies or a
// limit stops it. The AI creator and the story editor each supply their own
// conversation and tools.

export interface ChatModel {
  readonly model: string;
  /** The most tokens the model takes in one call, input and output together, if known. */
  readonly contextLength?: number | null;
  complete(messages: readonly unknown[], tools: readonly unknown[], signal?: AbortSignal): Promise<ChatReply>;
}

export interface AssistantLimits {
  /** Model calls for one message. */
  maxRounds: number;
  maxToolCalls: number;
  /** Credits for one message, when the provider reports cost. */
  maxCost: number;
  /** Input and output tokens for one message: the cap that holds when cost is not reported. */
  maxTokens: number;
}

export interface AssistantUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Credits spent; null if any call did not report its cost. */
  cost: number | null;
}

export interface ToolLine {
  name: string;
  summary: string;
  ok: boolean;
}

/** One tool call's outcome. */
export interface ToolResult {
  ok: boolean;
  /** For the director: what changed, or what went wrong. */
  summary: string;
  /** For the model: the tool message's content. */
  content: string;
  /** Whether the call changed anything. */
  changed: boolean;
}

export type LoopEvent =
  | { type: "text"; text: string }
  | ({ type: "tool" } & ToolLine)
  | { type: "usage"; usage: AssistantUsage };

export interface LoopRun {
  /** The model's closing message; empty if it was stopped before it finished. */
  reply: string;
  tools: ToolLine[];
  usage: AssistantUsage;
  /** Why it stopped before the model finished, if it did. */
  stopped?: string;
  error?: string;
}

export async function runToolLoop(options: {
  chat: ChatModel;
  messages: unknown[];
  definitions: readonly unknown[];
  limits: AssistantLimits;
  signal?: AbortSignal | undefined;
  onEvent(event: LoopEvent): void;
  /** Runs one call. A failed call runs again once the rest of its reply has, as it may refer to something a later call adds. */
  runTool(name: string, argumentsText: string): Promise<ToolResult>;
  /** After each round of calls, told whether any of them changed something. */
  afterRound?(changed: boolean): Promise<void>;
}): Promise<LoopRun> {
  const { chat, messages, limits, signal, onEvent } = options;
  const usage: AssistantUsage = { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
  const tools: ToolLine[] = [];
  // Text that comes with tool calls is progress, shown as it streams; the reply is what the model says once it is done.
  let reply = "";
  let toolCalls = 0;
  let stopped: string | undefined;
  let error: string | undefined;

  const count = (spent: ModelUsage) => {
    usage.calls += 1;
    usage.inputTokens += spent.inputTokens;
    usage.outputTokens += spent.outputTokens;
    usage.cost = usage.cost === null || spent.cost === undefined ? null : usage.cost + spent.cost;
    onEvent({ type: "usage", usage: { ...usage } });
  };

  try {
    for (let round = 1; ; round += 1) {
      if (signal?.aborted) {
        stopped = "Stopped.";
        break;
      }
      if (round > limits.maxRounds) {
        stopped = `Stopped after ${limits.maxRounds} model calls, the limit for one message, before it finished.`;
        break;
      }
      const answer = await chat.complete(messages, options.definitions, signal);
      count(answer.usage);
      const text = answer.content?.trim();
      if (text) onEvent({ type: "text", text });
      if (answer.toolCalls.length === 0) {
        reply = text ?? "";
        break;
      }
      messages.push(answer.message ?? {
        role: "assistant",
        content: answer.content,
        tool_calls: answer.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })),
      });
      // The calls run in order. One that failed runs again once the rest have,
      // since it may refer to something a later call in the same reply added.
      const outcomes: (ToolResult | undefined)[] = [];
      for (const call of answer.toolCalls) {
        if (toolCalls >= limits.maxToolCalls) {
          stopped = `Stopped at ${limits.maxToolCalls} tool calls, the limit for one message.`;
          outcomes.push(undefined);
          continue;
        }
        toolCalls += 1;
        outcomes.push(await options.runTool(call.name, call.arguments));
      }
      for (let progress = true; progress;) {
        progress = false;
        for (const [index, call] of answer.toolCalls.entries()) {
          if (outcomes[index]?.ok !== false) continue;
          const again = await options.runTool(call.name, call.arguments);
          if (!again.ok) continue;
          outcomes[index] = again;
          progress = true;
        }
      }
      let changed = false;
      for (const [index, call] of answer.toolCalls.entries()) {
        const outcome = outcomes[index];
        // Every call needs an answer, or the next request is malformed.
        if (!outcome) {
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: false, error: "Not run: the tool call limit was reached." }) });
          continue;
        }
        changed ||= outcome.changed;
        const line = { name: call.name, summary: outcome.summary, ok: outcome.ok };
        tools.push(line);
        onEvent({ type: "tool", ...line });
        messages.push({ role: "tool", tool_call_id: call.id, content: outcome.content });
      }
      await options.afterRound?.(changed);
      if (stopped) break;
      // The cost caps a message; tokens cap it only when a call didn't report its cost.
      if (usage.cost === null ? usage.inputTokens + usage.outputTokens >= limits.maxTokens : usage.cost >= limits.maxCost) {
        stopped = "Stopped at the spending limit for one message.";
        break;
      }
    }
  } catch (problem) {
    if (!(problem instanceof ProviderError)) throw problem;
    if (problem.usage) count(problem.usage);
    if (problem.kind === "cancelled") stopped = "Stopped.";
    else error = problem.message;
  }
  return {
    reply,
    tools,
    usage,
    ...(stopped === undefined ? {} : { stopped }),
    ...(error === undefined ? {} : { error }),
  };
}
