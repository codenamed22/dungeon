import { z } from "zod";

// Which models play a world's roles: part of a world's setup, and of a draft
// imported from a world. The browser reads drafts, so this imports only zod.

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

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
