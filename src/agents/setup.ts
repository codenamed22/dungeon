import { z } from "zod";
import type { AdventureEngine } from "../engine.ts";
import { EngineError, parseInput } from "../model.ts";
import type { WorldState } from "../model.ts";
import { DEFAULT_OPENROUTER_MODEL, OpenRouterProvider, openRouterSettingsFromEnv, REASONING_EFFORTS } from "./openrouter.ts";
import { castProblems, castSchema } from "./prompts.ts";
import type { Cast } from "./prompts.ts";

// How the director set up a world's agents: who has a persona, how the
// narrator sounds, and which models play each role. It is director state,
// stored beside the world, never part of the fiction.

const modelId = z.string().trim().min(1).max(200);
const effort = z.enum([...REASONING_EFFORTS, "default"]);

/** Models per role; anything left out falls back to the environment, then to the default model. */
export const modelSetupSchema = z.strictObject({
  character: modelId.optional(),
  dm: modelId.optional(),
  characterEffort: effort.optional(),
  dmEffort: effort.optional(),
});
export type ModelSetup = z.infer<typeof modelSetupSchema>;

export const setupSchema = z.strictObject({
  cast: castSchema,
  models: modelSetupSchema.default({}),
});
export type Setup = z.infer<typeof setupSchema>;

/** Personas must belong to characters of the right kind: party personas to party members, NPC personas to NPCs. */
export function validateSetup(setup: Setup, state: WorldState): void {
  const [problem] = castProblems(setup.cast, state.characters, state.id);
  if (problem) throw new EngineError("INVALID_INPUT", problem);
}

export function parseSetup(input: unknown, state: WorldState): Setup {
  const setup = parseInput(setupSchema, input);
  validateSetup(setup, state);
  return setup;
}

/** Plain personas for every character, for a world with no written cast. */
export function placeholderCast(state: WorldState): Cast {
  const party = state.characters.filter((character) => !character.npc);
  const npcs = state.characters.filter((character) => character.npc);
  return {
    narratorStyle: "Plain, concrete, present tense.",
    characters: Object.fromEntries(party.map((character) => [character.id, {
      summary: `${character.name}, one of the main characters.`,
      voice: "Natural and conversational.",
      goals: ["See this through, together"],
      riskTolerance: "balanced" as const,
    }])),
    ...(npcs.length === 0 ? {} : {
      npcs: Object.fromEntries(npcs.map((character) => [character.id, {
        summary: `${character.name}, someone they meet.`,
        voice: "Natural and conversational.",
        knowledge: [],
        wants: ["To be left in peace"],
      }])),
    }),
  };
}

/**
 * The world's saved setup. A world without one gets the cast written for its
 * adventure, if `castFor` knows it, or placeholders.
 */
export async function loadSetup(
  engine: AdventureEngine,
  worldId: string,
  state: WorldState,
  castFor: (state: WorldState) => Cast | undefined = () => undefined,
): Promise<Setup> {
  const stored = await engine.getSetup(worldId);
  if (stored === null) return { cast: castFor(state) ?? placeholderCast(state), models: {} };
  const parsed = setupSchema.safeParse(stored);
  if (!parsed.success) throw new EngineError("CORRUPT_STORAGE", `Saved setup for ${worldId} is invalid: ${parsed.error.message}`);
  return parsed.data;
}

/** The models a setup will use, after environment and default fallbacks. */
export function resolvedModels(models: ModelSetup, env: NodeJS.ProcessEnv): { character: string; dm: string } {
  const setting = (name: string) => env[name]?.trim() || undefined;
  const shared = setting("DUNGEONS_MODEL") ?? DEFAULT_OPENROUTER_MODEL;
  return {
    character: models.character ?? setting("DUNGEONS_CHARACTER_MODEL") ?? shared,
    dm: models.dm ?? setting("DUNGEONS_DM_MODEL") ?? shared,
  };
}

/** An OpenRouter provider for a setup's models, with the key and limits from the environment. */
export async function providerForSetup(models: ModelSetup, env: NodeJS.ProcessEnv): Promise<OpenRouterProvider> {
  const base = openRouterSettingsFromEnv(env);
  return OpenRouterProvider.create({
    ...base,
    models: resolvedModels(models, env),
    efforts: {
      character: models.characterEffort ?? base.efforts.character,
      dm: models.dmEffort ?? base.efforts.dm,
    },
  });
}
