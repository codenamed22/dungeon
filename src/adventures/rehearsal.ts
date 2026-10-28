import type { ScriptStep } from "../agents/provider.ts";

// A scripted opening for the starter adventure, played with every die showing 15.
// It covers speaking to an NPC who answers, a rumor noted as hearsay, a
// commitment, travel, speech-only turns, a proposal the engine rejects and the
// agent revises, an open-ended attempt the DM rules is an existing challenge, a
// check that unlocks a route, and narration after each action.

export const REHEARSAL_ROLL = 15;
export const REHEARSAL_TURNS = 8;

const noAction = null;

function action(fields: Record<string, string | number>) {
  return {
    type: fields.type,
    destinationId: null,
    recipientId: null,
    itemId: null,
    quantity: null,
    challengeId: null,
    intent: null,
    minutes: null,
    ...fields,
  };
}

export function rehearsalScript(): ScriptStep[] {
  return [
    {
      role: "character",
      output: { speech: "You there. Is there a way into that city?", to: "tamsin", action: noAction },
    },
    {
      role: "dm",
      output: {
        speech: "Through the aqueduct mouth, if your big friend can shift rusted bars. Few come back out of that channel, mind.",
        to: "mira",
        move: null,
      },
    },
    // Mira notes Tamsin's warning, event #3, which stays hearsay.
    {
      role: "character",
      output: {
        speech: "Daylight's burning. Bram, bring that crowbar.", to: "bram", action: action({ type: "move", destinationId: "mouth" }),
        note: { about: "channel", attribute: "danger", value: "Few who go in come back out", evidence: [3], confidence: "low" },
      },
    },
    { role: "dm", output: { narration: "Mira picks her way down the scree to the half-buried arch, where Elowen waits by the bars." } },
    {
      role: "character",
      output: {
        speech: "Slow feet, sure feet. Right behind you.", to: null, action: action({ type: "move", destinationId: "mouth" }),
        goal: { status: "adopted", kind: "commitment", text: "Get those bars open for Mira", goalId: null },
      },
    },
    { role: "dm", output: { narration: "Bram follows, the crowbar balanced on one shoulder." } },
    {
      role: "character",
      output: { speech: "These bars are older than the walls. Lever them low, where the rust is worst.", to: null, action: noAction },
    },
    // Mira tries the bars without the crowbar; the engine refuses and she revises.
    { role: "character", output: { speech: null, to: null, action: action({ type: "attempt_check", challengeId: "pry-bars" }) } },
    { role: "character", output: { speech: "Fine. Your bar, Bram. Your bars.", to: "bram", action: noAction } },
    // Bram describes what he tries; the DM rules it is the bars challenge, before the roll.
    {
      role: "character",
      output: { speech: "Stand clear.", to: null, action: action({ type: "attempt", intent: "heave the bars apart with the crowbar" }) },
    },
    {
      role: "dm",
      output: {
        decision: "existing", challengeId: "pry-bars", name: null, ability: null, difficulty: null,
        failureDamage: null, minutes: null, reason: "Levering the bars apart is exactly what the crowbar is for.",
      },
    },
    { role: "dm", output: { narration: "Rust flakes away as the bars bend outward, and the dark channel lies open." } },
    {
      role: "character",
      output: { speech: "Lantern first. Mind your heads.", to: null, action: action({ type: "move", destinationId: "channel" }) },
    },
    { role: "dm", output: { narration: "Elowen ducks under the arch, lantern light sliding along the stained walls." } },
  ];
}
