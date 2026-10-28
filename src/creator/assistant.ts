import type { ChatReply } from "../agents/openrouter.ts";
import { creatorSystemPrompt, frameOf } from "../agents/prompts.ts";
import { ProviderError } from "../agents/provider.ts";
import type { ModelUsage } from "../agents/provider.ts";
import { draftProblems } from "./operations.ts";
import type { Draft, DraftProblem } from "./operations.ts";
import { creatorToolDefinitions, runCreatorTool } from "./tools.ts";

// The AI creator's loop for one message from the director: the model calls
// tools, sees their results, and calls more, until it replies or a limit stops
// it. Each round's changes are saved before the next, so stopping keeps them.

export interface ChatModel {
  readonly model: string;
  complete(messages: readonly unknown[], tools: readonly unknown[], signal?: AbortSignal): Promise<ChatReply>;
}

export interface CreatorLimits {
  /** Model calls for one message. */
  maxRounds: number;
  maxToolCalls: number;
  /** Credits for one message, when the provider reports cost. */
  maxCost: number;
  /** Input and output tokens for one message: the cap that holds when cost is not reported. */
  maxTokens: number;
}

export const CREATOR_LIMITS: CreatorLimits = { maxRounds: 8, maxToolCalls: 40, maxCost: 0.5, maxTokens: 400_000 };

export interface CreatorUsage {
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

export type CreatorEvent =
  | { type: "text"; text: string }
  | ({ type: "tool" } & ToolLine)
  | { type: "draft"; draft: Draft; revision: number; problems: DraftProblem[] }
  | { type: "usage"; usage: CreatorUsage };

export interface CreatorRun {
  draft: Draft;
  reply: string;
  tools: ToolLine[];
  usage: CreatorUsage;
  /** Why it stopped before the model finished, if it did. */
  stopped?: string;
  error?: string;
}

/** An earlier message and its outcome, so the model can follow the conversation. */
export interface CreatorTurn {
  message: string;
  reply: string;
  tools: readonly ToolLine[];
}

const HISTORY_TURNS = 6;
const HISTORY_REPLY_CHARS = 2000;

/** Counts, never content: the draft's text reaches the model only through tool results. */
function draftStatus(draft: Draft): string {
  const { seed } = draft;
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const problems = draftProblems(draft);
  const errors = problems.filter((problem) => problem.severity === "error").length;
  if (seed.locations.length + seed.characters.length + seed.items.length === 0 && !draft.cast.premise) return "The draft is empty.";
  return `The draft has ${count(seed.locations.length, "place")}, ${count(seed.characters.length, "character")}, `
    + `${count(seed.items.length, "item")}, ${count(seed.challenges.length, "challenge")}, and ${count(seed.threats?.length ?? 0, "threat")}; `
    + `${count(errors, "error")} and ${count(problems.length - errors, "warning")}. Call get_draft to read it.`;
}

function conversation(draft: Draft, history: readonly CreatorTurn[], message: string): unknown[] {
  const messages: unknown[] = [{ role: "system", content: creatorSystemPrompt(frameOf(draft.cast, draft.seed)) }];
  for (const turn of history.slice(-HISTORY_TURNS)) {
    const changes = turn.tools.filter((line) => line.ok && line.name !== "get_draft" && line.name !== "check_draft");
    const reply = [turn.reply.slice(0, HISTORY_REPLY_CHARS) || "(No reply.)", changes.length > 0 ? `Changes made: ${changes.map((line) => line.summary).join(" ")}` : ""];
    messages.push({ role: "user", content: turn.message }, { role: "assistant", content: reply.filter(Boolean).join("\n\n") });
  }
  messages.push({ role: "user", content: `${message}\n\n(${draftStatus(draft)})` });
  return messages;
}

export async function runCreator(options: {
  chat: ChatModel;
  draft: Draft;
  history: readonly CreatorTurn[];
  message: string;
  limits?: CreatorLimits;
  signal?: AbortSignal;
  onEvent(event: CreatorEvent): void;
  /** Saves the draft after a round of tool calls changed it, and returns its new revision. */
  save(draft: Draft): Promise<number>;
}): Promise<CreatorRun> {
  const { chat, signal, onEvent } = options;
  const limits = options.limits ?? CREATOR_LIMITS;
  const messages = conversation(options.draft, options.history, options.message);
  const definitions = creatorToolDefinitions();
  const usage: CreatorUsage = { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
  const tools: ToolLine[] = [];
  const replies: string[] = [];
  let draft = options.draft;
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
        stopped = `Stopped after ${limits.maxRounds} model calls, the limit for one message.`;
        break;
      }
      const reply = await chat.complete(messages, definitions, signal);
      count(reply.usage);
      const text = reply.content?.trim();
      if (text) {
        replies.push(text);
        onEvent({ type: "text", text });
      }
      if (reply.toolCalls.length === 0) break;
      messages.push(reply.message ?? {
        role: "assistant",
        content: reply.content,
        tool_calls: reply.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })),
      });
      let changed = false;
      for (const call of reply.toolCalls) {
        // Every call needs an answer, or the next request is malformed.
        if (toolCalls >= limits.maxToolCalls) {
          stopped = `Stopped at ${limits.maxToolCalls} tool calls, the limit for one message.`;
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: false, error: "Not run: the tool call limit was reached." }) });
          continue;
        }
        toolCalls += 1;
        const outcome = runCreatorTool(draft, call.name, call.arguments);
        draft = outcome.draft;
        changed ||= outcome.changed;
        const line = { name: call.name, summary: outcome.summary, ok: outcome.ok };
        tools.push(line);
        onEvent({ type: "tool", ...line });
        messages.push({ role: "tool", tool_call_id: call.id, content: outcome.content });
      }
      if (changed) {
        const revision = await options.save(draft);
        onEvent({ type: "draft", draft, revision, problems: draftProblems(draft) });
      }
      if (stopped) break;
      if ((usage.cost !== null && usage.cost >= limits.maxCost) || usage.inputTokens + usage.outputTokens >= limits.maxTokens) {
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
    draft,
    reply: replies.join("\n\n"),
    tools,
    usage,
    ...(stopped === undefined ? {} : { stopped }),
    ...(error === undefined ? {} : { error }),
  };
}
