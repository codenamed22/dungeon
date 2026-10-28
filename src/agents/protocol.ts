import { z } from "zod";
import {
  abilitySchema, confidenceSchema, difficultyBandSchema, goalKindSchema, goalStatusSchema, MAX_EVIDENCE, MAX_GOAL_LENGTH,
  MAX_INTENT_LENGTH, MAX_NOTE_LENGTH, MAX_REASON_LENGTH, MAX_SPEECH_LENGTH, MAX_WAIT_SECONDS,
} from "../model.ts";
import type { CharacterAction, GoalInput, JudgmentInput, NoteInput, RulingInput, RulingLimits, WorldRules } from "../model.ts";

// Model-facing schemas are flat, with nullable fields instead of unions, so they
// suit constrained decoding. Conversion below enforces the per-action shape.

export const characterTurnSchema = z.strictObject({
  speech: z.string().nullable()
    .describe("Words you say aloud this turn: one to three short sentences, or null to stay silent."),
  to: z.string().nullable()
    .describe("The ID of the one person present you are speaking to, or null to speak to everyone present."),
  action: z.strictObject({
    type: z.enum(["move", "transfer_item", "attempt_check", "attempt", "wait"]),
    destinationId: z.string().nullable().describe("For move: an exit ID."),
    recipientId: z.string().nullable().describe("For transfer_item: who receives the item."),
    itemId: z.string().nullable().describe("For transfer_item: the item ID."),
    quantity: z.number().int().nullable().describe("For transfer_item: how many."),
    challengeId: z.string().nullable().describe("For attempt_check: the challenge ID."),
    // Defaulted so older outputs still parse; see note and goal below.
    approach: z.string().nullable().default(null)
      .describe("For attempt_check: how you go about it, in a short phrase, or null."),
    intent: z.string().nullable().describe("For attempt: what you try, in a short phrase."),
    minutes: z.number().int().nullable().describe("For wait: whole minutes to wait."),
  }).nullable()
    .describe("One action from the available actions, or null to only speak. Set fields the action does not use to null."),
  // Defaults keep these required in the JSON schema, for strict decoding, while older outputs still parse.
  note: z.strictObject({
    about: z.string().describe("The ID of the person, place, item, or challenge the belief is about."),
    attribute: z.string().describe("What about it, in a word or two, such as location, holder, or status."),
    value: z.string().describe("What you believe, in a short phrase."),
    evidence: z.array(z.number().int()).describe("The #numbers of events you perceived that support it, or [] for a guess."),
    confidence: confidenceSchema,
  }).nullable().default(null)
    .describe("A belief worth remembering, or null."),
  goal: z.strictObject({
    status: goalStatusSchema.describe("adopted for a new goal; fulfilled or abandoned to settle one of yours."),
    kind: goalKindSchema.nullable().describe("For adopted: goal for your own aim, commitment for a promise to someone."),
    text: z.string().nullable().describe("For adopted: the goal or promise, in one short sentence."),
    goalId: z.string().nullable().describe("For fulfilled or abandoned: the ID of one of your open goals."),
  }).nullable().default(null)
    .describe("A goal to adopt or settle, or null."),
});
/** A turn as the model may send it; parsed output, with note and goal defaulted, also fits. */
export type CharacterTurnOutput = z.input<typeof characterTurnSchema>;

export const npcTurnSchema = z.strictObject({
  speech: z.string().describe("What you say aloud: one to three short sentences."),
  to: z.string().nullable().describe("The ID of the one person you answer or speak to, or null to speak to everyone present."),
  move: z.string().nullable().describe("An exit ID to walk to after speaking, or null to stay."),
});
export type NpcTurnOutput = z.infer<typeof npcTurnSchema>;

export const rulingSchema = z.strictObject({
  decision: z.enum(["existing", "new", "automatic", "impossible"]),
  challengeId: z.string().nullable().describe("For existing: the ID of the challenge the attempt really is."),
  name: z.string().nullable().describe("For new: a short name for the check, such as \"Climb the wall\"."),
  ability: abilitySchema.nullable().describe("For new: the ability the check tests."),
  difficulty: difficultyBandSchema.nullable().describe("For new: how hard the check is."),
  failureDamage: z.number().int().nullable().describe("For new: damage a failure causes, or 0 if failing is harmless."),
  minutes: z.number().int().nullable().describe("For new and automatic: whole minutes the attempt takes."),
  reason: z.string().describe("One plain sentence, shown to the players, explaining the ruling. No numbers."),
});
export type RulingOutput = z.infer<typeof rulingSchema>;

