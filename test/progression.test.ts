import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { starterCast, starterWorld } from "../src/adventures/starter.ts";
import { describeEvent } from "../src/agents/context.ts";
import { computeMetrics } from "../src/agents/metrics.ts";
import type { Cast } from "../src/agents/prompts.ts";
import { ScriptedProvider } from "../src/agents/provider.ts";
import type { ScriptStep } from "../src/agents/provider.ts";
import { TurnRunner } from "../src/agents/runner.ts";
import type { RunnerSettings, StepOutcome } from "../src/agents/runner.ts";
import { chooseNextActor, dueAgendas, pendingSteering, turnDirection, turnHistory } from "../src/agents/schedule.ts";
import type { TurnRecord } from "../src/agents/schedule.ts";
import { AdventureEngine } from "../src/engine.ts";
import { commandSchema, validateWorld } from "../src/model.ts";
import type { AdventureEvent, Threat, WorldSeed } from "../src/model.ts";
import { applyEvent, Replayer } from "../src/rules.ts";
import { sampleWorld } from "../src/sample-world.ts";
import { creationEvent, errorCode, fixed, initialState, nextEvent, Session } from "./support.ts";

const SLUICE_TEXT = "Iron groans somewhere inside the walls, and a surge of black water roars down the channel.";
const COLLAPSE_TEXT = "With a long grinding roar, part of the channel ceiling comes down around the rubble.";

/** The starter world with the sluice due at `at`, and characters moved as given. */
function threatWorld(id: string, at: number, placed: Record<string, string> = {}, sluice: Partial<Threat> = {}): WorldSeed {
  const seed = starterWorld(id);
  seed.threats = seed.threats!.map((threat) => (threat.id === "sluice" ? { ...threat, at, ...sluice } : threat));
  seed.characters = seed.characters.map((character) => ({ ...character, locationId: placed[character.id] ?? character.locationId }));
  return seed;
}

const types = (events: { event: AdventureEvent }[]) => events.map(({ event }) => event.data.type);
const threatOf = (session: Session, id: string) => session.state.threats!.find((threat) => threat.id === id)!;
const hp = (session: Session, id: string) => session.state.characters.find((character) => character.id === id)!.hp;

test("a wait stops at the first threat, which strikes only those where it falls", () => {
  const session = new Session(threatWorld("sluice-wait", 400, { mira: "channel" }));
  const committed = session.commit({ actorId: "elowen", action: { type: "wait", seconds: 600 } });
  assert.deepEqual(committed.map(({ event }) => event.data), [
    { type: "time_advanced", actorId: "elowen", seconds: 400, interruptedBy: "sluice" },
    {
      type: "threat_triggered", threatId: "sluice", at: 400, text: SLUICE_TEXT, locationIds: ["channel"],
      damage: [{ characterId: "mira", amount: 2 }], lockedRoutes: [], unlockedRoutes: [],
    },
  ]);
  assert.deepEqual(committed.map(({ perceivers }) => perceivers), [["elowen"], ["mira"]]);
  assert.deepEqual(committed.map(({ event }) => [event.source, event.elapsedSeconds]), [["character", 400], ["engine", 400]]);
  assert.equal(hp(session, "mira"), 8);
  assert.equal(threatOf(session, "sluice").status, "fired");

  const [wait, strike] = committed.map(({ event }) => event) as [AdventureEvent, AdventureEvent];
  assert.match(describeEvent(wait, session.state, "elowen"), /You waited .+ before being interrupted\.$/);
  assert.match(describeEvent(strike, session.state, "mira"), /\] Iron groans .+ You take 2 damage\.$/);
  assert.match(describeEvent(strike, session.state, null), /\] Threat "The evening sluice": Iron groans .+ Mira takes 2 damage\.$/);

  // A fired threat is spent: the next wait runs its full length.
  assert.deepEqual(session.commit({ actorId: "elowen", action: { type: "wait", seconds: 600 } }).map(({ event }) => event.data), [
    { type: "time_advanced", actorId: "elowen", seconds: 600 },
  ]);
});

test("travel stops at a threat, leaving the traveller where they set out", () => {
  const session = new Session(threatWorld("sluice-travel", 60, { mira: "channel" }));
  const committed = session.commit({ actorId: "bram", action: { type: "move", destinationId: "mouth" } });
  assert.deepEqual(types(committed), ["travel_halted", "threat_triggered"]);
  assert.deepEqual(committed[0]!.event.data, {
    type: "travel_halted", actorId: "bram", fromId: "camp", destinationId: "mouth", seconds: 60, threatId: "sluice",
  });
  assert.deepEqual(committed.map(({ perceivers }) => perceivers), [["bram", "tamsin"], ["mira"]]);
  assert.equal(session.state.characters.find((character) => character.id === "bram")!.locationId, "camp");
  assert.equal(session.state.elapsedSeconds, 60);
  assert.match(
    describeEvent(committed[0]!.event, session.state, "tamsin"),
    /Bram set out from Ridge Camp for Aqueduct Mouth, but stopped after .+\.$/,
  );

  // Setting out again, the way is clear.
  assert.deepEqual(types(session.commit({ actorId: "bram", action: { type: "move", destinationId: "mouth" } })), ["character_moved"]);
  assert.equal(session.state.elapsedSeconds, 360);
});

