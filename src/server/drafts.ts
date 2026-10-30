import { randomBytes } from "node:crypto";
import { findAdventure } from "../adventures/index.ts";
import { runCreator } from "../creator/assistant.ts";
import type { ChatModel, CreatorEvent, CreatorLimits, CreatorUsage, ToolLine } from "../creator/assistant.ts";
import { blankDraft, draftProblems, draftSchema, publishable, slugify } from "../creator/operations.ts";
import type { Draft, DraftProblem } from "../creator/operations.ts";
import {
  MAX_SAMPLE_CHARACTERS, MAX_SAMPLE_NAME_LENGTH, MAX_SAMPLES, normalizeSample, SAMPLE_CONTEXT_RESERVE, sampleInfo, sampleTextProblem,
  sampleTokens,
} from "../creator/samples.ts";
import type { DraftSample, SampleInfo } from "../creator/samples.ts";
import type { BuildStepId } from "../creator/steps.ts";
import type { AdventureEngine, DraftRecord, DraftSummary } from "../engine.ts";
import { freeWorldId, WORLD_ID } from "../exchange.ts";
import { EngineError, parseInput } from "../model.ts";

// Drafts in the world creator: their storage, problems, and publication as a
// playable world, and the sample chats the AI creator may read for it. The AI
// creator claims a draft while it works on it; nothing else may change the
// draft or its samples until it lets go.

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

export interface DraftView extends Omit<DraftRecord, "draft" | "chat" | "samples"> {
  draft: Draft;
  chat: ChatEntry[];
  /** The sample chats, without their text, which only the AI creator reads. */
  samples: SampleInfo[];
  problems: DraftProblem[];
  /** Whether the AI creator is working on it. */
  busy: boolean;
  /** A free world ID made from its title, for the Review step. */
  suggestedWorldId: string;
}

export const MAX_CHAT_ENTRIES = 100;

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

  /** Deletes one chat turn and all newer turns, leaving the draft unchanged. */
  async deleteFrom(id: string, entryId: string): Promise<DraftView> {
    const release = this.claim(id);
    try {
      const record = await this.engine.getDraft(id);
      if (record.publishedAt !== null) throw new EngineError("REQUEST_CONFLICT", `This draft already became the world ${record.worldId}`);
      const chat = record.chat as ChatEntry[];
      const index = chat.findIndex((entry) => entry.id === entryId);
      if (index < 0) throw new EngineError("NOT_FOUND", `No creator message ${entryId}`);
      const saved = await this.engine.updateDraft(id, record.revision, { chat: chat.slice(0, index) });
      return this.view(saved);
    } finally {
      release();
    }
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

  /** Adds a chat file for the AI creator to draw on, within the limits on how many and how long. */
  async addSample(id: string, input: { name: string; text: string }): Promise<DraftView> {
    this.requireIdle(id);
    const name = input.name.trim().slice(0, MAX_SAMPLE_NAME_LENGTH) || "chats.txt";
    const text = normalizeSample(input.text);
    const problem = sampleTextProblem(text);
    if (problem) throw new EngineError("INVALID_INPUT", problem);
    const sample: DraftSample = { id: randomBytes(4).toString("hex"), name, text, characters: text.length, addedAt: new Date().toISOString() };
    const added = await this.engine.addDraftSample(id, sample, { maxCount: MAX_SAMPLES, maxCharacters: MAX_SAMPLE_CHARACTERS });
    if (added) return this.view(added);
    const samples = (await this.engine.getDraft(id)).samples as SampleInfo[];
    if (samples.length >= MAX_SAMPLES) throw new EngineError("INVALID_INPUT", `A draft can have ${MAX_SAMPLES} sample files; remove one first.`);
    const left = MAX_SAMPLE_CHARACTERS - samples.reduce((sum, entry) => sum + entry.characters, 0);
    throw new EngineError("INVALID_INPUT", `"${name}" has ${count(text.length)} characters, and the samples can have `
      + `${count(MAX_SAMPLE_CHARACTERS)} in all${samples.length > 0 ? ` (${count(left)} left)` : ""}. Trim it to the conversations that show these people best.`);
  }

  async removeSample(id: string, sampleId: string): Promise<DraftView> {
    this.requireIdle(id);
    return this.view(await this.engine.removeDraftSample(id, sampleId));
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
    const draft = parseInput(draftSchema, record.draft);
    const { seed, cast } = publishable(draft, worldId);
    const worlds = await this.engine.listWorlds();
    if (worlds.some((world) => world.id === worldId) && record.worldId !== worldId) {
      throw new EngineError("REQUEST_CONFLICT", `A world called ${worldId} already exists. Choose another ID.`);
    }
    if (record.worldId !== worldId) record = await this.engine.updateDraft(id, record.revision, { worldId });
    await this.engine.createWorld(seed);
    await this.engine.saveSetup(worldId, { cast, models: draft.models ?? {} });
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
      const samples = record.samples.length === 0 ? [] : await this.engine.getDraftSamples(id) as DraftSample[];
      const context = options.chat.contextLength;
      const needed = sampleTokens(samples.reduce((sum, sample) => sum + sample.characters, 0));
      if (samples.length > 0 && context && needed + SAMPLE_CONTEXT_RESERVE > context) {
        throw new EngineError("INVALID_INPUT", `The sample chats come to about ${count(needed)} tokens, and with the rest of the conversation `
          + `that's more than ${options.chat.model} can take (${count(context)} tokens). Choose a model with a larger context, or remove a sample.`);
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
        samples,
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
      samples: (record.samples as SampleInfo[]).map(sampleInfo),
      problems: draftProblems(draft),
      busy: this.busy.has(record.id),
      suggestedWorldId: record.worldId ?? await freeWorldId(this.engine, slugify(draft.seed.name)),
    };
  }

  private requireIdle(id: string): void {
    if (this.busy.has(id)) throw new EngineError("DRAFT_BUSY", "The AI creator is working on this draft; wait for it or stop it");
  }

}

const count = (n: number) => n.toLocaleString("en-US");
