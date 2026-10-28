import { z } from "zod";
import { MAX_SPEECH_LENGTH, MAX_WAIT_SECONDS } from "../model.ts";
import type { CharacterAction } from "../model.ts";

// Model-facing schemas are flat, with nullable fields instead of unions, so they
// suit constrained decoding. Conversion below enforces the per-action shape.

export const characterTurnSchema = z.strictObject({
  speech: z.string().nullable()
    .describe("Words you say aloud this turn: one to three short sentences, or null to stay silent."),
  action: z.strictObject({
    type: z.enum(["move", "transfer_item", "attempt_check", "wait"]),
    destinationId: z.string().nullable().describe("For move: an exit ID."),
    recipientId: z.string().nullable().describe("For transfer_item: who receives the item."),
    itemId: z.string().nullable().describe("For transfer_item: the item ID."),
    quantity: z.number().int().nullable().describe("For transfer_item: how many."),
    challengeId: z.string().nullable().describe("For attempt_check: the challenge ID."),
    minutes: z.number().int().nullable().describe("For wait: whole minutes to wait."),
  }).nullable()
    .describe("One action from the available actions, or null to only speak. Set fields the action does not use to null."),
});
export type CharacterTurnOutput = z.infer<typeof characterTurnSchema>;

export const narrationSchema = z.strictObject({
  narration: z.string().describe("One or two sentences describing the committed outcome."),
});
export type NarrationOutput = z.infer<typeof narrationSchema>;

/** A proposal the engine never saw because its shape was wrong; sent back as feedback. */
export class ProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalError";
  }
}

export interface TurnParts {
  speech?: string;
  action?: CharacterAction;
}

type ActionOutput = NonNullable<CharacterTurnOutput["action"]>;

function required<K extends keyof ActionOutput>(action: ActionOutput, key: K): NonNullable<ActionOutput[K]> {
  const value = action[key];
  if (value === null) throw new ProposalError(`${action.type} requires ${key}`);
  return value as NonNullable<ActionOutput[K]>;
}

function toAction(action: ActionOutput): CharacterAction {
  switch (action.type) {
    case "move":
      return { type: "move", destinationId: required(action, "destinationId") };
    case "transfer_item":
      return {
        type: "transfer_item",
        recipientId: required(action, "recipientId"),
        itemId: required(action, "itemId"),
        quantity: required(action, "quantity"),
      };
    case "attempt_check":
      return { type: "attempt_check", challengeId: required(action, "challengeId") };
    case "wait": {
      const minutes = required(action, "minutes");
      if (minutes < 1 || minutes * 60 > MAX_WAIT_SECONDS) {
        throw new ProposalError(`wait minutes must be between 1 and ${MAX_WAIT_SECONDS / 60}`);
      }
      return { type: "wait", seconds: minutes * 60 };
    }
  }
}

export function toTurnParts(output: CharacterTurnOutput): TurnParts {
  const parts: TurnParts = {};
  const speech = output.speech?.trim() ?? "";
  if (speech.length > MAX_SPEECH_LENGTH) {
    throw new ProposalError(`Speech must be at most ${MAX_SPEECH_LENGTH} characters`);
  }
  if (speech) parts.speech = speech;
  if (output.action) parts.action = toAction(output.action);
  if (!parts.speech && !parts.action) throw new ProposalError("Say something, take an action, or both");
  return parts;
}