/** A ruling in a judgment world, which also decides whether the attempt works. */
export const judgedRulingSchema = rulingSchema.extend({
  ability: abilitySchema.nullable().describe("For new: the stat the attempt leans on, or null if this world has no stats."),
  failureDamage: z.number().int().nullable().describe("For new: what failing costs in health, or 0; null if this world has no health."),
  success: z.boolean().nullable().describe("For existing and new: whether the attempt works."),
  verdict: z.string().nullable().describe("For existing and new: one plain sentence, shown to everyone present, saying why it worked or did not."),
});
export type JudgedRulingOutput = z.infer<typeof judgedRulingSchema>;

/** The referee's judgment on an attempt at a listed challenge, in a judgment world. */
export const judgmentSchema = z.strictObject({
  success: z.boolean().describe("Whether the attempt works."),
  reason: z.string().describe("One plain sentence, shown to everyone present, saying what happened. No numbers, and nothing hidden."),
});
export type JudgmentOutput = z.infer<typeof judgmentSchema>;

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
  addresseeId?: string;
  action?: CharacterAction;
  note?: NoteInput;
  goal?: GoalInput;
}

export interface NpcParts {
  speech: string;
  addresseeId?: string;
  destinationId?: string;
}

/**
 * The referee's decision: a ruling for the engine, or a reason the attempt
 * cannot work. In a judgment world a ruled check carries its judgment.
 */
export type Ruling = { kind: "ruling"; ruling: RulingInput; judgment?: JudgmentInput } | { kind: "impossible"; reason: string };

type ActionOutput = NonNullable<CharacterTurnOutput["action"]>;

function required<T extends object, K extends keyof T & string>(value: T, key: K, what: string): NonNullable<T[K]> {
  const field = value[key];
  if (field === null || field === undefined) throw new ProposalError(`${what} requires ${key}`);
  return field as NonNullable<T[K]>;
}

/** Whole minutes as seconds, within the engine's limit for one task. */
function minutesToSeconds(minutes: number, what: string): number {
  if (minutes < 1 || minutes * 60 > MAX_WAIT_SECONDS) {
    throw new ProposalError(`${what} minutes must be between 1 and ${MAX_WAIT_SECONDS / 60}`);
  }
  return minutes * 60;
}

function boundedText(value: string, max: number, what: string): string {
  const text = value.trim();
  if (!text) throw new ProposalError(`${what} must not be empty`);
  if (text.length > max) throw new ProposalError(`${what} must be at most ${max} characters`);
  return text;
}

function toAction(action: ActionOutput): CharacterAction {
  switch (action.type) {
    case "move":
      return { type: "move", destinationId: required(action, "destinationId", "move") };
    case "transfer_item":
      return {
        type: "transfer_item",
        recipientId: required(action, "recipientId", "transfer_item"),
        itemId: required(action, "itemId", "transfer_item"),
        quantity: required(action, "quantity", "transfer_item"),
      };
    case "attempt_check": {
      const approach = action.approach?.trim();
      return {
        type: "attempt_check",
        challengeId: required(action, "challengeId", "attempt_check"),
        ...(approach ? { approach: boundedText(approach, MAX_INTENT_LENGTH, "approach") } : {}),
      };
    }
    case "attempt":
      return { type: "attempt", intent: boundedText(required(action, "intent", "attempt"), MAX_INTENT_LENGTH, "intent") };
    case "wait":
      return { type: "wait", seconds: minutesToSeconds(required(action, "minutes", "wait"), "wait") };
  }
}

/** Speech, trimmed and length-checked; empty speech is none. */
function spoken(value: string | null): string | undefined {
  const speech = value?.trim() ?? "";
  if (speech.length > MAX_SPEECH_LENGTH) {
    throw new ProposalError(`Speech must be at most ${MAX_SPEECH_LENGTH} characters`);
  }
  return speech || undefined;
}

/** An addressee only counts when there is speech to address. */
function addressee(to: string | null, speech: string | undefined): { addresseeId?: string } {
  const id = to?.trim();
  return speech && id ? { addresseeId: id } : {};
}

