import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { z } from "zod";
import { Pool } from "pg";
import { starterWorld } from "../src/adventures/starter.ts";
import { beliefLines, goalLines } from "../src/agents/context.ts";
import { characterTurnSchema, ProposalError, toTurnParts } from "../src/agents/protocol.ts";
import { buildCharacterPrompt, buildNpcPrompt } from "../src/agents/runner.ts";
import { turnHistory } from "../src/agents/schedule.ts";
import { AdventureEngine } from "../src/engine.ts";
import { attributeKey, BELIEF_EVENTS, beliefsOf, rankRecollections, recallQuery, salience } from "../src/memory.ts";
import type { Command, EventData, WorldSeed, WorldState } from "../src/model.ts";
import { perceive } from "../src/perception.ts";
import { Replayer } from "../src/rules.ts";
import type { CommittedEvent } from "../src/rules.ts";
import { creationEvent, errorCode, fixed, nextEvent, Session } from "./support.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const CANARY = "CANARY-DISCOVERY-93";

/** The starter world with Mira and Elowen in the cistern, where the ledge reveals a canary. */
function cisternWorld(id: string): WorldSeed {
  const seed = starterWorld(id);
  for (const character of seed.characters) {
    if (character.id === "mira" || character.id === "elowen") character.locationId = "cistern";
  }
  const ledge = seed.challenges.find((challenge) => challenge.id === "search-ledge")!;
  ledge.onSuccess = { ...ledge.onSuccess, reveals: `${CANARY}: behind the seal, an arrow and the words "the hall drain is dry".` };
  return seed;
}

function sequenceOf(committed: CommittedEvent[], type: EventData["type"]): number {
  return committed.find(({ event }) => event.data.type === type)!.event.sequence;
}

test("a successful check reveals its discovery to the finder alone, and replay holds it to that check", () => {
  const session = new Session(cisternWorld("discovery"));
  const committed = session.commit({ actorId: "elowen", action: { type: "attempt_check", challengeId: "search-ledge" } });
  assert.deepEqual(committed.map(({ event, perceivers }) => [event.data.type, perceivers]), [
    ["check_resolved", ["elowen", "mira"]],
    ["discovery", ["elowen"]],
  ]);
  assert.match(JSON.stringify(committed[1]!.event.data), new RegExp(CANARY));
  // Mira saw the search succeed, but not what it revealed (canary).
  assert.ok(session.perceivedBy("mira").every((event) => !JSON.stringify(event).includes(CANARY)));
  assert.ok(!JSON.stringify(perceive(session.state, "mira")).includes(CANARY));

  const failed = new Session(cisternWorld("no-discovery"));
  const miss = failed.commit({ actorId: "elowen", action: { type: "attempt_check", challengeId: "search-ledge" } }, fixed(1));
  assert.deepEqual(miss.map(({ event }) => event.data.type), ["check_resolved"], "a failed check reveals nothing");

  const forged = new Session(cisternWorld("forged"));
  const discovery = committed[1]!.event.data;
  assert.throws(() => forged.replayer.apply(nextEvent(forged.state, discovery)), errorCode("CORRUPT_STORAGE"));
  const replay = new Replayer();
  replay.apply(creationEvent(cisternWorld("discovery")));
  replay.apply(committed[0]!.event);
  const altered = { ...committed[1]!.event, data: { ...discovery, text: "Nothing at all." } as EventData };
  assert.throws(() => replay.apply(altered), errorCode("CORRUPT_STORAGE"));
});

