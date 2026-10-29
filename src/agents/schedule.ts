import type { AdventureEvent, WorldState } from "../model.ts";
import { actorOf, inScene, isMental, isNpc } from "../rules.ts";
import type { Pace } from "./prompts.ts";

/** One actor's turn: the events committed under one request ID. Narration is not a turn. */
export interface TurnRecord {
  requestId: string;
  actorId: string;
  npc: boolean;
  /** Whom the turn's speech addressed, if anyone. */
  addresseeId: string | null;
  /** Whether the actor did anything besides speak and think. A threat firing is not their action. */
  acted: boolean;
  /** In-world seconds when the turn's last event ended. */
  endedAt: number;
}

/** Groups the character and NPC turns in a slice of the log, oldest first. */
export function turnHistory(events: AdventureEvent[], state: WorldState): TurnRecord[] {
  const turns: TurnRecord[] = [];
  for (const event of events) {
    const data = event.data;
    if (data.type === "world_created" || data.type === "narration" || data.type === "steering") continue;
    const actorId = actorOf(data);
    let turn = turns.at(-1);
    if (turn?.requestId !== event.requestId) {
      // Threats and hidden consequences follow the turn that set them off, under its request ID.
      if (actorId === undefined) continue;
      turn = { requestId: event.requestId, actorId, npc: isNpc(state, actorId), addresseeId: null, acted: false, endedAt: 0 };
      turns.push(turn);
    }
    turn.endedAt = event.elapsedSeconds;
    if (data.type === "utterance") turn.addresseeId = data.addresseeId ?? null;
    else if (actorId === turn.actorId && !isMental(data.type)) turn.acted = true;
  }
  return turns;
}

/**
 * Chooses who acts next. Whoever the last turn addressed answers, if they can
 * and the speaker is still there to hear it, unless another agent has already
 * waited a full round. Otherwise an NPC whose
 * agenda is due speaks up, and failing that the agent who has waited longest
 * acts, ties going to world order, which is round-robin when nobody is
 * addressed. NPCs act only when addressed or due, never twice running.
 *
 * @param agents conscious characters with a persona, in world order
 * @param npcs conscious NPCs with a persona
 * @param due NPCs whose agenda is due (see `dueAgendas`)
 * @param together whether two characters are in the same place now
 */
export function chooseNextActor(
  turns: TurnRecord[],
  agents: string[],
  npcs: ReadonlySet<string>,
  due: readonly string[] = [],
  together: (a: string, b: string) => boolean = () => true,
): string | null {
  if (agents.length === 0) return null;
  const waited = (id: string) => turns.length - 1 - turns.findLastIndex((turn) => turn.actorId === id);
  const last = turns.at(-1);
  const addressed = last?.addresseeId;
  let starving = false;
  if (last && addressed && addressed !== last.actorId && (agents.includes(addressed) || npcs.has(addressed)) && together(last.actorId, addressed)) {
    starving = agents.some((id) => id !== addressed && id !== last.actorId && waited(id) >= agents.length);
    if (!starving) return addressed;
  }
  const speaksUp = starving ? undefined : due.find((id) => npcs.has(id) && id !== last?.actorId);
  if (speaksUp) return speaksUp;
  let next = agents[0]!;
  for (const id of agents) if (waited(id) > waited(next)) next = id;
  return next;
}

/** Whether two characters are in the scene, in the same place, in this state. */
export function togetherIn(state: WorldState): (a: string, b: string) => boolean {
  const place = new Map(state.characters.filter(inScene).map((character) => [character.id, character.locationId]));
  return (a, b) => place.get(a) !== undefined && place.get(a) === place.get(b);
}

/**
 * NPCs whose agenda is due, in world order: a conscious NPC with an agenda
 * speaks up once `everySeconds` of in-world time have passed since its last
 * turn (or since the start), provided it and a party member are in the scene, together. Time
 * must pass between its turns, so an NPC cannot drive itself.
 */
export function dueAgendas(turns: TurnRecord[], state: WorldState, agendas: ReadonlyMap<string, number>): string[] {
  return state.characters
    .filter((npc) => npc.npc && npc.hp > 0 && inScene(npc) && agendas.has(npc.id))
    .filter((npc) => state.characters.some((other) => (
      !other.npc && other.hp > 0 && inScene(other) && other.locationId === npc.locationId
    )))
    .filter((npc) => state.elapsedSeconds - (turns.findLast((turn) => turn.actorId === npc.id)?.endedAt ?? 0) >= agendas.get(npc.id)!)
    .map((npc) => npc.id);
}

/**
 * The director's steering an actor has not yet had a turn to see, oldest first:
 * requests addressed to it, and requests to the whole party.
 */
export function pendingSteering(events: AdventureEvent[], actorId: string): string[] {
  const lastTurn = events.findLast((event) => actorOf(event.data) === actorId)?.sequence ?? 0;
  return events.flatMap((event) => (
    event.data.type === "steering" && event.sequence > lastTurn && (event.data.targetId ?? actorId) === actorId
      ? [event.data.text]
      : []
  ));
}

/** How the scheduler leans on a stalled group: a nudge first, then a required action. */
export interface StallPolicy {
  /** Character turns without an action before prompts ask for a different approach; 0 disables. */
  nudgeAfter: number;
  /** Character turns without an action before the next turn must act; 0 disables. */
  requireActionAfter: number;
  /** Whether talk may carry the story, so a nudge asks to move the scene on rather than to act. */
  conversation?: boolean;
}

/**
 * The stall policy for a world's pace. An action story keeps the settings; a
 * conversation nudges after twice as many turns, never forces an action, and
 * never stops a run for talking (`stallTurns` 0).
 */
export function pacePolicy<T extends StallPolicy & { stallTurns: number }>(pace: Pace | undefined, settings: T): T {
  if (pace !== "conversation") return settings;
  return { ...settings, nudgeAfter: settings.nudgeAfter * 2, requireActionAfter: 0, stallTurns: 0, conversation: true };
}

export interface Direction {
  /** Character turns in a row, ending with the latest, that only spoke. */
  stalled: number;
  nudge: boolean;
  requireAction: boolean;
  /** The director's pending requests to this actor, oldest first. */
  steering: string[];
  /** Whether talk may carry the story; see `StallPolicy`. */
  conversation: boolean;
}

export function turnDirection(turns: TurnRecord[], events: AdventureEvent[], actorId: string, policy: StallPolicy): Direction {
  const stalled = turnsWithoutAction(turns);
  return {
    stalled,
    nudge: policy.nudgeAfter > 0 && stalled >= policy.nudgeAfter,
    requireAction: policy.requireActionAfter > 0 && stalled >= policy.requireActionAfter,
    steering: pendingSteering(events, actorId),
    conversation: policy.conversation === true,
  };
}

/** How many character turns in a row, ending with the latest, only spoke. NPC turns are skipped. */
export function turnsWithoutAction(turns: TurnRecord[]): number {
  let count = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (turn.npc) continue;
    if (turn.acted) break;
    count += 1;
  }
  return count;
}

/** The latest character turn, which is the one that may still need narration. */
export function lastCharacterTurn(turns: TurnRecord[]): TurnRecord | undefined {
  return turns.findLast((turn) => !turn.npc);
}
