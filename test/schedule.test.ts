import assert from "node:assert/strict";
import test from "node:test";
import { starterWorld } from "../src/adventures/starter.ts";
import { computeMetrics } from "../src/agents/metrics.ts";
import { chooseNextActor, lastCharacterTurn, turnHistory, turnsWithoutAction } from "../src/agents/schedule.ts";
import type { TurnRecord } from "../src/agents/schedule.ts";
import type { TraceRecord } from "../src/engine.ts";
import type { AdventureEvent } from "../src/model.ts";
import { commitTurn, creationEvent, initialState, NOW } from "./support.ts";

const agents = ["mira", "bram", "elowen"];
const npcs = new Set(["tamsin"]);

function turn(actorId: string, addresseeId: string | null = null, acted = false, endedAt = 0): TurnRecord {
  return { requestId: `r-${actorId}`, actorId, npc: npcs.has(actorId), addresseeId, acted, endedAt };
}

test("speakers rotate in world order when nobody is addressed", () => {
  const order: string[] = [];
  const turns: TurnRecord[] = [];
  for (let index = 0; index < 6; index += 1) {
    const next = chooseNextActor(turns, agents, npcs)!;
    order.push(next);
    turns.push(turn(next));
  }
  assert.deepEqual(order, ["mira", "bram", "elowen", "mira", "bram", "elowen"]);
  assert.equal(chooseNextActor([], [], npcs), null);
  assert.equal(chooseNextActor([turn("mira")], ["mira"], npcs), "mira", "a lone agent takes every turn");
});

test("the addressed actor answers, unless someone else has waited a full round", () => {
  assert.equal(chooseNextActor([turn("mira", "elowen")], agents, npcs), "elowen");
  assert.equal(chooseNextActor([turn("mira", "tamsin")], agents, npcs), "tamsin", "an addressed NPC answers");
  assert.equal(chooseNextActor([turn("mira"), turn("tamsin", "mira")], agents, npcs), "mira");
  // Ping-pong between Mira and Bram yields to Elowen once she has waited a round.
  const pingPong = [turn("mira", "bram"), turn("bram", "mira"), turn("mira", "bram")];
  assert.equal(chooseNextActor(pingPong.slice(0, 2), agents, npcs), "mira");
  assert.equal(chooseNextActor(pingPong, agents, npcs), "elowen");
  // Addressing yourself, an absent person, or an NPC without a persona falls back to balance.
  assert.equal(chooseNextActor([turn("mira", "mira")], agents, npcs), "bram");
  assert.equal(chooseNextActor([turn("mira", "stranger")], agents, npcs), "bram");
  assert.equal(chooseNextActor([turn("mira", "tamsin")], agents, new Set()), "bram");
  assert.equal(chooseNextActor([turn("mira", "bram")], ["mira", "elowen"], npcs), "elowen", "an incapacitated addressee cannot answer");
});

test("NPCs never act unaddressed, so they cannot loop on their own", () => {
  const turns: TurnRecord[] = [turn("mira", "tamsin"), turn("tamsin")];
  for (let index = 0; index < 6; index += 1) {
    const next = chooseNextActor(turns, agents, npcs)!;
    assert.notEqual(next, "tamsin");
    turns.push(turn(next));
  }
  // Two NPCs addressing each other still yield to the party within a round.
  const both = new Set(["tamsin", "warden"]);
  const chatter = [turn("mira", "tamsin"), turn("tamsin", "warden"), turn("warden", "tamsin")];
  assert.equal(chooseNextActor(chatter, agents, both), "bram");
});

