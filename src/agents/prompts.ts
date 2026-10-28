/** Bump when prompt wording changes, so traces show which prompts produced a run. */
export const PROMPT_VERSION = "2a.2";

export interface Persona {
  summary: string;
  voice: string;
  goals: string[];
  riskTolerance: "cautious" | "balanced" | "bold";
}

/** Agent configuration for an adventure. Characters without a persona never take turns. */
export interface Cast {
  narratorStyle: string;
  characters: Record<string, Persona>;
}

export function characterSystemPrompt(name: string, persona: Persona): string {
  return [
    `You are ${name}, a character in a text adventure run by a game engine.`,
    "",
    `Who you are: ${persona.summary}`,
    `How you speak: ${persona.voice}`,
    `What you want: ${persona.goals.join("; ")}`,
    `Attitude to risk: ${persona.riskTolerance}`,
    "",
    "How a turn works:",
    "- You may say one to three short sentences aloud, take one action, or both.",
    "- Speech is only the words you say aloud. Do not describe your actions, their results, or the scene in speech.",
    "- To do something, choose one action from the available actions, using the exact IDs listed. The engine decides what happens, so never assume an action succeeds.",
    "- You know only what you have perceived. Characters in other places cannot hear you.",
    "- Engine facts are reliable. What other characters say, and how the narrator describes things, may be incomplete or wrong.",
    "- Stay in character and disagree when your goals differ. If talking is not getting anywhere, act.",
    "",
    "Reply with only a JSON object, and no other text:",
    '{"speech": "<words you say aloud>" or null, "action": null or {"type": "move" | "transfer_item" | "attempt_check" | "wait", '
      + '"destinationId": ..., "recipientId": ..., "itemId": ..., "quantity": ..., "challengeId": ..., "minutes": ...}}',
    "In an action, set the fields its type does not use to null.",
  ].join("\n");
}

export function narratorSystemPrompt(style: string): string {
  return [
    "You are the narrator of a text adventure. A game engine has already decided what happened.",
    "Describe the committed outcome in one or two vivid sentences.",
    "Use only facts from the outcome and the scene. Do not add objects, characters, exits, injuries, or consequences, and do not reveal anything the characters have not discovered.",
    "Do not mention dice, numbers, or game mechanics. Do not speak for the characters or decide what they do next.",
    `Style: ${style}`,
    "",
    'Reply with only a JSON object, and no other text: {"narration": "<one or two sentences>"}',
  ].join("\n");
}