test("a threat that strikes mid-turn ends the turn, but a check already under way completes first", () => {
  // Speech carries the clock past the threat: Mira never gets to leave.
  const speaking = new Session(threatWorld("sluice-speech", 5, { mira: "channel" }));
  const committed = speaking.commit({ speech: "Listen.", action: { type: "move", destinationId: "mouth" } });
  assert.deepEqual(types(committed), ["utterance", "threat_triggered"]);
  assert.equal(speaking.state.characters.find((character) => character.id === "mira")!.locationId, "channel");
  assert.equal(hp(speaking, "mira"), 8);

  // A check finishes, its consequences follow it, and then the overdue threat fires.
  const working = new Session(threatWorld("sluice-check", 100, { bram: "channel" }));
  const check = working.commit({ actorId: "bram", action: { type: "attempt_check", challengeId: "clear-rubble" } });
  assert.deepEqual(types(check), ["check_resolved", "threat_disarmed", "threat_triggered"]);
  assert.deepEqual(check.map(({ perceivers }) => perceivers), [["bram"], [], ["bram"]]);
  assert.deepEqual(check[2]!.event.data, {
    type: "threat_triggered", threatId: "sluice", at: 100, text: SLUICE_TEXT, locationIds: ["channel"],
    damage: [{ characterId: "bram", amount: 2 }], lockedRoutes: [], unlockedRoutes: [],
  });
  assert.equal(check[2]!.event.elapsedSeconds, 240);
  assert.equal(threatOf(working, "ceiling-collapse").status, "disarmed");
});

test("replay rejects threats and timing that contradict the world", () => {
  const seed = threatWorld("forged", 400, { mira: "channel" });
  const start = initialState(seed);
  const strike = {
    type: "threat_triggered" as const, threatId: "sluice", at: 400, text: SLUICE_TEXT, locationIds: ["channel"],
    damage: [{ characterId: "mira", amount: 2 }], lockedRoutes: [], unlockedRoutes: [],
  };
  const corrupt = errorCode("CORRUPT_STORAGE");
  // A wait that runs straight past the threat, and travel that does.
  assert.throws(() => applyEvent(start, nextEvent(start, { type: "time_advanced", actorId: "elowen", seconds: 600 })), corrupt);
  assert.throws(() => applyEvent(start, nextEvent(start, {
    type: "time_advanced", actorId: "elowen", seconds: 300, interruptedBy: "sluice",
  })), corrupt);
  assert.doesNotThrow(() => applyEvent(start, nextEvent(start, {
    type: "character_moved", actorId: "mira", fromId: "channel", destinationId: "mouth", seconds: 120,
  })), "the threat is still far off");
  const near = initialState(threatWorld("forged-near", 60));
  assert.throws(() => applyEvent(near, nextEvent(near, {
    type: "character_moved", actorId: "bram", fromId: "camp", destinationId: "mouth", seconds: 300,
  })), corrupt);
  // A threat that fires early.
  assert.throws(() => applyEvent(start, nextEvent(start, strike, { source: "engine", elapsedSeconds: 0 })), corrupt);

  const waited = applyEvent(start, nextEvent(start, { type: "time_advanced", actorId: "elowen", seconds: 400, interruptedBy: "sluice" }));
  // Once due, the threat fires before anything else happens, exactly as the world defines it, and only from the engine.
  assert.throws(() => applyEvent(waited, nextEvent(waited, {
    type: "utterance", actorId: "mira", locationId: "channel", seconds: 10, text: "Run!",
  })), corrupt);
  assert.throws(() => applyEvent(waited, nextEvent(waited, { ...strike, damage: [{ characterId: "mira", amount: 3 }] }, { source: "engine" })), corrupt);
  assert.throws(() => applyEvent(waited, nextEvent(waited, { ...strike, text: "A trickle." }, { source: "engine" })), corrupt);
  assert.throws(() => applyEvent(waited, nextEvent(waited, strike)), corrupt);
  assert.equal(applyEvent(waited, nextEvent(waited, strike, { source: "engine" })).characters[0]!.hp, 8);
});

