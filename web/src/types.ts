// The server's response shapes, shared with the browser as types only.
export type { AgentPrompts, MemoryReport } from "../../src/agents/inspect.ts";
export type { MetricsReport } from "../../src/agents/metrics.ts";
export type { Cast, NpcPersona, Persona } from "../../src/agents/prompts.ts";
export type { ModelSetup, Setup } from "../../src/agents/setup.ts";
export type { DraftSummary, TraceRecord, WorldSummary } from "../../src/engine.ts";
export type { CreatorEvent, CreatorUsage, ToolLine } from "../../src/creator/assistant.ts";
export type { Draft, DraftProblem, DraftSection } from "../../src/creator/operations.ts";
export type { ChatEntry, DraftView } from "../../src/server/drafts.ts";
export type { Character, WorldState } from "../../src/model.ts";
export type { EventView, ModelInfo, WorldView } from "../../src/server/app.ts";
export type { RunStatus } from "../../src/server/runs.ts";

export interface AdventureInfo {
  id: string;
  name: string;
  summary: string;
}