test("a belief's source comes from its evidence: hearsay stays hearsay and cannot be laundered", () => {
  const session = new Session(starterWorld("sources"));
  session.commit({ speech: "Seen anyone pass?", addresseeId: "tamsin" }); // #2, Mira's own words
  session.commit({ role: "npc", actorId: "tamsin", speech: "Your friend went down at dawn.", addresseeId: "mira" }); // #3
  session.commit({ actorId: "bram", action: { type: "wait", seconds: 60 } }); // #4, seen by Mira
  session.commit({ actorId: "elowen", speech: "Nobody here." }); // #5, at the mouth: Mira cannot hear it
  const note = (evidence: number[]) => {
    const committed = session.commit({
      speech: "Hm.", note: { about: "elowen", attribute: "location", value: "Aqueduct Mouth", evidence, confidence: "medium" },
    });
    const data = committed.find(({ event }) => event.data.type === "belief_noted")!;
    assert.deepEqual(data.perceivers, ["mira"], "a note is private");
    return data.event.data.type === "belief_noted" ? [data.event.data.source, data.event.data.evidence] : [];
  };
  assert.deepEqual(note([3]), ["reported", [3]]);
  assert.deepEqual(note([4, 3, 4]), ["reported", [3, 4]], "firsthand evidence does not launder a rumor");
  assert.deepEqual(note([4]), ["inferred", [4]]);
  assert.deepEqual(note([]), ["speculation", []]);
  assert.deepEqual(note([2]), ["speculation", [2]], "your own words are not evidence of anything else");
  const thought = session.events.at(-1)!.sequence;
  const rejected = (evidence: number[], message: RegExp) => assert.throws(() => session.commit({
    speech: "Hm.", note: { about: "elowen", attribute: "location", value: "here", evidence, confidence: "low" },
  }), (error: unknown) => errorCode("INVALID_ACTION")(error) && message.test((error as Error).message));
  rejected([5], /mira did not perceive event #5/);
  rejected([1], /mira did not perceive event #1/);
  rejected([999], /mira did not perceive event #999/);
  rejected([thought], new RegExp(`Event #${thought} is a thought, not evidence`));

  const forged = (data: Partial<Extract<EventData, { type: "belief_noted" }>>) => nextEvent(session.state, {
    type: "belief_noted", actorId: "mira", about: "elowen", attribute: "location", value: "here",
    evidence: [3], confidence: "high", source: "reported", ...data,
  });
  assert.throws(() => session.replayer.apply(forged({ source: "inferred" })), errorCode("CORRUPT_STORAGE"));
  assert.throws(() => session.replayer.apply(forged({ evidence: [4, 3], source: "reported" })), errorCode("CORRUPT_STORAGE"));
  assert.throws(() => session.replayer.apply(forged({ evidence: [], source: "reported" })), errorCode("CORRUPT_STORAGE"));
  assert.throws(() => session.replayer.apply(forged({ evidence: [5], source: "reported" })), errorCode("CORRUPT_STORAGE"));
});

test("new observations supersede stale beliefs without erasing history", () => {
  const session = new Session(starterWorld("supersede"));
  session.commit({ actorId: "bram", action: { type: "move", destinationId: "mouth" } }); // #2, Mira sees him go
  session.commit({ role: "npc", actorId: "tamsin", speech: "Your big friend went back up the ridge.", addresseeId: "mira" }); // #3
  session.commit({
    speech: "Did he.", note: { about: "bram", attribute: "Whereabouts", value: "back up on the ridge", evidence: [3], confidence: "medium" },
  }); // #4, #5
  let topic = beliefsOf("mira", session.perceivedBy("mira"), session.state).find((entry) => entry.about === "bram")!;
  assert.equal(topic.attribute, "location", "attributes compare by meaning, not spelling");
  assert.deepEqual([topic.current.source, topic.current.value], ["reported", "back up on the ridge"]);
  assert.deepEqual(beliefLines([topic], perceive(session.state, "mira"), session.state), [
    "- Bram (bram), location: back up on the ridge [hearsay from #3; medium confidence]",
  ]);

  session.commit({ action: { type: "move", destinationId: "mouth" } }); // #6
  session.commit({ actorId: "bram", speech: "There you are." }); // #7, Mira sees Bram at the mouth
  session.commit({
    speech: "Odd.", note: { about: "bram", attribute: "location", value: "on the ridge, still", evidence: [3], confidence: "low" },
  }); // #8, #9: a note resting on the old rumor
  topic = beliefsOf("mira", session.perceivedBy("mira"), session.state).find((entry) => entry.about === "bram")!;
  assert.deepEqual([topic.current.source, topic.current.value, topic.current.sequence], ["observed", "Aqueduct Mouth", 7]);
  assert.deepEqual(
    topic.history.map((belief) => [belief.source, belief.sequence, belief.asOf]),
    [["observed", 2, 2], ["reported", 5, 3], ["reported", 9, 3], ["observed", 7, 7]],
    "every belief is kept, ordered by the evidence it rests on",
  );
  assert.deepEqual(beliefLines([topic], perceive(session.state, "mira"), session.state), [], "Bram is in plain sight");
  assert.ok(
    beliefsOf("bram", session.perceivedBy("bram"), session.state).every((entry) => entry.current.source === "observed"),
    "Mira's notes are hers alone",
  );
  assert.equal(attributeKey("Held by"), "holder");
  assert.equal(attributeKey("constructor"), "constructor");
});

test("goals and commitments are private events whose status changes are recorded", () => {
  const session = new Session(starterWorld("goals"));
  const adopt = session.commit({ speech: "Right.", goal: { status: "adopted", kind: "goal", text: "Reach the cistern by dusk" } });
  const goalId = `goal-${sequenceOf(adopt, "goal_set")}`;
  assert.equal(goalId, "goal-3");
  assert.deepEqual(adopt.at(-1)!.perceivers, ["mira"]);
  session.commit({ speech: "I'll carry it.", goal: { status: "adopted", kind: "commitment", text: "Carry the lantern for Elowen" } });
  assert.deepEqual(goalLines(session.state, "mira"), [
    "- goal-3 (goal): Reach the cistern by dusk",
    "- goal-5 (commitment): Carry the lantern for Elowen",
  ]);
  session.commit({ speech: "Done.", goal: { status: "fulfilled", goalId: "goal-3" } });
  session.commit({ speech: "Never mind.", goal: { status: "abandoned", goalId: "goal-5" } });
  assert.deepEqual(session.state.characters.find((character) => character.id === "mira")?.goals, [
    { id: "goal-3", kind: "goal", text: "Reach the cistern by dusk", status: "fulfilled" },
    { id: "goal-5", kind: "commitment", text: "Carry the lantern for Elowen", status: "abandoned" },
  ]);
  assert.deepEqual(goalLines(session.state, "mira"), []);
  assert.throws(() => session.commit({ speech: "Again.", goal: { status: "fulfilled", goalId: "goal-3" } }), errorCode("INVALID_ACTION"));
  assert.throws(() => session.commit({ actorId: "bram", speech: "Mine now.", goal: { status: "abandoned", goalId: "goal-5" } }), errorCode("INVALID_ACTION"));
  assert.ok(!JSON.stringify(perceive(session.state, "bram")).includes("cistern by dusk"), "others never perceive goals");
  assert.ok(session.perceivedBy("bram").every((event) => event.data.type === "utterance"));
  // Thinking is not acting: turns that only speak and set goals stay idle.
  assert.ok(turnHistory(session.events, session.state).every((turn) => !turn.acted));

  const forged = (data: Partial<Extract<EventData, { type: "goal_set" }>>) => nextEvent(session.state, {
    type: "goal_set", actorId: "mira", goalId: `goal-${session.state.revision + 1}`, kind: "goal", text: "Sleep", status: "adopted", ...data,
  });
  assert.throws(() => session.replayer.apply(forged({ goalId: "goal-1" })), errorCode("CORRUPT_STORAGE"));
  assert.throws(() => session.replayer.apply(forged({ goalId: "goal-3", status: "fulfilled" })), errorCode("CORRUPT_STORAGE"));
});

test("turn proposals carry notes and goals, and the strict schema still requires every field", () => {
  const base = { speech: "Hm.", to: null, action: null };
  assert.deepEqual(toTurnParts({
    ...base,
    note: { about: "channel", attribute: "danger", value: " deadly ", evidence: [3], confidence: "low" },
    goal: { status: "adopted", kind: "commitment", text: "Keep Mira safe", goalId: null },
  }), {
    speech: "Hm.",
    note: { about: "channel", attribute: "danger", value: "deadly", evidence: [3], confidence: "low" },
    goal: { status: "adopted", kind: "commitment", text: "Keep Mira safe" },
  });
  assert.deepEqual(toTurnParts({ ...base, goal: { status: "fulfilled", kind: null, text: null, goalId: "goal-3" } }).goal, {
    status: "fulfilled", goalId: "goal-3",
  });
  assert.deepEqual(toTurnParts({ ...base, note: null, goal: null }), { speech: "Hm." });
  const rejects = (output: Record<string, unknown>) => assert.throws(() => toTurnParts({ ...base, ...output }), ProposalError);
  rejects({ goal: { status: "adopted", kind: "goal", text: null, goalId: null } });
  rejects({ goal: { status: "abandoned", kind: null, text: null, goalId: null } });
  rejects({ note: { about: "x", attribute: "y", value: "z", evidence: [1, 2, 3, 4, 5, 6], confidence: "low" } });
  rejects({ note: { about: "x", attribute: " ", value: "z", evidence: [], confidence: "low" } });
  rejects({ note: { about: "x", attribute: "y", value: "z", evidence: [], confidence: "low" }, speech: null });
  const schema = z.toJSONSchema(characterTurnSchema) as { required: string[] };
  assert.deepEqual(schema.required, ["speech", "to", "action", "note", "goal"]);
  assert.equal(characterTurnSchema.parse(base).note, null, "older outputs without memory fields still parse");
});

test("recall searches for the situation, and ranking weighs relevance, salience, and recency", () => {
  const session = new Session(cisternWorld("ranking"));
  session.commit({ actorId: "elowen", action: { type: "attempt_check", challengeId: "search-ledge" } }); // #2, #3
  session.commit({ actorId: "elowen", speech: "Mira, can you reach the north wall?", addresseeId: "mira" }); // #4
  session.commit({ action: { type: "wait", seconds: 60 } }); // #5
  session.commit({ actorId: "elowen", speech: "Hm." }); // #6
  session.commit({ actorId: "elowen", speech: "The drain, maybe." }); // #7
  const state = session.state;
  const query = recallQuery(perceive(state, "mira"), session.perceivedBy("mira"));
  const terms = query.split(" or ");
  for (const term of ["cistern", "vault", "elowen", "search-ledge", "rope", "reach", "north", "wall"]) {
    assert.ok(terms.includes(term), `query includes ${term}`);
  }
  assert.ok(!terms.includes("hm"), "words under three letters are dropped; PostgreSQL drops stop words");
  assert.ok(terms.length <= 24);
  assert.equal(query, terms.join(" or "));

  const byType = (type: EventData["type"]) => session.events.find((event) => event.data.type === type)!;
  assert.equal(salience(byType("discovery"), "elowen", state), 3);
  assert.equal(salience(session.events.find((event) => event.sequence === 4)!, "mira", state), 3, "a question put to you is unresolved");
  assert.equal(salience(session.events.find((event) => event.sequence === 6)!, "mira", state), 1);
  assert.equal(salience(byType("time_advanced"), "mira", state), 0);
  const at = (sequence: number) => session.events.find((event) => event.sequence === sequence)!;
  const ranked = (matches: [number, number][], limit: number) => rankRecollections(
    matches.map(([sequence, rank]) => ({ event: at(sequence), rank })), "mira", state, limit,
  ).map((event) => event.sequence);
  // At equal relevance, the question put to Mira and the check that found something outrank chatter and waiting.
  assert.deepEqual(ranked([[6, 0.1], [5, 0.1], [4, 0.1], [2, 0.1]], 1), [4]);
  assert.deepEqual(ranked([[6, 0.1], [5, 0.1], [4, 0.1], [2, 0.1]], 3), [2, 4, 6], "oldest first, the wait left out");
  // At equal salience, relevance outweighs recency.
  assert.deepEqual(ranked([[6, 0.9], [7, 0.1]], 1), [6]);
  assert.deepEqual(ranked([], 2), []);
  assert.deepEqual(ranked([[6, 0.1]], 0), []);
});

test("PostgreSQL memory integration", {
  skip: connectionString ? false : "Set TEST_DATABASE_URL to run real PostgreSQL integration tests",
}, async (t) => {
  assert.ok(connectionString);
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  let engine = new AdventureEngine(connectionString, { schema, roll: fixed(15) });
  const worldId = "memory";
  let state: WorldState;
  const execute = async (input: Partial<Command> & Record<string, unknown>) => {
    state = (await engine.execute(worldId, {
      role: "character", requestId: `r${state.revision}`, expectedRevision: state.revision, actorId: "mira", ...input,
    })).state;
  };
  const sequences = async (characterId: string, query: string, options = {}) => (
    await engine.searchMemories(worldId, characterId, query, options)
  ).map((match) => match.event.sequence);
  try {
    await engine.initialize();
    state = await engine.createWorld(cisternWorld(worldId));
    await execute({ actorId: "elowen", action: { type: "attempt_check", challengeId: "search-ledge" } }); // #2, #3
    await execute({ actorId: "bram", speech: "CANARY-CAMP-12: the goats are restless.", addresseeId: "tamsin" }); // #4
    await execute({ role: "npc", actorId: "tamsin", speech: "Goats know things.", addresseeId: "bram" }); // #5
    await execute({
      speech: "Lantern's bright.",
      note: { about: "elowen", attribute: "found", value: "something on the ledge", evidence: [2], confidence: "medium" },
    }); // #6, #7
    for (let index = 0; index < 3; index += 1) {
      await execute({ action: { type: "wait", seconds: 60 } });
      await execute({ actorId: "elowen", action: { type: "wait", seconds: 60 } });
    } // #8 to #13
    await execute({ actorId: "elowen", speech: "What now?" }); // #14

    await t.test("search finds only what each character perceived, and snippets never leak", async () => {
      const [found] = await engine.searchMemories(worldId, "elowen", "drain");
      assert.deepEqual([found?.event.sequence, found?.event.data.type], [3, "discovery"]);
      assert.match(found?.snippet ?? "", /«drain»/);
      for (const witness of ["mira", "bram", "tamsin"]) {
        assert.deepEqual(await sequences(witness, "drain"), [], `${witness} cannot retrieve the discovery`);
        assert.deepEqual(await sequences(witness, CANARY), []);
      }
      assert.deepEqual(await sequences("mira", "goats"), [], "camp talk never reached the cistern");
      const camp = await engine.searchMemories(worldId, "bram", "goats");
      assert.deepEqual(camp.map((match) => match.event.sequence).sort(), [4, 5]);
      assert.ok(camp.every((match) => /«goats»/i.test(match.snippet ?? "")));
      // Mira's note mentions the ledge, but thoughts are beliefs, not recollections.
      const ledge = await engine.searchMemories(worldId, "mira", "ledge");
      assert.deepEqual(ledge.map((match) => [match.event.sequence, match.snippet]), [[2, null]]);
      assert.deepEqual(await sequences("elowen", "drain", { before: 3 }), []);
      assert.deepEqual(await sequences("elowen", "   "), []);
      await assert.rejects(engine.searchMemories(worldId, "nobody", "drain"), errorCode("NOT_FOUND"));
      await assert.rejects(engine.searchMemories(worldId, "elowen", "drain", { limit: 0 }), errorCode("INVALID_INPUT"));
    });

    await t.test("notes may cite only committed events their writer perceived", async () => {
      const stored = (await engine.getEvents(worldId)).find((event) => event.sequence === 7)!;
      assert.equal(stored.data.type === "belief_noted" && stored.data.source, "inferred");
      assert.deepEqual(await engine.getPerceivers(worldId, 7), ["mira"]);
      assert.deepEqual(await engine.getPerceivers(worldId, 3), ["elowen"]);
      const cite = (evidence: number[]) => execute({
        speech: "Hm.", note: { about: "bram", attribute: "mood", value: "restless", evidence, confidence: "low" },
      });
      await assert.rejects(cite([4]), (error: unknown) => errorCode("INVALID_ACTION")(error) && /did not perceive event #4/.test(String(error)));
      await assert.rejects(cite([999]), errorCode("INVALID_ACTION"));
      await assert.rejects(cite([7]), (error: unknown) => /is a thought/.test(String(error)));
      assert.equal((await engine.getWorld(worldId)).revision, 14, "nothing committed");
    });

    await t.test("recall brings back older relevant memories after the transcript is truncated", async () => {
      const narrow = { recentEvents: 3, memoryEvents: 4 };
      const elowen = await buildCharacterPrompt(engine, worldId, state, "elowen", narrow);
      const [, recalled = "", recent = ""] = elowen.split(/## What you remember from earlier, oldest first|## What you perceived recently/);
      assert.match(recalled, new RegExp(`#3 \\[[^\\]]+\\] You discovered, alone: ${CANARY}`));
      assert.ok(!recent.includes(CANARY), "the discovery fell out of the recent window");
      assert.match(elowen, /## Your goals and commitments\nNone yet\./);

      const mira = await buildCharacterPrompt(engine, worldId, state, "mira", narrow);
      assert.match(mira, /- Elowen \(elowen\), found: something on the ledge \[your inference from #2; medium confidence\]/);
      for (const prompt of [mira, await buildCharacterPrompt(engine, worldId, state, "bram", narrow)]) {
        assert.ok(!prompt.includes(CANARY), "a witness of the search, and a bystander elsewhere, never learn the discovery");
      }
      assert.ok(!elowen.includes("something on the ledge"), "Mira's note stays hers");

      // NPCs voiced by the DM get the same scoped recall.
      const tamsin = await buildNpcPrompt(engine, worldId, state, "tamsin", { recentEvents: 1, memoryEvents: 4 });
      assert.match(tamsin, /## What you remember from earlier, oldest first\n#4 \[[^\]]+\] Bram said to you: "CANARY-CAMP-12/);
      assert.ok(!tamsin.includes(CANARY) && !tamsin.includes("something on the ledge"));
      const off = await buildCharacterPrompt(engine, worldId, state, "elowen", { recentEvents: 3, memoryEvents: 0 });
      assert.ok(!off.includes("What you remember"), "memoryEvents 0 disables recall");
    });

    await t.test("save and resume preserve knowledge boundaries", async () => {
      const query = "drain or goats or ledge or lantern or camp";
      const characters = ["mira", "bram", "elowen", "tamsin"];
      const snapshot = async () => Promise.all(characters.map(async (characterId) => ({
        found: await engine.searchMemories(worldId, characterId, query),
        beliefs: beliefsOf(characterId, await engine.getPerceivedEvents(worldId, characterId, 1000, { types: BELIEF_EVENTS }), state),
        prompt: await buildCharacterPrompt(engine, worldId, state, characterId === "tamsin" ? "mira" : characterId, { recentEvents: 3, memoryEvents: 4 }),
      })));
      const before = await snapshot();
      await engine.close();
      engine = new AdventureEngine(connectionString, { schema });
      await engine.initialize();
      state = await engine.getWorld(worldId);
      assert.deepEqual(await engine.replayWorld(worldId), state);
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(await engine.getPerceivers(worldId, 3), ["elowen"]);
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
