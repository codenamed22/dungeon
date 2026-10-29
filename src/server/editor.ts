import { randomBytes } from "node:crypto";
import type { AssistantLimits, AssistantUsage, ChatModel, ToolLine } from "../agents/assistant-loop.ts";
import { Lease } from "../agents/runner.ts";
import type { Setup } from "../agents/setup.ts";
import { runEditor } from "../editor/assistant.ts";
import type { EditorEvent, EditorPass, ProposedChange } from "../editor/assistant.ts";
import type { AdventureEngine } from "../engine.ts";
import { EngineError } from "../model.ts";

// The story editor at work on a world, one message at a time. While it works
// it holds the world's scheduler lease, so no run, here or from the CLI, plays
// a turn under it, and it can't start while a run holds the lease.

/** One message to the story editor and what came of it. */
export interface EditorEntry {
  id: string;
  at: string;
  message: string;
  pass: EditorPass;
  reply: string;
  tools: ToolLine[];
  /** What a review proposed, if it did. */
  proposal?: ProposedChange[];
  usage: AssistantUsage;
  model: string;
  revisionBefore: number;
  revisionAfter: number;
  /** The setup before and after, so the director can undo agent changes while nothing changed since. */
  setupBefore: Setup;
  setupAfter: Setup;
  /** Story events it committed, in order. */
  committed: number[];
  /** Why it stopped early, if it did. */
  stopped?: string;
  error?: string;
}

export interface EditorView {
  chat: EditorEntry[];
  /** Whether the story editor is working on the world. */
  busy: boolean;
}

export const MAX_EDITOR_ENTRIES = 100;
/** How long the editor's hold on a world lasts unless renewed; it renews a third of the way through. */
const LEASE_MS = 60_000;

export class EditorService {
  private readonly busy = new Set<string>();
  private readonly engine: AdventureEngine;

  constructor(engine: AdventureEngine) {
    this.engine = engine;
  }

  async view(worldId: string): Promise<EditorView> {
    return { chat: await this.engine.getEditorChat(worldId) as EditorEntry[], busy: this.busy.has(worldId) };
  }

  isBusy(worldId: string): boolean {
    return this.busy.has(worldId);
  }

  /**
   * Runs the story editor on one message. Once it holds the world, `onStart`
   * is called; earlier failures throw. The message and its outcome are added to
   * the world's editor chat, even when stopped.
   */
  async assist(worldId: string, options: {
    message: string;
    pass: EditorPass;
    chat: ChatModel;
    signal: AbortSignal;
    limits?: AssistantLimits;
    onStart(): void;
    onEvent(event: EditorEvent): void;
  }): Promise<{ entry: EditorEntry; view: EditorView }> {
    if (this.busy.has(worldId)) throw new EngineError("WORLD_BUSY", "The story editor is already working on this world");
    const before = await this.engine.getWorld(worldId);
    this.busy.add(worldId);
    const lease = new Lease(this.engine, worldId, LEASE_MS);
    let held = false;
    try {
      try {
        await lease.acquire();
        held = true;
      } catch (error) {
        if (error instanceof EngineError && error.code === "WORLD_BUSY") {
          throw new EngineError("WORLD_BUSY", "This world is running; pause it, then ask the story editor");
        }
        throw error;
      }
      const chat = await this.engine.getEditorChat(worldId) as EditorEntry[];
      options.onStart();
      const run = await runEditor({
        chat: options.chat,
        engine: this.engine,
        worldId,
        pass: options.pass,
        history: chat,
        message: options.message,
        signal: AbortSignal.any([options.signal, lease.signal]),
        ...(options.limits ? { limits: options.limits } : {}),
        onEvent: options.onEvent,
      });
      const entry: EditorEntry = {
        id: randomBytes(6).toString("hex"),
        at: new Date().toISOString(),
        message: options.message,
        pass: options.pass,
        reply: run.reply,
        tools: run.tools,
        ...(run.proposal ? { proposal: run.proposal } : {}),
        usage: run.usage,
        model: options.chat.model,
        revisionBefore: before.revision,
        revisionAfter: (await this.engine.getWorld(worldId)).revision,
        setupBefore: run.setupBefore,
        setupAfter: run.setupAfter,
        committed: run.committed,
        ...(run.stopped === undefined ? {} : { stopped: lease.lost ? "Stopped: a run took over the world." : run.stopped }),
        ...(run.error === undefined ? {} : { error: run.error }),
      };
      const saved = [...chat, entry].slice(-MAX_EDITOR_ENTRIES);
      await this.engine.saveEditorChat(worldId, saved);
      return { entry, view: { chat: saved, busy: false } };
    } finally {
      if (held) await lease.release();
      this.busy.delete(worldId);
    }
  }
}
