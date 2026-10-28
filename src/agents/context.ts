import type { AdventureEvent, WorldState } from "../model.ts";
import type { AvailableActions, Perception } from "../perception.ts";

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

function signed(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
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
  const stamp = `[${formatClock(event.elapsedSeconds)}]`;
  switch (data.type) {
    case "world_created":
      return `${stamp} The adventure "${data.seed.name}" began.`;
    case "utterance":
      return `${stamp} ${subject(data.actorId)} said: "${data.text}"`;
    case "character_moved":
      return `${stamp} ${subject(data.actorId)} went from ${place(data.fromId)} to ${place(data.destinationId)} (${formatDuration(data.seconds)}).`;
    case "item_transferred":
      return `${stamp} ${subject(data.actorId)} gave ${object(data.recipientId)} ${item(data.itemId)} ×${data.quantity}.`;
    case "check_resolved": {
      const challenge = nameIn(state.challenges, data.challengeId);
      const parts = [
        `${stamp} ${subject(data.actorId)} attempted "${challenge}" and ${data.success ? "succeeded" : "failed"}`
        + (data.damage > 0 ? `, taking ${data.damage} damage.` : "."),
      ];
      if (viewerId === null) {
        parts.push(`(Rolled ${data.roll} ${signed(data.modifier)} against ${data.difficulty}.)`);
      }
      for (const route of data.effects.unlockedRoutes) {
        parts.push(`The way from ${place(route.fromId)} to ${place(route.destinationId)} is now open.`);
      }
      for (const grant of data.effects.grantedItems) {
        parts.push(`${subject(data.actorId)} found ${item(grant.itemId)} ×${grant.quantity}.`);
      }
      return parts.join(" ");
    }
    case "time_advanced":
      return `${stamp} ${subject(data.actorId)} waited ${formatDuration(data.seconds)}.`;
    case "narration":
      return `${stamp} Narrator: ${data.text}`;
  }
}

/** The user message for a character turn: perception, history, legal actions, feedback. */
export function renderCharacterPrompt(
  perception: Perception,
  actions: AvailableActions,
  recent: string[],
  feedback: string[],
): string {
  const lines: string[] = [];
  lines.push(`It is ${formatClock(perception.elapsedSeconds)} into the adventure.`, "");
  lines.push("## Where you are");
  lines.push(`${perception.location.name} (${perception.location.id})${perception.location.description ? `: ${perception.location.description}` : ""}`);
  lines.push("Exits:");
  if (perception.exits.length === 0) lines.push("- none");
  for (const exit of perception.exits) {
    lines.push(`- ${exit.name} (${exit.id}): ${formatDuration(exit.seconds)} away${exit.blocked ? ", blocked" : ""}`);
  }
  lines.push(perception.present.length === 0 ? "Nobody else is here." : "Here with you:");
  for (const other of perception.present) lines.push(`- ${other.name} (${other.id}), ${other.condition}`);
  if (perception.challenges.length > 0) lines.push("Challenges here:");
  for (const challenge of perception.challenges) {
    const details = [
      `uses ${challenge.ability}`,
      `looks ${challenge.difficulty}`,
      challenge.dangerous ? "failure can hurt" : "failure is harmless",
    ];
    if (challenge.requires) {
      details.push(`needs ${challenge.requires.name} (${challenge.requires.carried ? "you carry it" : "you do not carry it"})`);
    }
    if (challenge.resolved) details.push("already done");
    lines.push(`- ${challenge.name} (${challenge.id}):${challenge.description ? ` ${challenge.description}` : ""} [${details.join("; ")}]`);
  }
  lines.push("", "## You");
  lines.push(`HP ${perception.hp}/${perception.maxHp} (${perception.condition}). Strength ${signed(perception.modifiers.strength)}, dexterity ${signed(perception.modifiers.dexterity)}, wisdom ${signed(perception.modifiers.wisdom)}.`);
  lines.push(perception.inventory.length === 0
    ? "Carrying nothing."
    : `Carrying: ${perception.inventory.map((entry) => `${entry.name} (${entry.id}) ×${entry.quantity}`).join(", ")}.`);
  lines.push("", "## What you perceived recently, oldest first");
  lines.push(...(recent.length === 0 ? ["Nothing yet."] : recent));
  lines.push("", "## Available actions");
  if (actions.move.length > 0) lines.push(`- move: destinationId one of ${actions.move.join(", ")}`);
  if (actions.transfer.recipients.length > 0 && actions.transfer.items.length > 0) {
    lines.push(`- transfer_item: recipientId one of ${actions.transfer.recipients.join(", ")}; itemId one of ${actions.transfer.items.map((entry) => `${entry.id} (you have ${entry.quantity})`).join(", ")}; quantity at least 1`);
  }
  if (actions.attempt.length > 0) lines.push(`- attempt_check: challengeId one of ${actions.attempt.join(", ")}`);
  lines.push(`- wait: minutes from 1 to ${actions.maxWaitMinutes}`);
  lines.push("Or take no action and only speak.");
  if (feedback.length > 0) {
    lines.push("", "## Your previous proposal was rejected");
    lines.push(...feedback.map((entry) => `- ${entry}`));
    lines.push("Propose a different turn.");
  }
  return lines.join("\n");
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
