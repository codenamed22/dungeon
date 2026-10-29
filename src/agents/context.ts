import { attributeKey } from "../memory.ts";
import type { BeliefTopic } from "../memory.ts";
import { difficultyBandSchema, rulesOf } from "../model.ts";
import type { Ability, AdventureEvent, Character, WorldRules, WorldState } from "../model.ts";
import { difficultyBand, perceive } from "../perception.ts";
import type { AvailableActions, Perception } from "../perception.ts";
import { inScene } from "../rules.ts";
import type { Direction } from "./schedule.ts";

/** What an agent remembers beyond its recent events, rendered as prompt lines. */
export interface MemoryView {
  /** Older events recalled as relevant now, oldest first. */
  recalled: string[];
  beliefs: string[];
  goals: string[];
}

export const NO_MEMORY: MemoryView = { recalled: [], beliefs: [], goals: [] };

export const NO_DIRECTION: Direction = { stalled: 0, nudge: false, requireAction: false, steering: [], conversation: false };

/** Why an NPC is speaking: it was spoken to, the director cued it, or its own agenda came due. */
export type NpcTurnReason = "addressed" | "cued" | "agenda";

export function formatClock(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

function nameIn(entities: { id: string; name: string }[], id: string): string {
  return entities.find((entity) => entity.id === id)?.name ?? id;
}

/** The name of any person, place, item, or challenge, or null if the ID names none. */
export function entityName(state: WorldState, id: string): string | null {
  const entities = [...state.characters, ...state.locations, ...state.items, ...state.challenges];
  return entities.find((entity) => entity.id === id)?.name ?? null;
}

function signed(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

/** Health lost, in the world's own words: "take 2 damage" with hit points, "lose 2 Composure" otherwise. */
function harm(rules: WorldRules, amount: number, verbs: [take: string, lose: string]): string {
  return !rules.health || rules.health === "HP" ? `${verbs[0]} ${amount} damage` : `${verbs[1]} ${amount} ${rules.health}`;
}

/** The world's name for an ability, or its key when the world has no stats. */
function statName(rules: WorldRules, ability: Ability): string {
  return rules.stats?.[ability] ?? ability;
}

/** A character's health and stats, as the world names them; empty when it tracks neither. */
function statusLine(rules: WorldRules, hp: number, maxHp: number, modifiers: Character["modifiers"], condition?: string): string {
  const parts: string[] = [];
  if (rules.health) parts.push(`${rules.health} ${hp}/${maxHp}${condition ? ` (${condition})` : ""}.`);
  if (rules.stats) {
    const stats = rules.stats;
    parts.push(`${(["strength", "dexterity", "wisdom"] as const).map((ability) => `${stats[ability]} ${signed(modifiers[ability])}`).join(", ")}.`);
  }
  return parts.join(" ");
}

/**
 * One line describing an event. With a viewer, the viewer is "you" and dice
 * numbers stay hidden; the admin view (no viewer) shows rolls and difficulty.
 */
export function describeEvent(event: AdventureEvent, state: WorldState, viewerId: string | null): string {
  const data = event.data;
  const subject = (id: string) => (id === viewerId ? "You" : nameIn(state.characters, id));
  const object = (id: string) => (id === viewerId ? "you" : nameIn(state.characters, id));
  const place = (id: string) => nameIn(state.locations, id);
  const item = (id: string) => nameIn(state.items, id);
  const threat = (id: string) => nameIn(state.threats ?? [], id);
  const rules = rulesOf(state);
  const stamp = `[${formatClock(event.elapsedSeconds)}]`;
  switch (data.type) {
    case "world_created":
      return `${stamp} The story "${data.seed.name}" began.`;
    case "utterance": {
      const to = data.addresseeId === undefined ? "" : ` to ${object(data.addresseeId)}`;
      return `${stamp} ${subject(data.actorId)} said${to}: "${data.text}"`;
    }
    case "character_moved":
      return `${stamp} ${subject(data.actorId)} went from ${place(data.fromId)} to ${place(data.destinationId)} (${formatDuration(data.seconds)}).`;
    case "item_transferred":
      return `${stamp} ${subject(data.actorId)} gave ${object(data.recipientId)} ${item(data.itemId)} ×${data.quantity}.`;
    case "check_resolved": {
      const challenge = nameIn(state.challenges, data.challengeId);
      const how = data.approach === undefined ? "" : ` (${data.approach})`;
      const parts = [
        `${stamp} ${subject(data.actorId)} attempted "${challenge}"${how} and ${data.success ? "succeeded" : "failed"}`
        + (data.damage > 0 ? `, ${harm(rules, data.damage, ["taking", "losing"])}.` : "."),
      ];
      // A judgment's reason is for everyone present; dice stay hidden from characters.
      if (data.reason !== undefined) parts.push(`The referee: ${data.reason}`);
      else if (viewerId === null && data.roll !== undefined) {
        parts.push(`(Rolled ${data.roll} ${signed(data.modifier ?? 0)} against ${data.difficulty}.)`);
      }
      for (const route of data.effects.unlockedRoutes) {
        parts.push(`The way from ${place(route.fromId)} to ${place(route.destinationId)} is now open.`);
      }
      for (const grant of data.effects.grantedItems) {
        parts.push(`${subject(data.actorId)} found ${item(grant.itemId)} ×${grant.quantity}.`);
      }
      for (const route of data.effects.lockedRoutes ?? []) {
        parts.push(`The way from ${place(route.fromId)} to ${place(route.destinationId)} is now blocked.`);
      }
      return parts.join(" ");
    }
    case "time_advanced":
      return `${stamp} ${subject(data.actorId)} waited ${formatDuration(data.seconds)}${data.interruptedBy ? " before being interrupted" : ""}.`;
    case "travel_halted":
      return `${stamp} ${subject(data.actorId)} set out from ${place(data.fromId)} for ${place(data.destinationId)}, `
        + `but stopped after ${formatDuration(data.seconds)}.`;
    case "threat_triggered": {
      const parts = [`${stamp} ${viewerId === null ? `Threat "${threat(data.threatId)}": ` : ""}${data.text}`];
      for (const { characterId, amount } of data.damage) {
        parts.push(`${characterId === viewerId ? `You ${harm(rules, amount, ["take", "lose"])}` : `${nameIn(state.characters, characterId)} ${harm(rules, amount, ["takes", "loses"])}`}.`);
      }
      for (const route of data.lockedRoutes) {
        parts.push(`The way from ${place(route.fromId)} to ${place(route.destinationId)} is now blocked.`);
      }
      for (const route of data.unlockedRoutes) {
        parts.push(`The way from ${place(route.fromId)} to ${place(route.destinationId)} is now open.`);
      }
      return parts.join(" ");
    }
    case "threat_armed":
      return `${stamp} (hidden) "${nameIn(state.challenges, data.challengeId)}" set threat "${threat(data.threatId)}" in motion, due at ${formatClock(data.at)}.`;
    case "threat_disarmed":
      return `${stamp} (hidden) "${nameIn(state.challenges, data.challengeId)}" stopped threat "${threat(data.threatId)}".`;
    case "story_ended": {
      const ending = state.endings?.find((entry) => entry.id === data.endingId);
      return `${stamp} The story ended: ${ending ? `${ending.name}. ${ending.text}` : data.endingId}`;
    }
    case "introduced": {
      const parts = [`${stamp} ${viewerId === null ? "Introduced by the director: " : ""}${data.text}`];
      for (const route of data.lockedRoutes) {
        parts.push(`The way from ${place(route.fromId)} to ${place(route.destinationId)} is now blocked.`);
      }
      for (const route of data.unlockedRoutes) {
        parts.push(`The way from ${place(route.fromId)} to ${place(route.destinationId)} is now open.`);
      }
      return parts.join(" ");
    }
    case "character_entered":
    case "character_exited": {
      const entered = data.type === "character_entered";
      const who = subject(data.characterId);
      const by = viewerId === null && event.source === "director" ? (entered ? "Brought in by the director: " : "Sent away by the director: ") : "";
      if (data.text === undefined) {
        return `${stamp} ${by}${who} ${entered ? `arrived at ${place(data.locationId)}` : "left the scene"}.`;
      }
      const now = who === "You" ? (entered ? "You are now at" : "You have left the scene") : (entered ? `${who} is now at` : `${who} has left the scene`);
      return `${stamp} ${by}${data.text} ${now}${entered ? ` ${place(data.locationId)}` : ""}.`;
    }
    case "retraction":
      // Only a retcon with a correction reaches a character; edits and plain deletions reach nobody.
      if (viewerId !== null) return `${stamp} Correction: something you were told earlier did not happen, and is withdrawn. ${data.text ?? ""}`.trimEnd();
      if (data.replacement !== undefined) return `${stamp} The director reworded #${data.targetSequence}: ${data.replacement}`;
      return data.text === undefined
        ? `${stamp} The director deleted #${data.targetSequence}.`
        : `${stamp} Retcon of #${data.targetSequence} by the director: ${data.text}`;
    case "steering":
      return `${stamp} Director, outside the story, to ${data.targetId === undefined ? "everyone" : nameIn(state.characters, data.targetId)}: ${data.text}`;
    case "narration":
      return `${stamp} Narrator: ${data.text}`;
    case "ruling": {
      const lead = `${stamp} ${subject(data.actorId)} attempted "${data.intent}"; the referee`;
      if (data.decision === "automatic") {
        return `${lead} ruled that it simply works, taking ${formatDuration(data.seconds ?? 0)} (${data.reason})`;
      }
      if (data.decision === "existing") {
        return `${lead} treated it as "${nameIn(state.challenges, data.challengeId ?? "")}" (${data.reason})`;
      }
      const check = data.challenge;
      if (!check) return `${lead} called for a check (${data.reason})`;
      const band = difficultyBand(check.difficulty);
      if (rules.outcomes === "judgment") return `${lead} called for a ${band} check, "${check.name}" (${data.reason})`;
      const numbers = viewerId === null ? `, difficulty ${check.difficulty}, ${check.failureDamage} damage on failure` : "";
      return `${lead} called for a ${band} ${rules.stats ? `${statName(rules, check.ability)} ` : ""}check${numbers} (${data.reason})`;
    }
    case "discovery":
      return `${stamp} ${subject(data.actorId)} discovered, alone: ${data.text}`;
    case "belief_noted": {
      const evidence = data.evidence.length === 0 ? "" : ` from ${data.evidence.map((sequence) => `#${sequence}`).join(", ")}`;
      return `${stamp} ${subject(data.actorId)} noted (${data.source}${evidence}, ${data.confidence} confidence): `
        + `${entityName(state, data.about) ?? data.about}, ${data.attribute}: ${data.value}`;
    }
    case "goal_set": {
      const verb = data.status === "adopted" ? (data.kind === "commitment" ? "committed to" : "adopted the goal") : `${data.status} ${data.goalId}`;
      return `${stamp} ${subject(data.actorId)} ${verb}: "${data.text}"${data.status === "adopted" ? ` (${data.goalId})` : ""}`;
    }
  }
}

/** An event as a numbered line, so an agent can cite it as evidence. */
export function eventLine(event: AdventureEvent, state: WorldState, viewerId: string | null): string {
  return `#${event.sequence} ${describeEvent(event, state, viewerId)}`;
}

function sourceLabel(topic: BeliefTopic): string {
  const belief = topic.current;
  const cited = belief.evidence.map((sequence) => `#${sequence}`).join(", ");
  switch (belief.source) {
    case "observed":
      return `seen ${cited}`;
    case "inferred":
      return `your inference from ${cited}; ${belief.confidence} confidence`;
    case "reported":
      return `hearsay from ${cited}; ${belief.confidence} confidence`;
    case "speculation":
      return `your guess; ${belief.confidence} confidence`;
  }
}

/**
 * Current beliefs worth stating, newest first. Beliefs that perception already
 * settles are left out: where the viewer and those present are, the status of
 * challenges here, and the exits from here.
 */
export function beliefLines(topics: BeliefTopic[], perception: Perception, state: WorldState, limit = 12): string[] {
  const visible = new Set([perception.characterId, ...perception.present.map((other) => other.id)]);
  const here = new Set(perception.challenges.map((challenge) => challenge.id));
  return topics
    .filter((topic) => !(topic.attribute === "location" && visible.has(topic.about)))
    .filter((topic) => !(topic.attribute === "status" && here.has(topic.about)))
    .filter((topic) => !(topic.about === perception.location.id && topic.attribute.startsWith("route to ")))
    .slice(0, limit)
    .map((topic) => {
      const name = entityName(state, topic.about);
      const subject = name === null ? topic.about : `${name} (${topic.about})`;
      return `- ${subject}, ${attributeKey(topic.current.attribute)}: ${topic.current.value} [${sourceLabel(topic)}]`;
    });
}

/** The viewer's open goals and commitments, oldest first. */
export function goalLines(state: WorldState, viewerId: string): string[] {
  const goals = state.characters.find((character) => character.id === viewerId)?.goals ?? [];
  return goals.filter((goal) => goal.status === "adopted").map((goal) => `- ${goal.id} (${goal.kind}): ${goal.text}`);
}

function memoryLines(memory: MemoryView, withGoals: boolean): string[] {
  const lines: string[] = [];
  if (memory.recalled.length > 0) lines.push("", "## What you remember from earlier, oldest first", ...memory.recalled);
  if (memory.beliefs.length > 0) lines.push("", "## What you believe, newest first", ...memory.beliefs);
  if (withGoals) lines.push("", "## Your goals and commitments", ...(memory.goals.length === 0 ? ["None yet."] : memory.goals));
  return lines;
}

/** The user message for a character turn: perception, history, legal actions, feedback. */
export function renderCharacterPrompt(
  perception: Perception,
  actions: AvailableActions,
  recent: string[],
  feedback: string[],
  memory: MemoryView = NO_MEMORY,
  direction: Direction = NO_DIRECTION,
): string {
  const { rules } = perception;
  const judged = rules.outcomes === "judgment";
  const lines: string[] = [];
  lines.push(`It is ${formatClock(perception.elapsedSeconds)} into the story.`, "");
  lines.push("## Where you are");
  lines.push(...placeLines(perception));
  if (perception.challenges.length > 0) lines.push("Challenges here:");
  for (const challenge of perception.challenges) {
    const details = [
      ...(rules.stats ? [`uses ${statName(rules, challenge.ability)}`] : []),
      `looks ${challenge.difficulty}`,
      ...(rules.health ? [challenge.dangerous ? "failure can hurt" : "failure is harmless"] : []),
    ];
    if (challenge.requires) {
      details.push(`needs ${challenge.requires.name} (${challenge.requires.carried ? "you carry it" : "you do not carry it"})`);
    }
    if (challenge.resolved) details.push("already done");
    lines.push(`- ${challenge.name} (${challenge.id}):${challenge.description ? ` ${challenge.description}` : ""} [${details.join("; ")}]`);
  }
  lines.push("", "## You");
  const status = statusLine(rules, perception.hp, perception.maxHp, perception.modifiers, perception.condition);
  if (status) lines.push(status);
  lines.push(perception.inventory.length === 0
    ? "Carrying nothing."
    : `Carrying: ${perception.inventory.map((entry) => `${entry.name} (${entry.id}) ×${entry.quantity}`).join(", ")}.`);
  lines.push(...memoryLines(memory, true));
  lines.push("", "## Available actions");
  if (actions.move.length > 0) lines.push(`- move: destinationId one of ${actions.move.join(", ")}`);
  if (actions.transfer.recipients.length > 0 && actions.transfer.items.length > 0) {
    lines.push(`- transfer_item: recipientId one of ${actions.transfer.recipients.join(", ")}; itemId one of ${actions.transfer.items.map((entry) => `${entry.id} (you have ${entry.quantity})`).join(", ")}; quantity at least 1`);
  }
  if (actions.attempt.length > 0) {
    lines.push(`- attempt_check: challengeId one of ${actions.attempt.join(", ")}${judged ? "; approach, how you go about it, which the referee judges" : ""}`);
  }
  if (actions.intent) {
    lines.push("- attempt: intent, a short phrase for anything else you try; the referee decides how the engine resolves it");
  }
  lines.push(`- wait: minutes from 1 to ${actions.maxWaitMinutes}`);
  if (!direction.requireAction) lines.push("Or take no action and only speak.");
  if (perception.present.length > 0) {
    lines.push(`To speak to one person, set "to" to their ID: ${perception.present.map((other) => other.id).join(", ")}.`);
  }
  lines.push("", "## Remembering, alongside your turn");
  lines.push("- note: a belief worth remembering about one person, place, item, or challenge ID, citing the #numbers of events you perceived that support it, or [] for a guess.");
  lines.push(memory.goals.length === 0
    ? "- goal: adopt a goal, or commit to something for someone."
    : "- goal: adopt a goal, or commit to something for someone; or mark one of your open goals fulfilled or abandoned by its ID.");
  lines.push("Leave note and goal null unless something is worth remembering.");
  // The story comes last, so the turn answers what just happened rather than the format.
  lines.push("", "## What you perceived recently, oldest first");
  lines.push(...(recent.length === 0 ? ["Nothing yet."] : recent));
  lines.push(...directionLines(direction));
  lines.push("", "## Your turn");
  lines.push(perception.present.length === 0
    ? "Nobody else is here, so act rather than speak."
    : "Respond to what just happened, as yourself: speak, act, or both. Don't repeat what was just said.");
  if (feedback.length > 0) {
    lines.push("", "## Your previous proposal was rejected");
    lines.push(...feedback.map((entry) => `- ${entry}`));
    lines.push("Propose a different turn.");
  }
  return lines.join("\n");
}

function steeringLines(steering: string[]): string[] {
  if (steering.length === 0) return [];
  return [
    "", "## A request from the director, outside the story", ...steering.map((text) => `- ${text}`),
    "Take it seriously: it may call for a very different approach. By itself it changes nothing in the world; only actions the engine accepts make anything happen.",
  ];
}

/** The director's steering, then the scheduler's pressure on a group that keeps talking without acting. */
function directionLines(direction: Direction): string[] {
  const lines = steeringLines(direction.steering);
  if (direction.requireAction) {
    lines.push("", "## The talking has gone on long enough");
    lines.push(`Nobody has acted for ${direction.stalled} turns. This turn you must take an action; a reply with only speech will be rejected.`);
  } else if (direction.nudge && direction.conversation) {
    lines.push("", "## The scene is going in circles");
    lines.push(`Nobody has acted for ${direction.stalled} turns. Move the scene forward: reveal something, ask what matters, or try something.`);
  } else if (direction.nudge) {
    lines.push("", "## The group is going in circles");
    lines.push(`Nobody has acted for ${direction.stalled} turns. Do not repeat the debate: propose a materially different approach and say what it costs or risks, or act.`);
  }
  return lines;
}

/** The user message for narration: the committed outcome and its scene. */
export function renderNarrationPrompt(
  state: WorldState,
  locationId: string,
  outcome: string[],
  recent: string[],
  feedback: string[],
): string {
  const location = state.locations.find((entry) => entry.id === locationId);
  const lines = ["## Committed outcome to narrate", ...outcome, "", "## Scene"];
  lines.push(`${location?.name ?? locationId}${location?.description ? `: ${location.description}` : ""}`);
  lines.push("", "## Earlier events here, for continuity", ...(recent.length === 0 ? ["None."] : recent));
  if (feedback.length > 0) {
    lines.push("", "## Your previous narration was rejected", ...feedback.map((entry) => `- ${entry}`));
  }
  return lines.join("\n");
}

function placeLines(perception: Perception): string[] {
  const lines = [
    `${perception.location.name} (${perception.location.id})${perception.location.description ? `: ${perception.location.description}` : ""}`,
    "Exits:",
  ];
  if (perception.exits.length === 0) lines.push("- none");
  for (const exit of perception.exits) {
    lines.push(`- ${exit.name} (${exit.id}): ${formatDuration(exit.seconds)} away${exit.blocked ? ", blocked" : ""}`);
  }
  lines.push(perception.present.length === 0 ? "Nobody else is here." : "Here with you:");
  // Without health, everyone is always unhurt, so a condition says nothing.
  for (const other of perception.present) lines.push(`- ${other.name} (${other.id})${perception.rules.health ? `, ${other.condition}` : ""}`);
  return lines;
}

/** The user message for an NPC's turn: what the NPC perceives, and how it may answer. */
export function renderNpcPrompt(
  perception: Perception,
  recent: string[],
  feedback: string[],
  reason: NpcTurnReason = "addressed",
  memory: MemoryView = NO_MEMORY,
  steering: string[] = [],
  failed: string[] = [],
): string {
  const addressed = reason === "addressed";
  const lines = [`It is ${formatClock(perception.elapsedSeconds)} into the story.`, "", "## Where you are"];
  lines.push(...placeLines(perception));
  lines.push(...memoryLines(memory, false));
  lines.push("", "## What you perceived recently, oldest first", ...(recent.length === 0 ? ["Nothing yet."] : recent));
  lines.push(...steeringLines(steering));
  if (failed.length > 0) {
    lines.push("", "## Attempts that just failed in front of you", ...failed);
    lines.push("That is how it went. If one was after something from you, such as what you know or your help, you did not give it: "
      + "don't hand it over now in your own words. They may try again another way.");
  }
  lines.push("", "## Your turn");
  lines.push({
    addressed: "Someone has spoken to you. Answer them, in your own voice.",
    cued: "It is your turn to speak: say something to those present, in your own voice.",
    agenda: "Nobody has spoken to you, but you have aims of your own. Speak up to pursue one of them, in your own voice.",
  }[reason]);
  const open = perception.exits.filter((exit) => !exit.blocked).map((exit) => exit.id);
  if (perception.present.length > 0) {
    lines.push(`Set "to" to the ID of the one person you ${addressed ? "answer" : "speak to"}: ${perception.present.map((other) => other.id).join(", ")}; or null.`);
  }
  lines.push(open.length > 0 ? `You may also walk away: set "move" to one of ${open.join(", ")}; or null to stay.` : `Set "move" to null.`);
  lines.push(`Set "leave" to true only if you leave the scene now, after speaking; otherwise false.`);
  if (feedback.length > 0) {
    lines.push("", "## Your previous reply was rejected", ...feedback.map((entry) => `- ${entry}`));
  }
  return lines.join("\n");
}

/**
 * The user message for a ruling. The referee sees the attempt, the scene, and the
 * full rules of the challenges here; never events from other places.
 */
export function renderRulingPrompt(
  state: WorldState,
  actorId: string,
  intent: string,
  recent: string[],
  feedback: string[],
  said?: Said,
): string {
  const perception = perceive(state, actorId);
  const { rules } = perception;
  const limits = state.rulings;
  const lines = [
    "## The attempt", `${perception.name} (${actorId}) attempts: "${intent}"`, ...saidLine(state, perception.name, said), "", "## Scene",
  ];
  lines.push(...placeLines(perception));
  lines.push("", "## Challenges here");
  const here = state.challenges.filter((challenge) => challenge.locationId === perception.location.id);
  if (here.length === 0) lines.push("None.");
  for (const challenge of here) {
    const details = [
      `${abilityLabel(rules, challenge.ability)} against ${challenge.difficulty}`,
      ...(rules.health ? [`failure deals ${challenge.failureDamage} damage`] : []),
      ...(challenge.requiresItemId ? [`needs ${nameIn(state.items, challenge.requiresItemId)}`] : []),
      challenge.resolved ? "already resolved" : "open",
    ];
    lines.push(`- ${challenge.name} (${challenge.id}): ${details.join("; ")}${challenge.description ? `. ${challenge.description}` : ""}`);
  }
  lines.push(...beyondTheScene(state, perception));
  lines.push("", `## ${perception.name}`);
  const status = statusLine(rules, perception.hp, perception.maxHp, perception.modifiers);
  if (status) lines.push(status);
  lines.push(carrying(perception));
  if (limits) {
    lines.push("", "## Limits for a new check");
    lines.push(`Abilities: ${limits.abilities.map((ability) => abilityLabel(rules, ability)).join(", ")}.`);
    lines.push(...newCheckLimits(rules, limits));
  }
  lines.push("", "## Recent events here, oldest first", ...(recent.length === 0 ? ["None."] : recent));
  if (feedback.length > 0) {
    lines.push("", "## Your previous ruling was rejected", ...feedback.map((entry) => `- ${entry}`));
  }
  return lines.join("\n");
}

/**
 * What a referee needs to rule on open-ended attempts beyond the scene: who is
 * away and could be brought in, which supporting characters here could be sent
 * off, and the challenges in other places, named only so it can point the way.
 */
function beyondTheScene(state: WorldState, perception: Perception): string[] {
  const away = state.characters.filter((character) => !inScene(character));
  const supporting = state.characters.filter((character) => (
    character.npc === true && inScene(character) && character.locationId === perception.location.id
  ));
  const lines = ["", "## Away from the scene", ...(away.length === 0 ? ["Nobody."] : away.map((character) => `- ${character.name} (${character.id})`))];
  if (supporting.length > 0) {
    lines.push(`Supporting characters here: ${supporting.map((character) => `${character.name} (${character.id})`).join(", ")}.`);
  }
  const elsewhere = state.challenges.filter((challenge) => challenge.locationId !== perception.location.id && !challenge.resolved);
  lines.push("", "## Challenges elsewhere (only to point the way)");
  if (elsewhere.length === 0) lines.push("None.");
  for (const challenge of elsewhere) {
    lines.push(`- ${challenge.name}, at ${nameIn(state.locations, challenge.locationId)}${challenge.description ? `: ${challenge.description}` : ""}`);
  }
  return lines;
}

/** An ability as the dice referee gives it: its key, with the world's name when that differs. */
function abilityLabel(rules: WorldRules, ability: Ability): string {
  const name = rules.stats?.[ability];
  return !name || name.toLowerCase() === ability ? ability : `${ability} ("${name}")`;
}

function carrying(perception: Perception): string {
  return perception.inventory.length === 0
    ? "Carrying nothing."
    : `Carrying: ${perception.inventory.map((entry) => `${entry.name} ×${entry.quantity}`).join(", ")}.`;
}

/** The bounds on a new check, beyond its ability. */
function newCheckLimits(rules: WorldRules, limits: NonNullable<WorldState["rulings"]>): string[] {
  const bands = difficultyBandSchema.options;
  return [
    `Difficulty: ${bands.slice(0, bands.indexOf(limits.maxDifficulty) + 1).join(", ")}.`,
    ...(rules.health ? [`Failure damage: 0 to ${limits.maxFailureDamage}.`] : []),
    `Minutes: 1 to ${Math.floor(limits.maxSeconds / 60)}.`,
  ];
}

/** Words the actor speaks in the same turn as an attempt, which commit with it and so are not yet among the recent events. */
export interface Said {
  text: string;
  addresseeId?: string | undefined;
}

/** The actor's words as part of the attempt, under "## The attempt". */
function saidLine(state: WorldState, name: string, said: Said | undefined): string[] {
  if (!said) return [];
  const to = said.addresseeId === undefined ? "" : ` to ${nameIn(state.characters, said.addresseeId)}`;
  return [`As they do it, ${name} says${to}: "${said.text}"`];
}

/** What a judgment-world referee is asked to judge: an attempt at a listed challenge, or an open-ended one. */
export type JudgedAttempt = { challengeId: string; approach?: string | undefined } | { intent: string };

/**
 * The user message for a judgment-world referee. Beyond the scene, it sees
 * what each challenge here takes, and what the actor found out privately, so
 * it can judge them; the prompt says to reveal neither.
 */
export function renderJudgingPrompt(
  state: WorldState,
  actorId: string,
  attempt: JudgedAttempt,
  recent: string[],
  discoveries: string[],
  feedback: string[],
  said?: Said,
): string {
  const perception = perceive(state, actorId);
  const { rules } = perception;
  const lines = ["## The attempt"];
  if ("intent" in attempt) {
    lines.push(`${perception.name} (${actorId}) attempts: "${attempt.intent}"`);
  } else {
    const approach = attempt.approach ? `, going about it like this: "${attempt.approach}"` : ", without saying how";
    lines.push(`${perception.name} (${actorId}) attempts "${nameIn(state.challenges, attempt.challengeId)}" (${attempt.challengeId})${approach}.`);
  }
  lines.push(...saidLine(state, perception.name, said));
  lines.push("", "## Scene", ...placeLines(perception), "", "## Challenges here");
  const here = state.challenges.filter((challenge) => (
    challenge.locationId === perception.location.id && ("intent" in attempt || challenge.id === attempt.challengeId)
  ));
  if (here.length === 0) lines.push("None.");
  for (const challenge of here) {
    const details = [
      `looks ${difficultyBand(challenge.difficulty)}`,
      ...(rules.stats ? [`leans on ${statName(rules, challenge.ability)}`] : []),
      ...(rules.health && challenge.failureDamage > 0 ? [`failure costs ${challenge.failureDamage} ${rules.health}`] : []),
      ...(challenge.requiresItemId ? [`needs ${nameIn(state.items, challenge.requiresItemId)}`] : []),
      challenge.resolved ? "already done" : "open",
    ];
    lines.push(`- ${challenge.name} (${challenge.id}): ${details.join("; ")}${challenge.description ? `. ${challenge.description}` : ""}`);
    lines.push(`  What it takes (hidden): ${challenge.criteria ?? "not stated; judge what is plausible here"}`);
  }
  if ("intent" in attempt) lines.push(...beyondTheScene(state, perception));
  lines.push("", `## ${perception.name}`);
  const status = statusLine(rules, perception.hp, perception.maxHp, perception.modifiers);
  if (status) lines.push(status);
  lines.push(carrying(perception));
  lines.push("", `## What ${perception.name} found out privately (never reveal it)`, ...(discoveries.length === 0 ? ["Nothing."] : discoveries));
  if ("intent" in attempt && state.rulings) {
    lines.push("", "## Limits for a new check");
    if (rules.stats) lines.push(`Stats: ${state.rulings.abilities.map((ability) => `${ability} ("${statName(rules, ability)}")`).join(", ")}.`);
    lines.push(...newCheckLimits(rules, state.rulings));
  }
  lines.push("", "## Recent events here, oldest first", ...(recent.length === 0 ? ["None."] : recent));
  if (feedback.length > 0) {
    lines.push("", "## Your previous judgment was rejected", ...feedback.map((entry) => `- ${entry}`));
  }
  return lines.join("\n");
}