test("a botched check sets a hidden consequence in motion, which strikes later unless the work is then done right", () => {
  const placed = { bram: "channel", elowen: "channel" };
  const session = new Session(threatWorld("collapse", 3000, placed));
  const botched = session.commit({ actorId: "bram", action: { type: "attempt_check", challengeId: "clear-rubble" } }, fixed(1));
  assert.deepEqual(types(botched), ["check_resolved", "threat_armed"]);
  assert.deepEqual(botched[1]!.event.data, { type: "threat_armed", threatId: "ceiling-collapse", challengeId: "clear-rubble", at: 540 });
  assert.equal(botched[1]!.event.source, "engine");
  assert.deepEqual(botched.map(({ perceivers }) => perceivers), [["bram", "elowen"], []]);
  assert.match(
    describeEvent(botched[1]!.event, session.state, null),
    /\(hidden\) "Shift the rubble fall" set threat "The channel ceiling gives way" in motion, due at /,
  );
  assert.equal(hp(session, "bram"), 11);

  const waited = session.commit({ actorId: "elowen", action: { type: "wait", seconds: 600 } });
  assert.deepEqual(waited.map(({ event }) => event.data), [
    { type: "time_advanced", actorId: "elowen", seconds: 300, interruptedBy: "ceiling-collapse" },
    {
      type: "threat_triggered", threatId: "ceiling-collapse", at: 540, text: COLLAPSE_TEXT, locationIds: ["channel"],
      damage: [{ characterId: "bram", amount: 2 }, { characterId: "elowen", amount: 2 }], lockedRoutes: [], unlockedRoutes: [],
    },
  ]);
  assert.deepEqual(waited[1]!.perceivers, ["bram", "elowen"]);
  assert.match(describeEvent(waited[1]!.event, session.state, "elowen"), /With a long grinding roar.+ Bram takes 2 damage\. You take 2 damage\.$/);
  assert.deepEqual([hp(session, "bram"), hp(session, "elowen")], [9, 6]);
  // Nobody perceived the hidden consequence; they only lived through what it caused.
  for (const id of ["mira", "bram", "elowen", "tamsin"]) {
    assert.ok(session.perceivedBy(id).every((event) => event.data.type !== "threat_armed"), `${id} perceived the hidden consequence`);
  }

  const redone = new Session(threatWorld("collapse-averted", 3000, placed));
  redone.commit({ actorId: "bram", action: { type: "attempt_check", challengeId: "clear-rubble" } }, fixed(1));
  const fixedUp = redone.commit({ actorId: "bram", action: { type: "attempt_check", challengeId: "clear-rubble" } }, fixed(20));
  assert.deepEqual(types(fixedUp), ["check_resolved", "threat_disarmed"]);
  assert.deepEqual(fixedUp[1]!.perceivers, []);
  assert.deepEqual(types(redone.commit({ actorId: "elowen", action: { type: "wait", seconds: 600 } })), ["time_advanced"]);
  assert.equal(threatOf(redone, "ceiling-collapse").status, "disarmed");
  assert.deepEqual([hp(redone, "bram"), hp(redone, "elowen")], [11, 8]);
});

test("a failure can close a way, and consequences must follow the check that caused them", () => {
  const seed = starterWorld("scree");
  seed.challenges.push({
    id: "loose-scree", name: "Climb the loose scree", locationId: "mouth", ability: "dexterity", difficulty: 15,
    seconds: 60, failureDamage: 0, onFailure: { lockRoutes: [{ fromId: "mouth", destinationId: "camp" }] }, resolved: false,
  });
  const session = new Session(seed);
  const [slip] = session.commit({ actorId: "elowen", action: { type: "attempt_check", challengeId: "loose-scree" } }, fixed(1));
  assert.ok(slip?.event.data.type === "check_resolved");
  assert.deepEqual(slip.event.data.effects, { unlockedRoutes: [], grantedItems: [], lockedRoutes: [{ fromId: "mouth", destinationId: "camp" }] });
  assert.match(describeEvent(slip.event, session.state, "elowen"), /The way from Aqueduct Mouth to Ridge Camp is now blocked\.$/);
  assert.throws(() => session.commit({ actorId: "elowen", action: { type: "move", destinationId: "camp" } }), errorCode("INVALID_ACTION"));

  // A consequence with no check behind it, or one the challenge does not list, is forged.
  const corrupt = errorCode("CORRUPT_STORAGE");
  const replayer = new Replayer();
  const start = initialState(starterWorld("forged-consequence"));
  replayer.apply(creationEvent(starterWorld("forged-consequence")));
  assert.throws(() => replayer.apply(nextEvent(start, {
    type: "threat_armed", threatId: "ceiling-collapse", challengeId: "clear-rubble", at: 300,
  }, { source: "engine" })), corrupt);
  const elsewhere = new Session(threatWorld("forged-after", 3000, { bram: "channel" }));
  const [check] = elsewhere.commit({ actorId: "bram", action: { type: "attempt_check", challengeId: "clear-rubble" } }, fixed(1));
  const forged = new Replayer();
  forged.apply(creationEvent(threatWorld("forged-after", 3000, { bram: "channel" })));
  forged.apply(check!.event);
  assert.throws(() => forged.apply(nextEvent(forged.state!, {
    type: "threat_disarmed", threatId: "ceiling-collapse", challengeId: "clear-rubble",
  }, { source: "engine", requestId: check!.event.requestId })), corrupt, "a failure cannot disarm");
  assert.throws(() => forged.apply(nextEvent(forged.state!, {
    type: "threat_armed", threatId: "ceiling-collapse", challengeId: "clear-rubble", at: 540,
  }, { source: "engine", requestId: "another-request" })), corrupt, "a consequence belongs to its check's request");
});

