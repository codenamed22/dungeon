import type { AdventureEvent, Confidence, WorldState } from "./model.ts";
import type { Perception } from "./perception.ts";

// Personal memory, derived from the events one character perceived. Nothing
// here reads the world beyond names, so a character's memory can only hold
// what it was permitted to perceive.

export type BeliefSource = "observed" | "inferred" | "reported" | "speculation";

export interface Belief {
  /** The ID of the person, place, item, or challenge the belief is about. */
  about: string;
  attribute: string;
  value: string;
  confidence: Confidence;
  source: BeliefSource;
  /** The event that recorded the belief: the observation itself, or the note. */
  sequence: number;
  /** The newest event the belief rests on. A belief resting on newer events supersedes it. */
  asOf: number;
  evidence: number[];
}

/** Everything a character has believed about one attribute of one thing. */
export interface BeliefTopic {
  about: string;
  /** The normalized attribute shared by every belief in the topic. */
  attribute: string;
  current: Belief;
  /** Every belief about it, oldest first; the last is current. Superseded beliefs are kept. */
  history: Belief[];
}

/** Event types a belief can come from; see `beliefsOf`. */
export const BELIEF_EVENTS = ["utterance", "character_moved", "item_transferred", "check_resolved", "belief_noted"] as const;

const ATTRIBUTE_SYNONYMS = new Map([
  ["where", "location"],
  ["whereabouts", "location"],
  ["position", "location"],
  ["place", "location"],
  ["owner", "holder"],
  ["held by", "holder"],
  ["carried by", "holder"],
  ["state", "status"],
]);

/** Attributes compare case-insensitively, ignoring punctuation and common synonyms. */
export function attributeKey(attribute: string): string {
  const key = attribute.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return ATTRIBUTE_SYNONYMS.get(key) ?? key;
}

function nameIn(entities: { id: string; name: string }[], id: string): string {
  return entities.find((entity) => entity.id === id)?.name ?? id;
}

/** What one perceived event tells the viewer, as beliefs. */
function beliefsFrom(event: AdventureEvent, viewerId: string, state: WorldState): Belief[] {
  const data = event.data;
  const observed = (about: string, attribute: string, value: string): Belief => ({
    about, attribute, value, confidence: "high", source: "observed",
    sequence: event.sequence, asOf: event.sequence, evidence: [event.sequence],
  });
  const place = (id: string) => nameIn(state.locations, id);
  const person = (id: string) => nameIn(state.characters, id);
  switch (data.type) {
    case "utterance":
      return data.actorId === viewerId ? [] : [observed(data.actorId, "location", place(data.locationId))];
    case "character_moved":
      return data.actorId === viewerId ? [] : [observed(data.actorId, "location", place(data.destinationId))];
    case "item_transferred":
      return [observed(data.itemId, "holder", person(data.recipientId))];
    case "check_resolved":
      return [
        observed(data.challengeId, "status", data.success ? "done" : "not done; an attempt failed"),
        ...data.effects.unlockedRoutes.map((route) => observed(route.fromId, `route to ${route.destinationId}`, "open")),
        ...data.effects.grantedItems.map((grant) => observed(grant.itemId, "holder", person(data.actorId))),
      ];
    case "belief_noted":
      if (data.actorId !== viewerId) return [];
      return [{
        about: data.about,
        attribute: data.attribute,
        value: data.value,
        confidence: data.confidence,
        source: data.source,
        sequence: event.sequence,
        asOf: data.evidence.at(-1) ?? event.sequence,
        evidence: data.evidence,
      }];
    default:
      return [];
  }
}

/**
 * A character's beliefs, from the events it perceived, oldest first. Each topic's
 * current belief is the one resting on the newest event, so a fresh observation
 * supersedes an older note deterministically, while a note citing old evidence
 * never overrides what was seen since. Ties go to the later record.
 *
 * Observations come from engine facts: where speakers and movers are, who holds
 * an item, whether a challenge is done, and which ways opened. The viewer's own
 * location is left out, since perception already shows it.
 */