function toNote(note: NonNullable<CharacterTurnOutput["note"]>): NoteInput {
  if (note.evidence.length > MAX_EVIDENCE) throw new ProposalError(`A note may cite at most ${MAX_EVIDENCE} events`);
  if (note.evidence.some((sequence) => sequence < 1)) throw new ProposalError("Evidence must be #numbers of events you perceived");
  return {
    about: boundedText(note.about, 100, "note about"),
    attribute: boundedText(note.attribute, 60, "note attribute"),
    value: boundedText(note.value, MAX_NOTE_LENGTH, "note value"),
    evidence: note.evidence,
    confidence: note.confidence,
  };
}

function toGoal(goal: NonNullable<CharacterTurnOutput["goal"]>): GoalInput {
  if (goal.status === "adopted") {
    return { status: "adopted", kind: required(goal, "kind", "adopting a goal"), text: boundedText(required(goal, "text", "adopting a goal"), MAX_GOAL_LENGTH, "goal text") };
  }
  return { status: goal.status, goalId: boundedText(required(goal, "goalId", `a ${goal.status} goal`), 100, "goalId") };
}

export function toTurnParts(output: CharacterTurnOutput): TurnParts {
  const speech = spoken(output.speech);
  const parts: TurnParts = { ...(speech ? { speech } : {}), ...addressee(output.to, speech) };
  if (output.action) parts.action = toAction(output.action);
  if (!parts.speech && !parts.action) throw new ProposalError("Say something, take an action, or both");
  if (output.note) parts.note = toNote(output.note);
  if (output.goal) parts.goal = toGoal(output.goal);
  return parts;
}

export function toNpcParts(output: NpcTurnOutput): NpcParts {
  const speech = spoken(output.speech);
  if (!speech) throw new ProposalError("Say something: it is your turn to speak");
  const destinationId = output.move?.trim();
  return { speech, ...addressee(output.to, speech), ...(destinationId ? { destinationId } : {}) };
}

export function toRuling(output: RulingOutput): Ruling {
  const reason = boundedText(output.reason, MAX_REASON_LENGTH, "reason");
  switch (output.decision) {
    case "impossible":
      return { kind: "impossible", reason };
    case "existing":
      return { kind: "ruling", ruling: { decision: "existing", challengeId: required(output, "challengeId", "existing"), reason } };
    case "automatic":
      return {
        kind: "ruling",
        ruling: { decision: "automatic", seconds: minutesToSeconds(required(output, "minutes", "automatic"), "automatic"), reason },
      };
    case "new": {
      const failureDamage = required(output, "failureDamage", "new");
      if (failureDamage < 0) throw new ProposalError("failureDamage must not be negative");
      return {
        kind: "ruling",
        ruling: {
          decision: "new",
          name: boundedText(required(output, "name", "new"), 100, "name"),
          ability: required(output, "ability", "new"),
          difficulty: required(output, "difficulty", "new"),
          failureDamage,
          seconds: minutesToSeconds(required(output, "minutes", "new"), "new"),
          reason,
        },
      };
    }
  }
}

export function toJudgment(output: JudgmentOutput): JudgmentInput {
  return { success: output.success, reason: boundedText(output.reason, MAX_REASON_LENGTH, "reason") };
}

/**
 * A judgment world's ruling. A new check leans on no stat when the world has
 * none, and costs nothing when it has no health, whatever the referee said.
 */
export function toJudgedRuling(output: JudgedRulingOutput, rules: WorldRules, limits: RulingLimits | undefined): Ruling {
  const { success, verdict, ...rest } = output;
  const ruling = toRuling({
    ...rest,
    ...(rest.decision === "new" && rules.stats === null ? { ability: limits?.abilities[0] ?? "wisdom" } : {}),
    ...(rest.decision === "new" && rules.health === null ? { failureDamage: 0 } : {}),
  });
  if (ruling.kind === "impossible" || ruling.ruling.decision === "automatic") return ruling;
  if (success === null) throw new ProposalError(`${ruling.ruling.decision} requires success`);
  return { ...ruling, judgment: { success, reason: boundedText(required(output, "verdict", ruling.ruling.decision), MAX_REASON_LENGTH, "verdict") } };
}