test("worlds must define the threats their challenges refer to, with timing that fits their status", () => {
  const broken = (change: (seed: WorldSeed) => void) => {
    const seed = starterWorld("broken");
    change(seed);
    return () => validateWorld(seed);
  };
  const threat = (seed: WorldSeed, id: string) => seed.threats!.find((entry) => entry.id === id)!;
  assert.doesNotThrow(broken(() => {}));
  assert.throws(broken((seed) => {
    seed.challenges[1]!.onFailure = { armThreats: ["flood"] };
  }), errorCode("INVALID_INPUT"));
  assert.throws(broken((seed) => {
    delete threat(seed, "sluice").at;
  }), errorCode("INVALID_INPUT"));
  assert.throws(broken((seed) => {
    threat(seed, "ceiling-collapse").at = 100;
  }), errorCode("INVALID_INPUT"));
  assert.throws(broken((seed) => {
    threat(seed, "sluice").locationIds = ["sewer"];
  }), errorCode("INVALID_INPUT"));
  assert.throws(broken((seed) => {
    seed.threats!.push({ ...threat(seed, "sluice") });
  }), errorCode("INVALID_INPUT"));
});

test("director steering is recorded outside the story, seen by nobody, and pending only until its target acts", () => {
  const session = new Session(starterWorld("steering"));
  const targeted = session.commit({ role: "director", action: { type: "steer", text: "Consider the scree slope.", targetId: "bram" } });
  assert.deepEqual(targeted.map(({ event, perceivers }) => [event.source, event.data, perceivers]), [
    ["director", { type: "steering", text: "Consider the scree slope.", targetId: "bram" }, []],
  ]);
  assert.equal(session.state.elapsedSeconds, 0);
  session.commit({ role: "director", action: { type: "steer", text: "Try another way in." } });
  assert.throws(
    () => session.commit({ role: "director", action: { type: "steer", text: "Hurry.", targetId: "nobody" } }),
    errorCode("INVALID_ACTION"),
  );
  assert.throws(() => session.commit({ role: "director", action: { type: "steer", text: "x".repeat(1001) } }), errorCode("INVALID_INPUT"));
  assert.equal(
    describeEvent(targeted[0]!.event, session.state, null),
    "[0:00:00] Director, outside the story, to Bram: Consider the scree slope.",
  );

  assert.deepEqual(pendingSteering(session.events, "bram"), ["Consider the scree slope.", "Try another way in."]);
  assert.deepEqual(pendingSteering(session.events, "mira"), ["Try another way in."]);
  assert.deepEqual(turnHistory(session.events, session.state), []);
  session.commit({ actorId: "bram", speech: "Hm." });
  assert.deepEqual(pendingSteering(session.events, "bram"), []);
  assert.deepEqual(pendingSteering(session.events, "mira"), ["Try another way in."]);
  for (const id of ["mira", "bram", "elowen", "tamsin"]) {
    assert.ok(session.perceivedBy(id).every((event) => event.data.type !== "steering"), `${id} perceived steering`);
  }
});