export function beliefsOf(viewerId: string, perceived: AdventureEvent[], state: WorldState): BeliefTopic[] {
  const topics = new Map<string, Belief[]>();
  for (const event of perceived) {
    for (const belief of beliefsFrom(event, viewerId, state)) {
      const key = `${belief.about}\u0000${attributeKey(belief.attribute)}`;
      topics.set(key, [...(topics.get(key) ?? []), belief]);
    }
  }
  return [...topics.values()]
    .map((history) => {
      history.sort((a, b) => a.asOf - b.asOf || a.sequence - b.sequence);
      const current = history.at(-1)!;
      return { about: current.about, attribute: attributeKey(current.attribute), current, history };
    })
    .sort((a, b) => b.current.asOf - a.current.asOf || b.current.sequence - a.current.sequence);
}

const MAX_RECALL_TERMS = 24;

function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? []).filter((word) => word.length >= 3);
}

/**
 * A full-text query for memories relevant to the character's situation: who and
 * what is here, what it carries, and the words of the latest things said to it.
 */
export function recallQuery(perception: Perception, recent: AdventureEvent[]): string {
  const terms = new Set<string>();
  const add = (...texts: string[]) => texts.forEach((text) => words(text).forEach((word) => terms.add(word)));
  add(perception.location.id, perception.location.name);
  for (const other of perception.present) add(other.id, other.name);
  for (const challenge of perception.challenges) add(challenge.id, challenge.name);
  for (const item of perception.inventory) add(item.id, item.name);
  const spoken = recent.filter((event) => event.data.type === "utterance" && event.data.actorId !== perception.characterId);
  for (const event of spoken.slice(-3)) {
    if (event.data.type === "utterance") add(event.data.text);
  }
  return [...terms].slice(0, MAX_RECALL_TERMS).join(" or ");
}

/**
 * How much an event matters to the viewer, apart from relevance and recency.
 * Unresolved consequences weigh more: a question put to the viewer, a failed
 * attempt at a challenge that is still open.
 */
export function salience(event: AdventureEvent, viewerId: string, state: WorldState): number {
  const data = event.data;
  switch (data.type) {
    case "discovery":
    case "story_ended":
      return 3;
    case "introduced":
    case "retraction":
      return 2;
    case "utterance":
      if (data.addresseeId !== viewerId) return 1;
      return data.text.includes("?") ? 3 : 2;
    case "check_resolved": {
      const open = state.challenges.find((challenge) => challenge.id === data.challengeId)?.resolved === false;
      const effects = data.effects.unlockedRoutes.length + data.effects.grantedItems.length > 0;
      return (!data.success && open) || effects ? 2 : 1;
    }
    case "item_transferred":
      return data.actorId === viewerId || data.recipientId === viewerId ? 2 : 1;
    case "ruling":
      return 1;
    case "narration":
    case "character_moved":
      return 0.5;
    default:
      return 0;
  }
}

/**
 * The `limit` best recollections among search matches, oldest first. Scores add
 * relevance relative to the best match (up to 2), salience (up to 3), and
 * recency within the matches (up to 1); ties go to the newer event.
 */
export function rankRecollections(
  matches: { event: AdventureEvent; rank: number }[],
  viewerId: string,
  state: WorldState,
  limit: number,
): AdventureEvent[] {
  if (matches.length === 0 || limit < 1) return [];
  const best = Math.max(...matches.map((match) => match.rank)) || 1;
  const sequences = matches.map((match) => match.event.sequence);
  const oldest = Math.min(...sequences);
  const span = Math.max(...sequences) - oldest || 1;
  return matches
    .map((match) => ({
      event: match.event,
      score: 2 * (match.rank / best) + salience(match.event, viewerId, state) + (match.event.sequence - oldest) / span,
    }))
    .sort((a, b) => b.score - a.score || b.event.sequence - a.event.sequence)
    .slice(0, limit)
    .map((entry) => entry.event)
    .sort((a, b) => a.sequence - b.sequence);
}