test("turn history groups events by request, and stalls count only character turns", () => {
  let state = initialState(starterWorld("history"));
  const events: AdventureEvent[] = [creationEvent(starterWorld("history"))];
  const commit = (input: Record<string, unknown>, requestId: string) => {
    const result = commitTurn(state, { ...input, requestId });
    events.push(...result.committed.map(({ event }) => event));
    state = result.state;
  };
  commit({ actorId: "mira", speech: "Grandmother?", addresseeId: "tamsin" }, "t1-mira");
  commit({ actorId: "bram", speech: "Let's go.", action: { type: "move", destinationId: "mouth" } }, "t2-bram");
  commit({ actorId: "elowen", speech: "Waiting." }, "t3-elowen");
  events.push({
    v: 2, worldId: "history", sequence: state.revision + 1, requestId: "t5-tamsin", source: "dm", recordedAt: NOW,
    elapsedSeconds: state.elapsedSeconds + 10,
    data: { type: "utterance", actorId: "tamsin", locationId: "camp", text: "Yes?", seconds: 10, addresseeId: "mira" },
  });
  const turns = turnHistory(events, state);
  assert.deepEqual(turns, [
    { requestId: "t1-mira", actorId: "mira", npc: false, addresseeId: "tamsin", acted: false, endedAt: 10 },
    { requestId: "t2-bram", actorId: "bram", npc: false, addresseeId: null, acted: true, endedAt: 320 },
    { requestId: "t3-elowen", actorId: "elowen", npc: false, addresseeId: null, acted: false, endedAt: 330 },
    { requestId: "t5-tamsin", actorId: "tamsin", npc: true, addresseeId: "mira", acted: false, endedAt: 340 },
  ]);
  assert.equal(turnsWithoutAction(turns), 1, "the NPC's reply neither counts nor resets the stall");
  assert.equal(lastCharacterTurn(turns)?.requestId, "t3-elowen");
  assert.equal(turnsWithoutAction([]), 0);
});

test("metrics summarize turns, rulings, invalid proposals, cost, and latency", () => {
  let state = initialState(starterWorld("metrics"));
  const events: AdventureEvent[] = [creationEvent(starterWorld("metrics"))];
  const commit = (input: Record<string, unknown>, requestId: string) => {
    const result = commitTurn(state, { ...input, requestId });
    events.push(...result.committed.map(({ event }) => event));
    state = result.state;
  };
  commit({ actorId: "mira", speech: "Well?" }, "t1-mira");
  commit({ actorId: "bram", speech: "Hm." }, "t2-bram");
  commit({
    actorId: "elowen", action: { type: "attempt", intent: "sit" },
    ruling: { decision: "automatic", seconds: 60, reason: "Easy." },
  }, "t3-elowen");
  let id = 0;
  const trace = (task: TraceRecord["task"], outcome: string, cost: number | null, latencyMs: number): TraceRecord => ({
    id: ++id, createdAt: NOW, worldId: "metrics", turnId: "t", role: task === "character_turn" ? "character" : "dm", task,
    actorId: null, attempt: 1, provider: "test", model: "test", promptVersion: "test", request: { system: "", prompt: "" },
    response: {}, outcome, error: null, requestId: null, inputTokens: 100, outputTokens: 10, cost, latencyMs,
  });
  const traces = [
    trace("character_turn", "committed", 0.01, 1000),
    trace("character_turn", "invalid_output", 0.01, 1000),
    trace("character_turn", "committed", 0.01, 1000),
    trace("ruling", "ruled_impossible", 0.02, 500),
    trace("ruling", "ruled", 0.02, 500),
    trace("character_turn", "committed", null, 1000),
    trace("narration", "committed", 0.03, 2000),
    trace("character_turn", "provider_error", null, 0),
    trace(null, "committed", null, 0),
  ];
  const metrics = computeMetrics(events, traces, state);
  assert.deepEqual([metrics.characterTurns, metrics.npcTurns, metrics.turnsToFirstAction], [3, 0, 3]);
  assert.deepEqual(metrics.turnsByActor, { mira: 1, bram: 1, elowen: 1 });
  assert.deepEqual(metrics.rulings, { existing: 0, new: 0, automatic: 1, impossible: 1 });
  // One invalid among the 6 turn and ruling calls that answered (the provider error did not).
  assert.equal(metrics.invalidProposalRate, 1 / 6);
  assert.equal(metrics.calls, 9);
  assert.equal(metrics.tokens, 990);
  assert.ok(Math.abs(metrics.cost! - 0.1) < 1e-9);
  assert.ok(Math.abs(metrics.costPerTurn! - 0.1 / 3) < 1e-9);
  assert.equal(metrics.latencyPerTurnMs, 7000 / 3);
  const tasks = Object.fromEntries(metrics.tasks.map((entry) => [entry.task, [entry.calls, entry.invalid, entry.providerErrors]]));
  // The trace with no task predates Phase 2b; its dm role makes it narration.
  assert.deepEqual(tasks, { character_turn: [5, 1, 1], npc_turn: [0, 0, 0], ruling: [2, 0, 0], narration: [2, 0, 0] });
  assert.equal(metrics.tasks.find((entry) => entry.task === "npc_turn")?.cost, null);

  const empty = computeMetrics([], [], state);
  assert.deepEqual([empty.invalidProposalRate, empty.cost, empty.costPerTurn, empty.turnsToFirstAction], [null, null, null, null]);
});
