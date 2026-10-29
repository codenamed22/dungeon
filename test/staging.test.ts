import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { outageCast, outageWorld } from "../src/adventures/outage.ts";
import { starterCast, starterWorld } from "../src/adventures/starter.ts";
import { describeEvent, renderJudgingPrompt, renderNpcPrompt, renderRulingPrompt } from "../src/agents/context.ts";
import { npcSystemPrompt, refereeSystemPrompt } from "../src/agents/prompts.ts";
import { npcTurnSchema, toNpcParts, toRuling } from "../src/agents/protocol.ts";
import { ScriptedProvider } from "../src/agents/provider.ts";
import type { ScriptStep } from "../src/agents/provider.ts";
import { TurnRunner } from "../src/agents/runner.ts";
import { chooseNextActor, dueAgendas, togetherIn } from "../src/agents/schedule.ts";
import { draftProblems, remove, upsertCharacter, upsertThreat } from "../src/creator/operations.ts";
import type { Draft } from "../src/creator/operations.ts";
import { AdventureEngine } from "../src/engine.ts";
import { beliefsOf } from "../src/memory.ts";
import { commandSchema, parseInput } from "../src/model.ts";
import type { AdventureEvent, EventData, WorldSeed } from "../src/model.ts";
import { availableActions, perceive } from "../src/perception.ts";
import { checkRuling, Replayer } from "../src/rules.ts";
import { creationEvent, errorCode, fixed, nextEvent, Session } from "./support.ts";

// Characters coming into the scene and leaving it: by the director, by a
// threat, by a referee's ruling, or by a supporting character's own choice.

const types = (committed: { event: AdventureEvent }[]) => committed.map(({ event }) => event.data.type);
const corrupt = errorCode("CORRUPT_STORAGE");
const invalid = errorCode("INVALID_ACTION");

/** The starter world with some characters away from the scene at the start. */
function withAway(seed: WorldSeed, ...ids: string[]): WorldSeed {
  return { ...seed, characters: seed.characters.map((character) => (ids.includes(character.id) ? { ...character, away: true as const } : character)) };
}

const who = (session: Session, id: string) => session.state.characters.find((character) => character.id === id)!;

test("the director sends someone away and brings them back, and only those there see it", () => {
  const session = new Session(starterWorld("directed"));
  const exit = session.commit({ role: "director", action: { type: "exit", characterId: "bram", text: "Bram heads back down the trail." } });
  assert.deepEqual(types(exit), ["character_exited"]);
  assert.equal(exit[0]!.event.source, "director");
  assert.deepEqual(exit[0]!.perceivers, ["bram", "mira", "tamsin"]);
  assert.equal(who(session, "bram").away, true);
  assert.equal(who(session, "bram").locationId, "camp", "an away character keeps its last place");

  // Away, Bram cannot act, be spoken to, be handed anything, or perceive what happens.
  assert.throws(() => session.commit({ actorId: "bram", speech: "Hello?" }), /bram is away from the scene/);
  assert.throws(() => session.commit({ speech: "Bram?", addresseeId: "bram" }), /bram is not here to hear mira/);
  assert.throws(() => session.commit({ action: { type: "transfer_item", recipientId: "bram", itemId: "rope", quantity: 1 } }), invalid);
  assert.deepEqual(session.commit({ speech: "Just us now." })[0]!.perceivers, ["mira", "tamsin"]);
  assert.deepEqual(perceive(session.state, "mira").present.map((other) => other.id), ["tamsin"]);
  assert.deepEqual(availableActions(session.state, "bram").move, []);
  assert.equal(availableActions(session.state, "bram").intent, false);

  assert.throws(() => session.commit({ role: "director", action: { type: "exit", characterId: "bram" } }), /already away/);
  assert.throws(() => session.commit({ role: "director", action: { type: "enter", characterId: "mira", locationId: "camp" } }), /already in the scene/);
  assert.throws(() => session.commit({ role: "director", action: { type: "enter", characterId: "bram", locationId: "sewer" } }), /Unknown location/);

  const enter = session.commit({ role: "director", action: { type: "enter", characterId: "bram", locationId: "mouth" } });
  assert.deepEqual(enter[0]!.perceivers, ["bram", "elowen"], "an entrance is seen where it happens");
  assert.equal(who(session, "bram").away, undefined);
  assert.equal(who(session, "bram").locationId, "mouth");
  assert.equal(
    describeEvent(enter[0]!.event, session.state, null),
    "[0:00:10] Brought in by the director: Bram arrived at Aqueduct Mouth.",
  );
  assert.equal(describeEvent(exit[0]!.event, session.state, "mira"), "[0:00:00] Bram heads back down the trail. Bram has left the scene.");
  assert.equal(describeEvent(exit[0]!.event, session.state, "bram"), "[0:00:00] Bram heads back down the trail. You have left the scene.");
});