test("the director can introduce an in-world event, perceived and remembered where it happens", () => {
  const session = new Session(starterWorld("introduced"));
  const text = "A cold wind comes up from the aqueduct, and somewhere below, iron scrapes on stone.";
  const opened = { fromId: "mouth", destinationId: "channel" };
  const [wind] = session.commit({
    role: "director", action: { type: "introduce", text, locationIds: ["camp"], unlockRoutes: [opened] },
  });
  assert.deepEqual(wind!.event.data, { type: "introduced", text, locationIds: ["camp"], lockedRoutes: [], unlockedRoutes: [opened] });
  assert.equal(wind!.event.source, "director");
  assert.deepEqual(wind!.perceivers, ["bram", "mira", "tamsin"]);
  assert.equal(session.state.locations[1]!.routes[1]!.locked, false);
  assert.match(describeEvent(wind!.event, session.state, "mira"), /^\[0:00:00\] A cold wind .+ The way from Aqueduct Mouth to Dry Channel is now open\.$/);
  assert.match(describeEvent(wind!.event, session.state, null), /^\[0:00:00\] Introduced by the director: A cold wind/);
  const [everywhere] = session.commit({ role: "director", action: { type: "introduce", text: "Thunder rolls over the ridge." } });
  assert.deepEqual(everywhere!.perceivers, ["bram", "elowen", "mira", "tamsin"]);
  assert.deepEqual(turnHistory(session.events, session.state), [], "director events are nobody's turn");

  const refused = (action: Record<string, unknown>) => () => session.commit({ role: "director", action: { type: "introduce", text, ...action } });
  assert.throws(refused({ locationIds: ["sewer"] }), errorCode("INVALID_ACTION"));
  assert.throws(refused({ lockRoutes: [{ fromId: "camp", destinationId: "cistern" }] }), errorCode("INVALID_ACTION"));
  assert.throws(refused({ lockRoutes: [opened], unlockRoutes: [opened] }), errorCode("INVALID_ACTION"));
  assert.throws(refused({ text: "x".repeat(2001) }), errorCode("INVALID_INPUT"));

  const state = session.state;
  const forged = { type: "introduced" as const, text, lockedRoutes: [{ fromId: "camp", destinationId: "cistern" }], unlockedRoutes: [] };
  assert.throws(() => applyEvent(state, nextEvent(state, forged, { source: "director" })), errorCode("CORRUPT_STORAGE"));
  assert.throws(() => applyEvent(state, nextEvent(state, { ...forged, lockedRoutes: [] })), errorCode("CORRUPT_STORAGE"));
});

test("replay accepts a retcon only of words, only once, reaching exactly who perceived them", () => {
  const session = new Session(starterWorld("retcon"));
  session.commit({ speech: "The bars are rotten through." });
  session.commit({ actorId: "elowen", action: { type: "wait", seconds: 60 } });
  const [said, waited] = session.events as [AdventureEvent, AdventureEvent];
  const replay = () => {
    const replayer = new Replayer();
    replayer.apply(creationEvent(starterWorld("retcon")));
    for (const event of session.events) replayer.apply(event);
    return replayer;
  };
  const retraction = (replayer: Replayer, targetSequence: number) => nextEvent(replayer.state!, {
    type: "retraction", targetSequence, text: "Mira said nothing about the bars.",
  }, { source: "director" });
  const replayer = replay();
  assert.deepEqual(replayer.apply(retraction(replayer, said.sequence)), session.perceivers.get(said.sequence));
  assert.throws(() => replayer.apply(retraction(replayer, said.sequence)), errorCode("CORRUPT_STORAGE"), "only once");
  const other = replay();
  assert.throws(() => other.apply(retraction(other, waited.sequence)), errorCode("CORRUPT_STORAGE"), "a wait is not words");
  assert.throws(() => other.apply(retraction(other, 99)), errorCode("CORRUPT_STORAGE"));
  const forgedSource = nextEvent(other.state!, { type: "retraction", targetSequence: said.sequence, text: "No." });
  assert.throws(() => other.apply(forgedSource), errorCode("CORRUPT_STORAGE"));
});

test("replay lets a line be reworded again and again until it is deleted, and an edit or a plain delete reaches nobody", () => {
  const session = new Session(starterWorld("edits"));
  session.commit({ speech: "Bram, the bars are rotten through.", addresseeId: "bram" });
  session.commit({ actorId: "elowen", action: { type: "wait", seconds: 60 } });
  const [said, waited] = session.events as [AdventureEvent, AdventureEvent];
  const replayer = new Replayer();
  replayer.apply(creationEvent(starterWorld("edits")));
  for (const event of session.events) replayer.apply(event);
  const retcon = (data: { targetSequence: number; text?: string; replacement?: string }) => (
    nextEvent(replayer.state!, { type: "retraction", ...data }, { source: "director" })
  );
  assert.deepEqual(replayer.apply(retcon({ targetSequence: said.sequence, replacement: "The bars look solid." })), [], "an edit reaches nobody");
  assert.deepEqual(replayer.apply(retcon({ targetSequence: said.sequence, replacement: "The bars might give." })), [], "and can be made again");
  assert.throws(() => replayer.apply(retcon({ targetSequence: said.sequence, replacement: "x".repeat(701) })), errorCode("CORRUPT_STORAGE"),
    "speech keeps its own limit");
  assert.throws(() => replayer.apply(retcon({ targetSequence: waited.sequence, replacement: "Elowen waits." })), errorCode("CORRUPT_STORAGE"),
    "a wait has no words to change");
  const deletion = retcon({ targetSequence: said.sequence });
  assert.deepEqual(replayer.apply(deletion), [], "a plain delete reaches nobody");
  assert.throws(() => replayer.apply(retcon({ targetSequence: said.sequence, replacement: "Again." })), errorCode("CORRUPT_STORAGE"),
    "nothing changes a deleted line");
  assert.throws(() => replayer.apply(retcon({ targetSequence: said.sequence, text: "No." })), errorCode("CORRUPT_STORAGE"));
  // A deleted line addressed nobody, so nobody is due to answer it.
  assert.equal(turnHistory(session.events, session.state)[0]!.addresseeId, "bram");
  assert.equal(turnHistory([...session.events, deletion], session.state)[0]!.addresseeId, null);
  // New words and a correction are two different retcons.
  const both = { role: "director", requestId: "both", expectedRevision: 3, action: { type: "retcon", sequence: 2, text: "No.", replacement: "Yes." } };
  assert.equal(commandSchema.safeParse(both).success, false);
  assert.equal(commandSchema.safeParse({ ...both, action: { type: "retcon", sequence: 2 } }).success, true);
});

