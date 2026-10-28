import type { ScriptStep } from "../agents/provider.ts";

// A scripted opening for the starter adventure, played with every die showing 15.
// It covers travel, speech-only turns, a proposal the engine rejects and the agent
// revises, a check that unlocks a route, and narration after each action.

export const REHEARSAL_ROLL = 15;
export const REHEARSAL_TURNS = 6;

const noAction = null;

function action(fields: Record<string, string | number>) {
  return {
    type: fields.type,
    destinationId: null,
    recipientId: null,
    itemId: null,
    quantity: null,
    challengeId: null,
    minutes: null,
    ...fields,
  };
}

export function rehearsalScript(): ScriptStep[] {
  return [
    {
      role: "character",
      output: { speech: "Daylight's burning. Bram, bring that crowbar.", action: action({ type: "move", destinationId: "mouth" }) },
    },
    { role: "dm", output: { narration: "Mira picks her way down the scree to the half-buried arch, where Elowen waits by the bars." } },
    {
      role: "character",
      output: { speech: "Slow feet, sure feet. Right behind you.", action: action({ type: "move", destinationId: "mouth" }) },
    },
    { role: "dm", output: { narration: "Bram follows, the crowbar balanced on one shoulder." } },
    {
      role: "character",
      output: { speech: "These bars are older than the walls. Lever them low, where the rust is worst.", action: noAction },
    },
    // Mira tries the bars without the crowbar; the engine refuses and she revises.
    { role: "character", output: { speech: null, action: action({ type: "attempt_check", challengeId: "pry-bars" }) } },
    { role: "character", output: { speech: "Fine. Your bar, Bram. Your bars.", action: noAction } },
    {
      role: "character",
      output: { speech: "Stand clear.", action: action({ type: "attempt_check", challengeId: "pry-bars" }) },
    },
    { role: "dm", output: { narration: "Rust flakes away as the bars bend outward, and the dark channel lies open." } },
    {
      role: "character",
      output: { speech: "Lantern first. Mind your heads.", action: action({ type: "move", destinationId: "channel" }) },
    },
    { role: "dm", output: { narration: "Elowen ducks under the arch, lantern light sliding along the stained walls." } },
  ];
}