test("a threat brings someone in and sends someone away, and an away character is out of harm's way", () => {
  const seed = withAway(starterWorld("staged-threat"), "tamsin");
  seed.threats = [
    ...seed.threats!.filter((threat) => threat.status === "waiting"),
    {
      id: "arrival", name: "Tamsin arrives", text: "Old Tamsin comes up the path with a lamp; Bram is called away to the goats.",
      locationIds: ["camp"], enters: [{ characterId: "tamsin", locationId: "camp" }], exits: ["bram"], status: "armed", at: 60,
    },
    { id: "rockfall", name: "Rockfall", text: "Stones rattle down onto the camp.", locationIds: ["camp"], damage: 1, status: "armed", at: 120 },
  ];
  const session = new Session(seed);
  assert.deepEqual(perceive(session.state, "mira").present.map((other) => other.id), ["bram"], "Tamsin starts away");
  const committed = session.commit({ action: { type: "wait", seconds: 600 } });
  assert.deepEqual(types(committed), [
    "time_advanced", "threat_triggered", "character_entered", "character_exited",
  ]);
  assert.deepEqual(committed.slice(1).map(({ event }) => event.source), ["engine", "engine", "engine"]);
  assert.deepEqual(committed[1]!.perceivers, ["bram", "mira"], "Tamsin arrives only after the threat");
  assert.deepEqual(committed[2]!.perceivers, ["bram", "mira", "tamsin"]);
  assert.deepEqual(committed[3]!.perceivers, ["bram", "mira", "tamsin"]);
  assert.equal(who(session, "tamsin").away, undefined);
  assert.equal(who(session, "bram").away, true);

  const rockfall = session.commit({ action: { type: "wait", seconds: 600 } });
  const strike = rockfall.find(({ event }) => event.data.type === "threat_triggered")!.event.data;
  assert.ok(strike.type === "threat_triggered");
  assert.deepEqual(strike.damage.map((entry) => entry.characterId), ["mira", "tamsin"], "Bram is away, so the rocks miss him");
  assert.equal(who(session, "bram").hp, 14);

  // Mira remembers where each went.
  const beliefs = beliefsOf("mira", session.perceivedBy("mira"), session.state);
  const location = (about: string) => beliefs.find((topic) => topic.about === about && topic.attribute === "location")?.current.value;
  assert.equal(location("tamsin"), "Ridge Camp");
  assert.equal(location("bram"), "away; left the scene");
});

test("an ending a threat reaches comes after the entrances it causes", () => {
  const seed = withAway(starterWorld("staged-ending"), "tamsin");
  seed.threats = [...seed.threats!.filter((threat) => threat.status === "waiting"), {
    id: "arrival", name: "Tamsin arrives", text: "Old Tamsin arrives.", enters: [{ characterId: "tamsin", locationId: "camp" }],
    status: "armed", at: 60,
  }];
  seed.endings = [{ id: "found", name: "Found", text: "Tamsin takes them home.", when: { threatId: "arrival" } }];
  const session = new Session(seed);
  assert.deepEqual(types(session.commit({ action: { type: "wait", seconds: 120 } })), [
    "time_advanced", "threat_triggered", "character_entered", "story_ended",
  ]);
});

