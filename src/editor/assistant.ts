import { castForWorld } from "../adventures/index.ts";
import { runToolLoop } from "../agents/assistant-loop.ts";
import type { AssistantLimits, ChatModel, LoopEvent, LoopRun, ToolLine } from "../agents/assistant-loop.ts";
import { formatClock } from "../agents/context.ts";
import { editorSystemPrompt, frameOf } from "../agents/prompts.ts";
import type { EditorPass } from "../agents/prompts.ts";
import { loadSetup } from "../agents/setup.ts";
import type { Setup } from "../agents/setup.ts";
import type { AdventureEngine } from "../engine.ts";
import { EngineError } from "../model.ts";
import { EDITOR_READS, editorToolDefinitions, runEditorTool, storyLines } from "./tools.ts";
import type { EditorContext, ProposedChange } from "./tools.ts";

// The story editor's loop for one message from the director (see
// assistant-loop.ts): a review that reads the story and proposes changes, or a
// fix that makes the ones the director approved. Agent changes are saved after
// each round, and story changes commit as they are made, so stopping keeps them.

export type { EditorPass, ProposedChange };

export const EDITOR_LIMITS: AssistantLimits = { maxRounds: 10, maxToolCalls: 30, maxCost: 0.5, maxTokens: 300_000 };

/** How much of the story each message carries: the newest lines, up to these limits. */
const STORY_LINES = 150;
const STORY_CHARS = 40_000;
const HISTORY_TURNS = 6;
const HISTORY_REPLY_CHARS = 2000;

export type EditorEvent =
  | LoopEvent
  | { type: "proposal"; changes: ProposedChange[] }
  | { type: "setup"; setup: Setup };

/** An earlier message and its outcome, so the model can follow the conversation. */
export interface EditorTurn {
  message: string;
  pass: EditorPass;
  reply: string;
  tools: readonly ToolLine[];
  proposal?: readonly ProposedChange[] | undefined;
  stopped?: string | undefined;
}

export interface EditorRun extends LoopRun {
  /** What the review proposed; null if it proposed nothing. */
  proposal: ProposedChange[] | null;
  setupBefore: Setup;
  setupAfter: Setup;
  /** Story events committed, in order. */
  committed: number[];
}

function history(turns: readonly EditorTurn[]): unknown[] {
  return turns.slice(-HISTORY_TURNS).flatMap((turn) => {
    const changes = turn.tools.filter((line) => line.ok && !EDITOR_READS.has(line.name) && line.name !== "propose_changes");
    const reply = [
      turn.reply.slice(0, HISTORY_REPLY_CHARS) || "(No reply.)",
      turn.proposal?.length ? `Proposed:\n${turn.proposal.map((change, index) => `${index + 1}. ${change.title}: ${change.detail}`).join("\n")}` : "",
      changes.length > 0 ? `Changes made: ${changes.map((line) => line.summary).join(" ")}` : "",
      turn.stopped ? `(This was cut off before it finished: ${turn.stopped} Anything not listed above was not done.)` : "",
    ];
    return [{ role: "user", content: turn.message }, { role: "assistant", content: reply.filter(Boolean).join("\n\n") }];
  });
}

export async function runEditor(options: {
  chat: ChatModel;
  engine: AdventureEngine;
  worldId: string;
  pass: EditorPass;
  history: readonly EditorTurn[];
  message: string;
  limits?: AssistantLimits;
  signal?: AbortSignal;
  onEvent(event: EditorEvent): void;
}): Promise<EditorRun> {
  const { engine, worldId, pass, onEvent } = options;
  const state = await engine.getWorld(worldId);
  const [created] = await engine.getEvents(worldId, 0, 1);
  if (created?.data.type !== "world_created") throw new EngineError("CORRUPT_STORAGE", `World ${worldId} has no creation event`);
  const setupBefore = await loadSetup(engine, worldId, state, castForWorld);
  const context: EditorContext = {
    engine, worldId, seed: created.data.seed, setup: setupBefore, setupChanged: false, proposal: null, committed: [],
  };
  const story = await storyLines(engine, worldId, { newest: true, lines: STORY_LINES, chars: STORY_CHARS });
  const ending = state.endings?.find((entry) => entry.id === state.endedWith);
  const status = [
    `It is ${formatClock(state.elapsedSeconds)} in the story, at line #${state.revision}.`,
    ending ? `The story has ended (${ending.name}): only lines can be edited or deleted now, and agent changes matter only to a branch.` : "",
  ].filter(Boolean).join(" ");
  const messages: unknown[] = [
    { role: "system", content: editorSystemPrompt(frameOf(setupBefore.cast, state), pass) },
    ...history(options.history),
    {
      role: "user",
      content: [
        options.message,
        "",
        `(${status} The story so far, newest last${story.left > 0 ? `; ${story.left} earlier lines are left out, and read_story gives them` : ""}:`,
        ...(story.lines.length > 0 ? story.lines : ["Nothing has happened yet."]),
        ")",
      ].join("\n"),
    },
  ];
  const run = await runToolLoop({
    chat: options.chat,
    messages,
    definitions: editorToolDefinitions(pass),
    limits: options.limits ?? EDITOR_LIMITS,
    signal: options.signal,
    onEvent,
    runTool: async (name, argumentsText) => {
      const result = await runEditorTool(context, pass, name, argumentsText);
      if (result.ok && name === "propose_changes") onEvent({ type: "proposal", changes: context.proposal! });
      return result;
    },
    afterRound: async () => {
      if (!context.setupChanged) return;
      await engine.saveSetup(worldId, context.setup);
      context.setupChanged = false;
      onEvent({ type: "setup", setup: context.setup });
    },
  });
  return { ...run, proposal: context.proposal, setupBefore, setupAfter: context.setup, committed: context.committed };
}
