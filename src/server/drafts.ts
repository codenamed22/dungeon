import { randomBytes } from "node:crypto";
import { findAdventure } from "../adventures/index.ts";
import { runCreator } from "../creator/assistant.ts";
import type { ChatModel, CreatorEvent, CreatorLimits, CreatorUsage, ToolLine } from "../creator/assistant.ts";
import { blankDraft, draftProblems, draftSchema, publishable, slugify } from "../creator/operations.ts";
import type { Draft, DraftProblem } from "../creator/operations.ts";
import type { BuildStepId } from "../creator/steps.ts";
import type { AdventureEngine, DraftRecord, DraftSummary } from "../engine.ts";
import { EngineError, parseInput } from "../model.ts";

// Drafts in the world creator: their storage, problems, and publication as a
// playable world. The AI creator claims a draft while it works on it; nothing
// else may change the draft until it lets go.

/** One message to the AI creator and what came of it. */
export interface ChatEntry {
  id: string;
  at: string;
  message: string;
  reply: string;
  tools: ToolLine[];
  usage: CreatorUsage;
  model: string;
  revisionBefore: number;
  revisionAfter: number;
  /** Why it stopped early, if it did. */
  stopped?: string;
  /** The step of a guided build it ran, if any. */
  step?: BuildStepId;
  error?: string;
}

export interface DraftView extends Omit<DraftRecord, "draft" | "chat"> {
  draft: Draft;
  chat: ChatEntry[];
  problems: DraftProblem[];
  /** Whether the AI creator is working on it. */
  busy: boolean;
  /** A free world ID made from its title, for the Review step. */
  suggestedWorldId: string;
}