test("a ruling brings in someone away, or sends a supporting character off, only when the attempt works", () => {
  const session = new Session(withAway(starterWorld("summoned"), "tamsin"));
  const call = { type: "attempt", intent: "shout down to Old Tamsin's hut" };
  // A check that fails brings nobody.
  const failed = session.commit({
    action: call,
    ruling: { decision: "new", name: "Make yourself heard", ability: "strength", difficulty: "moderate", failureDamage: 0, seconds: 60, reason: "The wind is up.", bringsIn: "tamsin" },
  }, fixed(1));
  assert.deepEqual(types(failed), ["ruling", "check_resolved"]);
  assert.equal(who(session, "tamsin").away, true);
  const worked = session.commit({
    action: call,
    ruling: { decision: "new", name: "Shout louder", ability: "strength", difficulty: "moderate", failureDamage: 0, seconds: 60, reason: "Louder.", bringsIn: "tamsin" },
  }, fixed(20));
  assert.deepEqual(types(worked), ["ruling", "check_resolved", "character_entered"]);
  assert.equal(who(session, "tamsin").locationId, "camp", "they arrive where the actor is");

  const shooed = session.commit({
    action: { type: "attempt", intent: "ask Tamsin to give us a moment alone" },
    ruling: { decision: "automatic", seconds: 60, reason: "Mira asks politely.", sendsOut: "tamsin" },
  });
  assert.deepEqual(types(shooed), ["ruling", "character_exited"]);
  assert.deepEqual(shooed[1]!.perceivers, ["bram", "mira", "tamsin"]);

  const ruling = (extra: Record<string, unknown>) => ({ decision: "automatic" as const, seconds: 60, reason: "Fine.", ...extra });
  assert.match(checkRuling(session.state, "mira", "send Bram home", ruling({ sendsOut: "bram" }))!, /only they can be sent away/);
  assert.match(checkRuling(session.state, "mira", "call Bram", ruling({ bringsIn: "bram" }))!, /not away from the scene/);
  assert.match(checkRuling(session.state, "mira", "send Tamsin off", ruling({ sendsOut: "tamsin" }))!, /not a supporting character here/);
  assert.equal(checkRuling(session.state, "mira", "fetch Tamsin back", ruling({ bringsIn: "tamsin" })), null);
});

test("a supporting character may leave after speaking, and only then", () => {
  const session = new Session(starterWorld("leaving"));
  const left = session.commit({ role: "npc", actorId: "tamsin", speech: "I'm for my bed.", leave: true });
  assert.deepEqual(left.map(({ event }) => [event.source, event.data.type]), [["dm", "utterance"], ["dm", "character_exited"]]);
  assert.equal(who(session, "tamsin").away, true);
  const command = (extra: Record<string, unknown>) => () => parseInput(commandSchema, {
    role: "npc", requestId: "x", expectedRevision: 1, actorId: "tamsin", ...extra,
  });
  assert.throws(command({ leave: true }), /leaves the scene after speaking/);
  assert.throws(command({ speech: "Bye.", leave: true, destinationId: "mouth" }), /without walking anywhere/);
  assert.throws(() => toNpcParts(npcTurnSchema.parse({ speech: "Bye.", to: null, move: "mouth", leave: true })), /not both/);
  assert.deepEqual(toNpcParts(npcTurnSchema.parse({ speech: "Bye.", to: null, move: null, leave: true })), { speech: "Bye.", leave: true });
  assert.deepEqual(toNpcParts({ speech: "Hi.", to: null, move: null }), { speech: "Hi." }, "older outputs without leave still parse");
});

test("replay rejects an entrance or exit without its cause", () => {
  const seed = withAway(starterWorld("forged-staging"), "tamsin");
  const fresh = () => {
    const replayer = new Replayer();
    replayer.apply(creationEvent(seed));
    return replayer;
  };
  const forge = (data: EventData, source: AdventureEvent["source"]) => {
    const replayer = fresh();
    return () => replayer.apply(nextEvent(replayer.state!, data, { source }));
  };
  const enterTamsin: EventData = { type: "character_entered", characterId: "tamsin", locationId: "camp" };
  assert.throws(forge(enterTamsin, "engine"), /must follow the threat, ruling, or words/);
  assert.throws(forge(enterTamsin, "dm"), corrupt);
  assert.throws(forge({ type: "character_exited", characterId: "bram", locationId: "camp" }, "dm"), corrupt, "only an NPC leaves on its own");
  assert.throws(forge({ type: "character_entered", characterId: "bram", locationId: "camp" }, "director"), /Only someone away/);
  assert.throws(forge({ type: "character_exited", characterId: "bram", locationId: "mouth" }, "director"), /from where they are/);
  assert.doesNotThrow(forge(enterTamsin, "director"));

  // An NPC's exit must follow its own words in the same request.
  const present = new Replayer();
  present.apply(creationEvent(starterWorld("forged-leave")));
  assert.throws(() => present.apply(nextEvent(present.state!, { type: "character_exited", characterId: "tamsin", locationId: "camp" }, { source: "dm" })), corrupt);
});