let turnCount = 0;
function turn(actorId: string, extra: Partial<TurnRecord> = {}): TurnRecord {
  turnCount += 1;
  return { requestId: `t${turnCount}`, actorId, npc: actorId === "tamsin", addresseeId: null, acted: false, endedAt: 0, ...extra };
}

test("an NPC with an agenda speaks up when its time comes and someone is there to hear, never twice running", () => {
  const state = initialState(starterWorld("agendas"));
  const later = { ...state, elapsedSeconds: 1000 };
  const agendas = new Map([["tamsin", 900]]);
  assert.deepEqual(dueAgendas([], state, agendas), []);
  assert.deepEqual(dueAgendas([], later, agendas), ["tamsin"]);
  assert.deepEqual(dueAgendas([turn("tamsin", { endedAt: 500 })], later, agendas), []);
  assert.deepEqual(dueAgendas([turn("tamsin", { endedAt: 100 })], later, agendas), ["tamsin"]);
  assert.deepEqual(dueAgendas([], later, new Map()), []);
  const alone = {
    ...later,
    characters: later.characters.map((character) => (character.npc ? character : { ...character, locationId: "mouth" })),
  };
  assert.deepEqual(dueAgendas([], alone, agendas), []);
  const asleep = { ...later, characters: later.characters.map((character) => (character.npc ? { ...character, hp: 0 } : character)) };
  assert.deepEqual(dueAgendas([], asleep, agendas), []);

  const agents = ["mira", "bram", "elowen"];
  const npcs = new Set(["tamsin"]);
  assert.equal(chooseNextActor([turn("mira")], agents, npcs, ["tamsin"]), "tamsin");
  assert.equal(chooseNextActor([turn("mira"), turn("tamsin")], agents, npcs, ["tamsin"]), "bram");
  // Whoever was spoken to answers first, and an agent left out for a full round goes before the agenda.
  assert.equal(chooseNextActor([turn("mira", { addresseeId: "elowen" })], agents, npcs, ["tamsin"]), "elowen");
  assert.equal(
    chooseNextActor([turn("elowen"), turn("mira"), turn("bram"), turn("mira", { addresseeId: "bram" })], agents, npcs, ["tamsin"]),
    "elowen",
  );
});

test("a stalled group is nudged, then required to act; NPC turns neither stall nor unstall it", () => {
  const policy = { nudgeAfter: 2, requireActionAfter: 3 };
  const direction = (turns: TurnRecord[]) => {
    const { stalled, nudge, requireAction } = turnDirection(turns, [], "mira", policy);
    return { stalled, nudge, requireAction };
  };
  assert.deepEqual(direction([turn("mira")]), { stalled: 1, nudge: false, requireAction: false });
  assert.deepEqual(direction([turn("mira"), turn("bram")]), { stalled: 2, nudge: true, requireAction: false });
  assert.deepEqual(direction([turn("mira"), turn("tamsin"), turn("bram"), turn("tamsin", { acted: true }), turn("elowen")]), {
    stalled: 3, nudge: true, requireAction: true,
  });
  assert.deepEqual(direction([turn("mira"), turn("bram"), turn("elowen", { acted: true })]), { stalled: 0, nudge: false, requireAction: false });
  assert.deepEqual(turnDirection([turn("mira"), turn("bram"), turn("elowen")], [], "mira", { nudgeAfter: 0, requireActionAfter: 0 }), {
    stalled: 3, nudge: false, requireAction: false, steering: [], conversation: false,
  });
});

