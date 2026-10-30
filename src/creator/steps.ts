// Building a new world one step at a time, with the director's approval
// between steps: what each step makes, and the tools it may use. The browser
// shows the steps, so this module imports nothing.

export interface BuildStep {
  id: "story" | "places" | "characters" | "challenges" | "endings";
  /** A word or two for the director. */
  label: string;
  /** What the AI creator makes in this step. */
  task: string;
  /** Tools beyond the ones every step has; null for every tool. */
  tools: readonly string[] | null;
}

export type BuildStepId = BuildStep["id"];

/** Reading, the world's settings, and removing a mistake are open to every step. */
export const EVERY_STEP_TOOLS: readonly string[] = ["get_draft", "check_draft", "get_example", "set_world", "remove"];

export const BUILD_STEPS: readonly BuildStep[] = [
  {
    id: "story",
    label: "Story",
    task: "Set the title, premise, rules, pace, narrator style, and limits on open-ended actions with set_world, and make "
      + "nothing else yet. In your reply, outline the rest in a line each: the places, the main and supporting characters, "
      + "the challenges and threats, any hidden tracks, and the endings you have in mind.",
    tools: [],
  },
  {
    id: "places",
    label: "Places",
    task: "Add the places, the ways between them, and the items the story will need. Block any way that a challenge "
      + "should open later.",
    tools: ["upsert_place", "connect_places", "disconnect_places", "upsert_item"],
  },
  {
    id: "characters",
    label: "Characters",
    task: "Add the main and supporting characters, each with a persona, and what they carry. Anyone who arrives later "
      + "starts away from the scene.",
    tools: ["upsert_character", "set_persona", "upsert_item"],
  },
  {
    id: "challenges",
    label: "Challenges",
    task: "Add any hidden tracks first, and give each character who takes part a starting value below every threshold with "
      + "upsert_character. Then add the threats, then the challenges that refer to them, with the tracks each one moves, and "
      + "block or open ways as they need. Lock a challenge that a threshold should open, then list it under that threshold.",
    tools: ["upsert_track", "upsert_character", "upsert_threat", "upsert_challenge", "upsert_item", "connect_places"],
  },
  {
    id: "endings",
    label: "Endings",
    task: "Add the endings, then fix whatever still stops the world being played, and check that the pieces fit "
      + "together. Every tool is open now.",
    tools: null,
  },
];

export const BUILD_STEP_IDS = BUILD_STEPS.map((step) => step.id) as [BuildStepId, ...BuildStepId[]];

export function buildStep(id: BuildStepId): BuildStep {
  return BUILD_STEPS.find((step) => step.id === id)!;
}

/** The step after this one, or null after the last. */
export function nextBuildStep(id: BuildStepId): BuildStep | null {
  return BUILD_STEPS[BUILD_STEPS.findIndex((step) => step.id === id) + 1] ?? null;
}

/** The tools a step may use, or null for every tool. */
export function stepTools(id: BuildStepId): ReadonlySet<string> | null {
  const { tools } = buildStep(id);
  return tools === null ? null : new Set([...EVERY_STEP_TOOLS, ...tools]);
}
