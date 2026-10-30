import { runToolLoop } from "../agents/assistant-loop.ts";
import type { AssistantLimits, AssistantUsage, ChatModel, LoopEvent, ToolLine } from "../agents/assistant-loop.ts";
import { creatorSystemPrompt, frameOf } from "../agents/prompts.ts";
import { draftProblems } from "./operations.ts";
import type { Draft, DraftProblem } from "./operations.ts";
import { sampleListing } from "./samples.ts";
import type { DraftSample } from "./samples.ts";
import { creatorExamples, creatorToolDefinitions, runCreatorTool, SAMPLE_TOOL } from "./tools.ts";
import type { BuildStepId } from "./steps.ts";

// The AI creator's loop for one message from the director (see
// assistant-loop.ts). Each round's changes to the draft are saved before the
// next, so stopping keeps them.

export type { ChatModel, ToolLine };
export type CreatorLimits = AssistantLimits;
export type CreatorUsage = AssistantUsage;

export const CREATOR_LIMITS: CreatorLimits = { maxRounds: 16, maxToolCalls: 60, maxCost: 0.5, maxTokens: 400_000 };

export type CreatorEvent =
  | LoopEvent
  | { type: "draft"; draft: Draft; revision: number; problems: DraftProblem[] };

export interface CreatorRun {
  draft: Draft;
  /** The model's closing message; empty if it was stopped before it finished. */
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
  stopped?: string | undefined;
}

const HISTORY_TURNS = 6;
/** Tools that only read, so a turn's changes leave them out. */
const READS = new Set(["get_draft", "check_draft", "get_example", SAMPLE_TOOL]);
const HISTORY_REPLY_CHARS = 2000;

/** Counts, never content: the draft's text reaches the model only through tool results. */
function draftStatus(draft: Draft): string {
  const { seed } = draft;
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const problems = draftProblems(draft);
  const errors = problems.filter((problem) => problem.severity === "error").length;
  if (seed.locations.length + seed.characters.length + seed.items.length === 0 && !draft.cast.premise) return "The draft is empty.";
  return `The draft has ${count(seed.locations.length, "place")}, ${count(seed.characters.length, "character")}, `
    + `${count(seed.items.length, "item")}, ${count(seed.challenges.length, "challenge")}, ${count(seed.threats?.length ?? 0, "threat")}, `
    + `and ${count(seed.tracks?.length ?? 0, "hidden track")}; `
    + `${count(errors, "error")} and ${count(problems.length - errors, "warning")}. Call get_draft to read it.`;
}

function conversation(
  draft: Draft, history: readonly CreatorTurn[], message: string, step: BuildStepId | undefined, samples: readonly DraftSample[],
): unknown[] {
  const listings = samples.map(sampleListing);
  const messages: unknown[] = [{ role: "system", content: creatorSystemPrompt(frameOf(draft.cast, draft.seed), creatorExamples(), step, listings) }];
  for (const turn of history.slice(-HISTORY_TURNS)) {
    const changes = turn.tools.filter((line) => line.ok && !READS.has(line.name));
    const reply = [
      turn.reply.slice(0, HISTORY_REPLY_CHARS) || "(No reply.)",
      changes.length > 0 ? `Changes made: ${changes.map((line) => line.summary).join(" ")}` : "",
      turn.stopped ? `(This was cut off before it finished: ${turn.stopped} Anything not listed above was not done.)` : "",
    ];
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
  /** In a guided build, the step to run: only its tools are open. */
  step?: BuildStepId;
  /** Sample chats the director added, which it may read for inspiration. */
  samples?: readonly DraftSample[];
  limits?: CreatorLimits;
  signal?: AbortSignal;
  onEvent(event: CreatorEvent): void;
  /** Saves the draft after a round of tool calls changed it, and returns its new revision. */
  save(draft: Draft): Promise<number>;
}): Promise<CreatorRun> {
  const { step, onEvent } = options;
  const samples = options.samples ?? [];
  let draft = options.draft;
  const run = await runToolLoop({
    chat: options.chat,
    messages: conversation(options.draft, options.history, options.message, step, samples),
    definitions: creatorToolDefinitions(step, samples.length > 0),
    limits: options.limits ?? CREATOR_LIMITS,
    signal: options.signal,
    onEvent,
    runTool: async (name, argumentsText) => {
      const outcome = runCreatorTool(draft, name, argumentsText, step, samples);
      draft = outcome.draft;
      return outcome;
    },
    afterRound: async (changed) => {
      if (!changed) return;
      const revision = await options.save(draft);
      onEvent({ type: "draft", draft, revision, problems: draftProblems(draft) });
    },
  });
  return { draft, ...run };
}