test("metrics count stalls, threats, and steering", () => {
  const seed = threatWorld("metrics", 3000, { bram: "channel", elowen: "channel" });
  const session = new Session(seed);
  session.commit({ role: "director", action: { type: "steer", text: "Get moving." } });
  session.commit({ actorId: "mira", speech: "Well?" });
  session.commit({ actorId: "bram", speech: "Give me a moment." });
  session.commit({ actorId: "bram", action: { type: "attempt_check", challengeId: "clear-rubble" } }, fixed(1));
  session.commit({ actorId: "elowen", action: { type: "wait", seconds: 600 } });
  const events = [creationEvent(seed), ...session.events];
  const metrics = computeMetrics(events, [], session.state);
  assert.deepEqual([metrics.longestStall, metrics.threatsFired, metrics.steeringRequests], [2, 1, 1]);
});

const connectionString = process.env.TEST_DATABASE_URL;

const none = {
  destinationId: null, recipientId: null, itemId: null, quantity: null, challengeId: null, intent: null, minutes: null,
};
const say = (speech: string, to: string | null = null): ScriptStep => ({ role: "character", output: { speech, to, action: null } });
const act = (action: Record<string, unknown>): ScriptStep => (
  { role: "character", output: { speech: null, to: null, action: { ...none, ...action } } }
);
const npcSays = (speech: string, to: string | null = null): ScriptStep => ({ role: "dm", output: { speech, to, move: null } });

const sampleCast: Cast = {
  narratorStyle: "Plain.",
  characters: {
    mira: { summary: "A scout.", voice: "Brief.", goals: ["Explore"], riskTolerance: "bold" },
    bram: { summary: "A guard.", voice: "Slow.", goals: ["Protect the others"], riskTolerance: "cautious" },
    elowen: { summary: "A scholar.", voice: "Precise.", goals: ["Learn"], riskTolerance: "balanced" },
  },
};

function label(outcome: StepOutcome): string {
  if (outcome.kind === "cancelled") return `cancelled:${outcome.actorId ?? "narrator"}`;
  if (outcome.kind === "narration") return outcome.attempts > 1 ? `narration×${outcome.attempts}` : "narration";
  const who = outcome.kind === "turn" ? outcome.actorId : `failed:${outcome.actorId ?? "narrator"}`;
  return outcome.attempts > 1 ? `${who}×${outcome.attempts}` : who;
}