export const MAX_CHAT_ENTRIES = 100;
const WORLD_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export class DraftService {
  private readonly busy = new Set<string>();
  private readonly engine: AdventureEngine;

  constructor(engine: AdventureEngine) {
    this.engine = engine;
  }

  list(): Promise<DraftSummary[]> {
    return this.engine.listDrafts();
  }

  /** A blank draft, or a copy of a bundled adventure to change. */
  async create(options: { adventureId?: string | undefined; name?: string | undefined }): Promise<DraftView> {
    let draft = blankDraft(options.name?.trim() || undefined);
    if (options.adventureId !== undefined) {
      const adventure = findAdventure(options.adventureId);
      if (!adventure) throw new EngineError("NOT_FOUND", `Unknown adventure: ${options.adventureId}`);
      const seed = adventure.world(draft.seed.id);
      draft = parseInput(draftSchema, { seed: { ...seed, name: options.name?.trim() || seed.name }, cast: structuredClone(adventure.cast) });
    }
    return this.view(await this.engine.createDraft(randomBytes(5).toString("hex"), draft));
  }

  async get(id: string): Promise<DraftView> {
    return this.view(await this.engine.getDraft(id));
  }

  /** Replaces the draft, if it is still at the revision the editor last saw. */
  async save(id: string, draft: unknown, expectedRevision: number): Promise<DraftView> {
    this.requireIdle(id);
    const parsed = parseInput(draftSchema, draft);
    return this.view(await this.engine.updateDraft(id, expectedRevision, { draft: parsed }));
  }

  async delete(id: string): Promise<void> {
    this.requireIdle(id);
    await this.engine.deleteDraft(id);
  }

  /**
   * Creates the world and its cast from the draft. The world ID is saved in the
   * draft first, so if creating fails partway a retry with the same ID resumes:
   * the engine accepts an identical seed for an existing world.
   */
  async publish(id: string, worldId: string, expectedRevision: number): Promise<DraftView> {
    this.requireIdle(id);
    let record = await this.engine.getDraft(id);
    if (record.publishedAt !== null) {
      if (record.worldId === worldId) return this.view(record);
      throw new EngineError("REQUEST_CONFLICT", `This draft already became the world ${record.worldId}`);
    }
    if (record.revision !== expectedRevision) {
      throw new EngineError("STALE_REVISION", `Draft ${id} is at revision ${record.revision}, not ${expectedRevision}`);
    }
    if (!WORLD_ID.test(worldId)) {
      throw new EngineError("INVALID_INPUT", "A world ID is up to 64 letters, digits, hyphens, and underscores, starting with a letter or digit");
    }
    const { seed, cast } = publishable(parseInput(draftSchema, record.draft), worldId);
    const worlds = await this.engine.listWorlds();
    if (worlds.some((world) => world.id === worldId) && record.worldId !== worldId) {
      throw new EngineError("REQUEST_CONFLICT", `A world called ${worldId} already exists. Choose another ID.`);
    }
    if (record.worldId !== worldId) record = await this.engine.updateDraft(id, record.revision, { worldId });
    await this.engine.createWorld(seed);
    await this.engine.saveSetup(worldId, { cast, models: {} });
    return this.view(await this.engine.updateDraft(id, record.revision, { published: true }));
  }

  /**
   * Runs the AI creator on one message. Once the draft is claimed and at the
   * revision the director saw, `onStart` is called; earlier failures throw.
   * Each round of changes is saved as it happens, and the message and its
   * outcome are added to the draft's chat log, even when stopped.
   */
  async assist(id: string, options: {
    message: string;
    step?: BuildStepId | undefined;
    expectedRevision: number;
    chat: ChatModel;
    signal: AbortSignal;
    limits?: CreatorLimits;
    onStart(): void;
    onEvent(event: CreatorEvent): void;
  }): Promise<{ entry: ChatEntry; view: DraftView }> {
    const release = this.claim(id);
    try {
      const record = await this.engine.getDraft(id);
      if (record.publishedAt !== null) throw new EngineError("REQUEST_CONFLICT", `This draft already became the world ${record.worldId}`);
      if (record.revision !== options.expectedRevision) {
        throw new EngineError("STALE_REVISION", `Draft ${id} is at revision ${record.revision}, not ${options.expectedRevision}`);
      }
      options.onStart();
      const chat = record.chat as ChatEntry[];
      let revision = record.revision;
      const run = await runCreator({
        chat: options.chat,
        draft: parseInput(draftSchema, record.draft),
        history: chat,
        message: options.message,
        ...(options.step === undefined ? {} : { step: options.step }),
        signal: options.signal,
        ...(options.limits ? { limits: options.limits } : {}),
        onEvent: options.onEvent,
        save: async (draft) => {
          revision = (await this.engine.updateDraft(id, revision, { draft })).revision;
          return revision;
        },
      });
      const entry: ChatEntry = {
        id: randomBytes(6).toString("hex"),
        at: new Date().toISOString(),
        message: options.message,
        reply: run.reply,
        tools: run.tools,
        usage: run.usage,
        model: options.chat.model,
        revisionBefore: record.revision,
        revisionAfter: revision,
        ...(run.stopped === undefined ? {} : { stopped: run.stopped }),
        ...(run.error === undefined ? {} : { error: run.error }),
        ...(options.step === undefined ? {} : { step: options.step }),
      };
      const saved = await this.engine.updateDraft(id, revision, { chat: [...chat, entry].slice(-MAX_CHAT_ENTRIES) });
      release();
      return { entry, view: await this.view(saved) };
    } finally {
      release();
    }
  }

  /** Reserves a draft for the AI creator; it must call the returned release when done. */
  claim(id: string): () => void {
    this.requireIdle(id);
    this.busy.add(id);
    return () => this.busy.delete(id);
  }

  isBusy(id: string): boolean {
    return this.busy.has(id);
  }

  async view(record: DraftRecord): Promise<DraftView> {
    const draft = parseInput(draftSchema, record.draft);
    return {
      ...record,
      draft,
      chat: record.chat as ChatEntry[],
      problems: draftProblems(draft),
      busy: this.busy.has(record.id),
      suggestedWorldId: record.worldId ?? await this.freeWorldId(draft.seed.name),
    };
  }

  private requireIdle(id: string): void {
    if (this.busy.has(id)) throw new EngineError("DRAFT_BUSY", "The AI creator is working on this draft; wait for it or stop it");
  }

  private async freeWorldId(name: string): Promise<string> {
    const taken = new Set((await this.engine.listWorlds()).map((world) => world.id));
    const base = slugify(name);
    if (!taken.has(base)) return base;
    for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}