test("the referee sees who is away and the challenges elsewhere, but never what those challenges take", () => {
  const seed = withAway(outageWorld("referee-view"), "wen");
  seed.challenges = seed.challenges.map((challenge) => (
    challenge.id === "inspect-certificate" ? { ...challenge, criteria: "CANARY-CRITERIA-31" } : challenge
  ));
  const session = new Session(seed);
  const intent = renderJudgingPrompt(session.state, "priya", { intent: "look at the gateway certificate" }, [], [], []);
  assert.match(intent, /## Away from the scene\n- Wen \(wen\)\n- Sloane \(sloane\)/);
  assert.match(intent, /Supporting characters here: Morgan \(morgan\)\./);
  assert.match(intent, /## Challenges elsewhere \(only to point the way\)\n(- .*\n)*- Inspect the gateway's certificate, at Gateway console: /);
  assert.doesNotMatch(intent, /CANARY-CRITERIA-31/);
  const listed = renderJudgingPrompt(session.state, "priya", { challengeId: "get-access" }, [], [], []);
  assert.doesNotMatch(listed, /Challenges elsewhere|Away from the scene/, "a listed challenge needs no pointers");

  const dice = new Session(withAway(starterWorld("dice-view"), "tamsin"));
  assert.match(renderRulingPrompt(dice.state, "mira", "call for Tamsin", [], []), /## Away from the scene\n- Old Tamsin \(tamsin\)/);
  for (const system of [refereeSystemPrompt(), refereeSystemPrompt({ rules: { outcomes: "judgment", stats: null, health: null } })]) {
    assert.match(system, /name them in bringsIn or sendsOut/);
    assert.match(system, /really one of the challenges elsewhere, rule it impossible here/);
    assert.match(system, /"bringsIn": "<ID>" or null, "sendsOut": "<ID>" or null/);
  }
  const ruled = toRuling({ decision: "automatic", challengeId: null, name: null, ability: null, difficulty: null, failureDamage: null, minutes: 1, reason: "Mira pages her.", bringsIn: " wen ", sendsOut: null });
  assert.deepEqual(ruled, { kind: "ruling", ruling: { decision: "automatic", seconds: 60, reason: "Mira pages her.", bringsIn: "wen" } });

  const npc = renderNpcPrompt(perceive(session.state, "morgan"), [], []);
  assert.match(npc, /Set "leave" to true only if you leave the scene now/);
  assert.match(npcSystemPrompt("Morgan", outageCast.npcs!.morgan!), /Or you may leave the scene after speaking/);
});

test("the scheduler passes over anyone away", () => {
  const session = new Session(starterWorld("schedule-away"));
  session.commit({ role: "director", action: { type: "exit", characterId: "tamsin" } });
  assert.equal(togetherIn(session.state)("mira", "tamsin"), false);
  assert.deepEqual(dueAgendas([], { ...session.state, elapsedSeconds: 100_000 }, new Map([["tamsin", 60]])), []);
  const turns = [{ requestId: "r", actorId: "mira", npc: false, addresseeId: "tamsin", acted: false, endedAt: 10 }];
  assert.equal(chooseNextActor(turns, ["mira", "bram"], new Set(["tamsin"]), [], togetherIn(session.state)), "bram");
});

test("the creator stages entrances and exits, and warns when nobody can start", () => {
  const draft: Draft = { seed: structuredClone(outageWorld("draft")), cast: structuredClone(outageCast) } as Draft;
  const apply = (result: ReturnType<typeof upsertCharacter>) => {
    assert.equal(typeof result, "object");
    if (typeof result !== "object" || !("draft" in result)) throw new Error(String(result));
    Object.assign(draft, result.draft);
    return result.summary;
  };
  assert.deepEqual(draftProblems(draft).filter((problem) => problem.severity === "error"), []);
  assert.ok(!draftProblems(draft).some((problem) => /Sloane starts away/.test(problem.message)), "the VP's threat brings them in");

  assert.match(apply(upsertCharacter(draft, { id: "wen", startsAway: true })), /away from the scene at the start/);
  assert.equal(draft.seed.characters.find((character) => character.id === "wen")?.away, true);
  assert.ok(draftProblems(draft).some((problem) => problem.severity === "warning" && /Wen starts away and no threat brings them in/.test(problem.message)));
  apply(upsertThreat(draft, { id: "social-media", bringsIn: [{ characterId: "wen", placeId: "war-room" }], sendsAway: ["dan"] }));
  const threat = draft.seed.threats!.find((entry) => entry.id === "social-media")!;
  assert.deepEqual(threat.enters, [{ characterId: "wen", locationId: "war-room" }]);
  assert.deepEqual(threat.exits, ["dan"]);
  assert.ok(!draftProblems(draft).some((problem) => /Wen starts away/.test(problem.message)));

  apply(upsertCharacter(draft, { id: "priya", startsAway: true }));
  apply(upsertCharacter(draft, { id: "dan", startsAway: true }));
  assert.ok(draftProblems(draft).some((problem) => problem.severity === "error" && /must start in the scene/.test(problem.message)));
  apply(upsertCharacter(draft, { id: "priya", startsAway: false }));
  assert.equal(draft.seed.characters.find((character) => character.id === "priya")?.away, undefined);

  apply(remove(draft, { kind: "character", id: "dan" }));
  assert.equal(draft.seed.threats!.find((entry) => entry.id === "social-media")!.exits, undefined);
  apply(remove(draft, { kind: "place", id: "war-room" }));
  const after = draft.seed.threats!;
  assert.ok(after.every((entry) => entry.enters === undefined), "entrances at a removed place go with it");
});

const connectionString = process.env.TEST_DATABASE_URL;

test("entrances and exits through the turn runner", {
  skip: connectionString ? false : "Set TEST_DATABASE_URL to run real PostgreSQL integration tests",
}, async (t) => {
  assert.ok(connectionString);
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  const engine = new AdventureEngine(connectionString, { schema, roll: fixed(15) });
  const none = { destinationId: null, recipientId: null, itemId: null, quantity: null, challengeId: null, intent: null, minutes: null };
  const say = (speech: string, to: string | null = null): ScriptStep => ({ role: "character", output: { speech, to, action: null } });
  const unruled = { challengeId: null, name: null, ability: null, difficulty: null, failureDamage: null, minutes: null };
  try {
    await engine.initialize();

    await t.test("a supporting character leaves on its turn, and can no longer be cued", async () => {
      const { id } = await engine.createWorld(starterWorld("npc-leaves"));
      const provider = new ScriptedProvider([
        say("Will you stay for supper, grandmother?", "tamsin"),
        { role: "dm", output: { speech: "Not tonight. My goats want me.", to: "mira", move: null, leave: true } },
      ]);
      const runner = new TurnRunner(engine, provider, starterCast);
      await runner.run(id, { maxTurns: 2 });
      assert.equal(provider.remaining, 0);
      const events = await engine.getEvents(id);
      assert.deepEqual(events.slice(-2).map((event) => [event.source, event.data.type]), [["dm", "utterance"], ["dm", "character_exited"]]);
      const state = await engine.getWorld(id);
      assert.equal(state.characters.find((character) => character.id === "tamsin")?.away, true);
      assert.deepEqual(await engine.replayWorld(id), state);
      await assert.rejects(runner.step(id, undefined, { actorId: "tamsin" }), /tamsin cannot take a turn: tamsin is away from the scene/);
    });

    await t.test("an automatic ruling brings someone away to the actor, and the narrator covers the entrance", async () => {
      const { id } = await engine.createWorld(withAway(starterWorld("fetched"), "tamsin"));
      const provider = new ScriptedProvider([
        { role: "character", output: { speech: null, to: null, action: { ...none, type: "attempt", intent: "shout down to Old Tamsin's hut" } } },
        { role: "dm", output: { ...unruled, decision: "automatic", minutes: 1, reason: "Mira's voice carries down the hill.", bringsIn: "tamsin" } },
        { role: "dm", output: { narration: "A door bangs below, and Old Tamsin climbs up with a lamp." } },
      ]);
      await new TurnRunner(engine, provider, starterCast).run(id, { maxTurns: 1 });
      assert.equal(provider.remaining, 0);
      assert.match(provider.requests[1]!.prompt, /## Away from the scene\n- Old Tamsin \(tamsin\)/);
      const events = await engine.getEvents(id);
      const entered = events.find((event) => event.data.type === "character_entered")!;
      assert.equal(entered.source, "engine");
      const narration = events.at(-1)!.data;
      assert.ok(narration.type === "narration");
      assert.ok(narration.aboutSequences.includes(entered.sequence));
      const state = await engine.getWorld(id);
      assert.equal(state.characters.find((character) => character.id === "tamsin")?.locationId, "camp");
      assert.deepEqual(await engine.replayWorld(id), state);
    });
  } finally {
    await engine.close();
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  }
});
