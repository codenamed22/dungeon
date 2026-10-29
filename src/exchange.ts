import { randomBytes } from "node:crypto";
import { z } from "zod";
import { castForWorld } from "./adventures/index.ts";
import { loadSetup, parseSetup, placeholderCast } from "./agents/setup.ts";
import { draftSchema, slugify } from "./creator/operations.ts";
import type { AdventureEngine, DraftRecord } from "./engine.ts";
import { EngineError, parseInput } from "./model.ts";
import type { WorldState } from "./model.ts";

// Worlds as files, to keep, share, or move between databases. A design is the
// world as written: its starting seed, cast, and models, which import as a new
// draft. A save is a world's whole history with its setup and mutes, which
// imports as a world that plays on from where it was, replayed and checked
// first. Receipts, traces, leases, and the AI creator's chat stay behind.

export const WORLD_FILE_FORMAT = "dungeons-world";
export const WORLD_FILE_VERSION = 1;
export const MAX_FILE_EVENTS = 100_000;
export const WORLD_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

const header = {
  format: z.literal(WORLD_FILE_FORMAT),
  version: z.literal(WORLD_FILE_VERSION),
  exportedAt: z.string().max(40),
};

export const worldFileSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...header, kind: z.literal("design"), draft: draftSchema }),
  z.strictObject({
    ...header,
    kind: z.literal("save"),
    world: z.strictObject({ id: z.string().max(64), name: z.string().max(200) }),
    /** Stored events in order; each is checked as it is read back. */
    events: z.array(z.unknown()).min(1).max(MAX_FILE_EVENTS),
    setup: z.unknown().nullable(),
    muted: z.array(z.string().max(64)).max(100),
  }),
]);
export type WorldFile = z.infer<typeof worldFileSchema>;
export type DesignFile = Extract<WorldFile, { kind: "design" }>;
export type SaveFile = Extract<WorldFile, { kind: "save" }>;

export type ImportResult = { kind: "design"; draft: DraftRecord } | { kind: "save"; world: WorldState };

/** A world or a draft as a design file. */
export async function exportDesign(engine: AdventureEngine, source: { worldId: string } | { draftId: string }): Promise<DesignFile> {
  let draft: unknown;
  if ("draftId" in source) {
    draft = (await engine.getDraft(source.draftId)).draft;
  } else {
    const [created] = await engine.getEvents(source.worldId, 0, 1);
    if (created?.data.type !== "world_created") throw new EngineError("CORRUPT_STORAGE", `World ${source.worldId} has no creation event`);
    const state = await engine.getWorld(source.worldId);
    const { cast, models } = await loadSetup(engine, source.worldId, state, castForWorld);
    draft = { seed: created.data.seed, cast, ...(Object.keys(models).length === 0 ? {} : { models }) };
  }
  return { ...fileHeader(), kind: "design", draft: parseInput(draftSchema, draft) };
}

/** A world's whole history, with its setup and mutes, as a save file. */
export async function exportSave(engine: AdventureEngine, worldId: string): Promise<SaveFile> {
  const state = await engine.getWorld(worldId);
  return {
    ...fileHeader(),
    kind: "save",
    world: { id: state.id, name: state.name },
    events: await engine.exportEvents(worldId),
    setup: await loadSetup(engine, worldId, state, castForWorld),
    muted: await engine.getMuted(worldId),
  };
}

/** The name to save a file under: the world's ID for a save, its title for a design. */
export function worldFileName(file: WorldFile): string {
  return file.kind === "save" ? `${file.world.id}.save.json` : `${slugify(file.draft.seed.name)}.design.json`;
}

/** Checks that something read from a file is a world file this version can import. */
export function readWorldFile(input: unknown): WorldFile {
  const { format, version } = (typeof input === "object" && input !== null ? input : {}) as { format?: unknown; version?: unknown };
  if (format !== WORLD_FILE_FORMAT) throw new EngineError("INVALID_INPUT", "This isn't a Dungeons world file.");
  if (typeof version === "number" && version > WORLD_FILE_VERSION) {
    throw new EngineError("INVALID_INPUT", `This file is from a newer version of Dungeons (file version ${version}); update to import it.`);
  }
  return parseInput(worldFileSchema, input);
}

/**
 * Imports a world file: a design becomes a new draft; a save becomes a new
 * world, under `worldId` or else the file's own ID, made unique if it is
 * taken.
 */
export async function importWorldFile(engine: AdventureEngine, input: unknown, options: { worldId?: string | undefined } = {}): Promise<ImportResult> {
  const file = readWorldFile(input);
  if (file.kind === "design") return { kind: "design", draft: await engine.createDraft(randomBytes(5).toString("hex"), file.draft) };
  const worldId = options.worldId ?? await freeWorldId(engine, WORLD_ID.test(file.world.id) ? file.world.id : slugify(file.world.name));
  if (!WORLD_ID.test(worldId)) {
    throw new EngineError("INVALID_INPUT", "A world ID is up to 64 letters, digits, hyphens, and underscores, starting with a letter or digit");
  }
  const world = await engine.importWorld(worldId, file.events, (state) => {
    const characters = new Set(state.characters.map((character) => character.id));
    return {
      setup: file.setup === null ? { cast: placeholderCast(state), models: {} } : parseSetup(file.setup, state),
      muted: file.muted.filter((id) => characters.has(id)),
    };
  });
  return { kind: "save", world };
}

/** `base`, or the first of `base-2`, `base-3`, … that no world has taken. */
export async function freeWorldId(engine: AdventureEngine, base: string): Promise<string> {
  const taken = new Set((await engine.listWorlds()).map((world) => world.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

function fileHeader() {
  return { format: WORLD_FILE_FORMAT, version: WORLD_FILE_VERSION, exportedAt: new Date().toISOString() } as const;
}