test("world progression integration", {
  skip: connectionString ? false : "Set TEST_DATABASE_URL to run real PostgreSQL integration tests",
}, async (t) => {
  assert.ok(connectionString);
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  const engine = new AdventureEngine(connectionString, { schema, roll: fixed(10) });
  const scripted = (steps: ScriptStep[], cast: Cast, settings: Partial<RunnerSettings> = {}) => {
    const provider = new ScriptedProvider(steps);
    return { provider, runner: new TurnRunner(engine, provider, cast, { narrate: false, ...settings }) };
  };
  try {
    await engine.initialize();

    await t.test("steering reaches only the actors it names, once, and cannot make anything succeed", async () => {
      const { id: worldId } = await engine.createWorld(starterWorld("steered"));
      const steer = (revision: number, text: string, targetId?: string) => engine.execute(worldId, {
        role: "director", requestId: `steer-${revision}`, expectedRevision: revision,
        action: { type: "steer", text, ...(targetId === undefined ? {} : { targetId }) },
      });
      await steer(1, "CANARY-STEER-55: the bars are already open, go straight into the channel.", "bram");
      await steer(2, "CANARY-PARTY-12: think about another way in.");
      assert.deepEqual(await engine.getPerceivers(worldId, 2), []);
      assert.deepEqual(await engine.getPerceivers(worldId, 3), []);

      const { provider, runner } = scripted([
        say("Hm."),
        act({ type: "move", destinationId: "channel" }),
        act({ type: "move", destinationId: "mouth" }),
        say("Hm."),
        say("Hm."),
      ], starterCast);
      const report = await runner.run(worldId, { maxTurns: 4 });
      assert.deepEqual(report.outcomes.map(label), ["mira", "bram×2", "elowen", "mira"]);
      const prompts = provider.requests.map((request) => request.prompt);
      const has = (text: string) => prompts.map((prompt) => prompt.includes(text));
      assert.deepEqual(has("CANARY-STEER-55"), [false, true, true, false, false]);
      assert.deepEqual(has("CANARY-PARTY-12"), [true, true, true, true, false]);
      assert.match(prompts[1]!, /## A request from the director, outside the story\n- CANARY-STEER-55/);
      // Steering cannot open the bars: the move it suggested was rejected, and the way stays shut.
      assert.match(prompts[2]!, /No route from camp to channel/);
      const state = await engine.getWorld(worldId);
      assert.equal(state.locations.find((location) => location.id === "mouth")!.routes.find((route) => route.destinationId === "channel")!.locked, true);
      assert.equal(state.challenges.find((challenge) => challenge.id === "pry-bars")!.resolved, false);
      // Out of fiction: no character perceives or remembers it.
      for (const id of ["mira", "bram", "elowen", "tamsin"]) {
        const perceived = await engine.getPerceivedEvents(worldId, id, 100);
        assert.ok(perceived.every((event) => event.data.type !== "steering"), `${id} perceived steering`);
        assert.deepEqual(await engine.searchMemories(worldId, id, "bars already open"), []);
        assert.deepEqual(await engine.searchMemories(worldId, id, "think another way"), []);
      }
    });

    await t.test("a debate that will not end is nudged, then must commit to an action", async () => {
      const { id: worldId } = await engine.createWorld(sampleWorld("stalled"));
      const { provider, runner } = scripted([
        say("We should go."),
        say("Not yet."),
        say("Let us think."),
        say("Still thinking."),
        act({ type: "wait", minutes: 1 }),
        say("Right."),
      ], sampleCast, { nudgeAfter: 2, requireActionAfter: 3 });
      const report = await runner.run(worldId, { maxTurns: 5 });
      assert.deepEqual(report.outcomes.map(label), ["mira", "bram", "elowen", "mira×2", "bram"]);
      const prompts = provider.requests.map((request) => request.prompt);
      const has = (text: string) => prompts.map((prompt) => prompt.includes(text));
      assert.deepEqual(has("## The group is going in circles"), [false, false, true, false, false, false]);
      assert.deepEqual(has("This turn you must take an action"), [false, false, false, true, true, false]);
      assert.deepEqual(has("Or take no action and only speak."), [true, true, true, false, false, true]);
      assert.match(prompts[4]!, /Take an action this turn: nobody has acted for 3 turns/);
      const events = await engine.getEvents(worldId);
      assert.deepEqual(events.at(-2)?.data, { type: "time_advanced", actorId: "mira", seconds: 60 });
    });

    await t.test("a long debate with no action stops the run", async () => {
      const { id: worldId } = await engine.createWorld(sampleWorld("backstop"));
      const { runner } = scripted([say("One."), say("Two."), say("Three.")], sampleCast, {
        nudgeAfter: 0, requireActionAfter: 0, stallTurns: 3,
      });
      const report = await runner.run(worldId, { maxTurns: 10 });
      assert.equal(report.stopReason, "stalled");
      assert.equal(report.turns, 3);
    });

    await t.test("an NPC with an agenda speaks up once time has passed, prompted by its own aims", async () => {
      const { id: worldId } = await engine.createWorld(starterWorld("agenda"));
      const tamsin = starterCast.npcs!.tamsin!;
      const cast: Cast = { ...starterCast, npcs: { tamsin: { ...tamsin, agenda: { everyMinutes: 1, aims: tamsin.agenda!.aims } } } };
      const { provider, runner } = scripted([
        act({ type: "wait", minutes: 2 }),
        npcSays("Going down that channel? Mind the sluice.", "bram"),
        say("Noted."),
        say("Hm."),
      ], cast);
      const report = await runner.run(worldId, { maxTurns: 4 });
      assert.deepEqual(report.outcomes.map(label), ["mira", "tamsin", "bram", "elowen"]);
      assert.match(provider.requests[1]!.prompt, /Nobody has spoken to you, but you have aims of your own/);
      assert.match(provider.requests[1]!.system, /What you work toward, and bring up unprompted: Warn anyone heading for the channel about the sluice/);
      assert.equal(provider.remaining, 0);
    });

    await t.test("a threat strikes during a run: those it hits see it next turn, others never do, and nobody narrates it", async () => {
      const { id: worldId } = await engine.createWorld(threatWorld("struck", 15, { mira: "channel", elowen: "channel" }));
      const { provider, runner } = scripted([say("Listen."), say("What is it?"), say("Water!")], starterCast, { narrate: true });
      const report = await runner.run(worldId, { maxTurns: 3 });
      assert.deepEqual(report.outcomes.map(label), ["mira", "bram", "elowen"]);
      assert.equal(provider.remaining, 0);
      const events = await engine.getEvents(worldId);
      const strike = events.find((event) => event.data.type === "threat_triggered")!;
      assert.equal(strike.source, "engine");
      assert.equal(strike.requestId, events[strike.sequence - 2]!.requestId, "the threat belongs to Bram's turn");
      assert.deepEqual(await engine.getPerceivers(worldId, strike.sequence), ["elowen", "mira"]);
      assert.match(provider.requests[2]!.prompt, /Iron groans .+ Mira takes 2 damage\. You take 2 damage\./);
      assert.ok((await engine.getPerceivedEvents(worldId, "bram", 100)).every((event) => event.data.type !== "threat_triggered"));
      const state = await engine.getWorld(worldId);
      assert.deepEqual(await engine.replayWorld(worldId), state);
      assert.equal(computeMetrics(events, await engine.getTraces(worldId, 50), state).threatsFired, 1);
    });
  } finally {
    await engine.close();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
