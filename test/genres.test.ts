import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { ADVENTURES } from "../src/adventures/index.ts";
import { nightMarketCast, nightMarketWorld } from "../src/adventures/night-market.ts";
import { outageCast, outageWorld } from "../src/adventures/outage.ts";
import { starterWorld } from "../src/adventures/starter.ts";
import { castProblems, castSchema } from "../src/agents/prompts.ts";
import type { Cast } from "../src/agents/prompts.ts";
import { ProviderError, ScriptedProvider } from "../src/agents/provider.ts";
import type { ModelRequest, ScriptStep } from "../src/agents/provider.ts";
import { DEFAULT_RUNNER_SETTINGS, TurnRunner } from "../src/agents/runner.ts";
import type { StepOutcome } from "../src/agents/runner.ts";
import { pacePolicy, turnDirection } from "../src/agents/schedule.ts";
import type { TurnRecord } from "../src/agents/schedule.ts";
import { draftProblems } from "../src/creator/operations.ts";
import { AdventureEngine } from "../src/engine.ts";
import { commandSchema, DEFAULT_RULES, parseInput, rulesOf, validateWorld, worldProblems } from "../src/model.ts";
import type { AdventureEvent, Command, EventData, WorldSeed } from "../src/model.ts";
import { Replayer, resolveCommand } from "../src/rules.ts";
import { sampleWorld } from "../src/sample-world.ts";
import { creationEvent, errorCode, fixed, initialState, nextEvent, NOW, Session } from "./support.ts";

// Worlds beyond the dungeon: the referee's judgment in place of dice, worlds
// without stats or health, and endings.

const types = (committed: { event: AdventureEvent }[]) => committed.map(({ event }) => event.data.type);

/** A seed with characters moved as given. */
function placed(seed: WorldSeed, where: Record<string, string>): WorldSeed {
  return { ...seed, characters: seed.characters.map((character) => ({ ...character, locationId: where[character.id] ?? character.locationId })) };
}

const judged = (success: boolean, reason = success ? "It works." : "It does not work.") => ({ success, reason });

test("a world without rules plays by the old ones: dice, three abilities, and HP", () => {
  assert.deepEqual(rulesOf(starterWorld("old")), DEFAULT_RULES);
  assert.deepEqual(DEFAULT_RULES, { outcomes: "dice", stats: { strength: "Strength", dexterity: "Dexterity", wisdom: "Wisdom" }, health: "HP" });
  assert.deepEqual(rulesOf(outageWorld("new")), { outcomes: "judgment", stats: null, health: null });
});

test("a judged check commits the referee's reason and approach, applies only the declared effects, and replays", () => {
  const session = new Session(placed(outageWorld("judged"), { priya: "logs" }));
  const committed = session.commit({
    actorId: "priya",
    action: { type: "attempt_check", challengeId: "search-logs", approach: "Filter checkout errors from 02:55 to 03:00" },
    judgment: judged(true, "Narrowing the window to 02:58 surfaces the first errors."),
  });
  assert.deepEqual(types(committed), ["check_resolved", "discovery"]);
  const [check, discovery] = committed;
  assert.deepEqual(check?.event.data, {
    type: "check_resolved", actorId: "priya", challengeId: "search-logs", success: true,
    reason: "Narrowing the window to 02:58 surfaces the first errors.", approach: "Filter checkout errors from 02:55 to 03:00",
    damage: 0, seconds: 300, effects: { unlockedRoutes: [], grantedItems: [] },
  });
  assert.deepEqual(discovery?.perceivers, ["priya"], "a discovery is private");
  assert.equal(session.state.characters.find((character) => character.id === "priya")?.hp, 10);
});

test("dice and judgment worlds each refuse the other's kind of attempt", () => {
  const judgmentWorld = new Session(placed(outageWorld("needs-judgment"), { priya: "logs" }));
  assert.throws(() => judgmentWorld.commit({ actorId: "priya", action: { type: "attempt_check", challengeId: "search-logs" } }),
    errorCode("INVALID_ACTION"));
  assert.throws(() => judgmentWorld.commit({
    actorId: "priya", action: { type: "attempt", intent: "Refresh the page" },
    ruling: { decision: "automatic", seconds: 60, reason: "Anyone can." }, judgment: judged(true),
  }), errorCode("INVALID_ACTION"), "an automatic success needs no judgment");

  const diceWorld = new Session(sampleWorld("no-judgment"));
  assert.throws(() => diceWorld.commit({
    actorId: "mira", action: { type: "attempt_check", challengeId: "gate-trap" }, judgment: judged(true),
  }), errorCode("INVALID_ACTION"));

  // Only attempts carry a judgment.
  assert.throws(() => parseInput(commandSchema, {
    role: "character", requestId: "r", expectedRevision: 1, actorId: "priya",
    action: { type: "move", destinationId: "logs" }, judgment: judged(true),
  }), errorCode("INVALID_INPUT"));
});

test("an open attempt in a judgment world is ruled, then judged, and nothing it costs is health", () => {
  const session = new Session(outageWorld("ruled"));
  const committed = session.commit({
    actorId: "priya", action: { type: "attempt", intent: "Page the security team" },
    ruling: { decision: "new", name: "Reach security", ability: "wisdom", difficulty: "moderate", failureDamage: 0, seconds: 120, reason: "It is 3 a.m." },
    judgment: judged(false, "Nobody answers the page."),
  });
  assert.deepEqual(types(committed), ["ruling", "check_resolved"]);
  assert.equal(committed[1]?.event.data.type === "check_resolved" && committed[1].event.data.reason, "Nobody answers the page.");
  assert.throws(() => session.commit({
    actorId: "dan", action: { type: "attempt", intent: "Kick the server rack" },
    ruling: { decision: "new", name: "Kick", ability: "wisdom", difficulty: "easy", failureDamage: 2, seconds: 60, reason: "Ouch." },
    judgment: judged(false),
  }), errorCode("INVALID_ACTION"), "a world without health takes no damage");
});

test("replay checks a judged outcome's shape: a reason and no dice in judgment worlds, dice and no reason otherwise", () => {
  const seed = placed(outageWorld("forged-judgment"), { priya: "logs" });
  const session = new Session(seed);
  const [check] = session.commit({
    actorId: "priya", action: { type: "attempt_check", challengeId: "search-logs" }, judgment: judged(false, "Too broad a search."),
  });
  assert.ok(check?.event.data.type === "check_resolved");
  const { reason: _reason, ...unreasoned } = check.event.data;
  const corrupt = errorCode("CORRUPT_STORAGE");
  for (const data of [unreasoned, { ...check.event.data, roll: 15, modifier: 0, difficulty: 12 }]) {
    const replayer = new Replayer();
    replayer.apply(creationEvent(seed));
    assert.throws(() => replayer.apply({ ...check.event, data: data as EventData }), corrupt);
  }

  const dice = new Session(sampleWorld("forged-dice"));
  const [roll] = dice.commit({ actorId: "mira", action: { type: "attempt_check", challengeId: "gate-trap" } });
  assert.ok(roll?.event.data.type === "check_resolved");
  const replayer = new Replayer();
  replayer.apply(creationEvent(sampleWorld("forged-dice")));
  const reasoned = { ...roll.event.data, reason: "The referee says so." };
  assert.throws(() => replayer.apply({ ...roll.event, data: reasoned }), corrupt);
});

test("an ending fires on a check's outcome, after which only narration and retcons happen", () => {
  for (const [success, endingId] of [[true, "together"], [false, "still-friends"]] as const) {
    const session = new Session(placed(nightMarketWorld(`ending-${endingId}`), { alex: "bridge", sam: "bridge" }));
    const committed = session.commit({
      actorId: "alex", speech: "Sam, there's something I've wanted to say for a year.",
      action: { type: "attempt_check", challengeId: "confess", approach: "Ask about Lisbon first, then say it plainly" },
      judgment: judged(success),
    });
    assert.deepEqual(types(committed), ["utterance", "check_resolved", "story_ended"]);
    const ended = committed.at(-1)!;
    assert.deepEqual(ended.event.data, { type: "story_ended", endingId });
    assert.equal(ended.event.source, "engine");
    assert.deepEqual(ended.perceivers, ["alex", "jordan", "mei", "sam"], "everyone conscious perceives the ending");
    assert.equal(session.state.endedWith, endingId);

    for (const input of [
      { actorId: "sam", speech: "Wait." },
      { actorId: "sam", action: { type: "wait", seconds: 60 } },
      { role: "npc", actorId: "mei", speech: "Dumplings?" },
    ]) {
      assert.throws(() => session.commit(input), errorCode("INVALID_ACTION"));
    }
    const check = committed[1]!;
    const narration = resolveCommand(session.state, parseInput(commandSchema, {
      role: "dm", requestId: "closing", expectedRevision: session.state.revision,
      action: { type: "narrate", aboutSequences: [check.event.sequence], text: "The lanterns drift on downriver." },
    }), { roll: fixed(10), recordedAt: NOW, audience: check.perceivers });
    assert.deepEqual(types(narration.committed), ["narration"]);
    assert.deepEqual(session.replayer.apply(narration.committed[0]!.event), narration.committed[0]!.perceivers);
  }
});

test("an ending fires when its threat happens, and threats still due never fire", () => {
  const seed = outageWorld("deadline");
  seed.threats = seed.threats!.map((threat) => (threat.id === "morning-traffic" ? { ...threat, at: 600 } : threat));
  const session = new Session(seed);
  const committed = session.commit({ actorId: "priya", action: { type: "wait", seconds: 1800 } });
  assert.deepEqual(types(committed).slice(-2), ["threat_triggered", "story_ended"]);
  assert.equal(session.state.endedWith, "full-outage");
  assert.equal(session.state.elapsedSeconds, 600);
  assert.equal(session.state.threats!.find((threat) => threat.id === "social-media")?.status, "armed");
  assert.throws(() => session.commit({ actorId: "dan", action: { type: "wait", seconds: 60 } }), errorCode("INVALID_ACTION"));
});

test("a threat that comes due during an action happens before the ending the action reaches", () => {
  /** Priya at the gateway with the token, and the given threat due a minute into the seven-minute rotation. */
  const rotation = (threatId: string) => {
    const seed = placed(outageWorld(`during-${threatId}`), { priya: "gateway" });
    seed.characters = seed.characters.map((character) => (
      character.id === "priya" ? { ...character, inventory: { "admin-token": 1 } } : character
    ));
    seed.threats = seed.threats!.map((threat) => (threat.id === threatId ? { ...threat, at: 60 } : threat));
    const session = new Session(seed);
    const committed = session.commit({
      actorId: "priya", action: { type: "attempt_check", challengeId: "rotate-certificate", approach: "Issue a new certificate and reload" },
      judgment: judged(true),
    });
    return { seed, session, committed };
  };

  const { seed, session, committed } = rotation("vp-joins");
  assert.deepEqual(types(committed), ["check_resolved", "threat_triggered", "character_entered", "story_ended"]);
  assert.equal(session.state.endedWith, "restored");
  assert.equal(session.state.characters.find((character) => character.id === "sloane")?.away, undefined, "the VP arrived in time to see it");

  const traffic = rotation("morning-traffic");
  assert.deepEqual(types(traffic.committed), ["check_resolved", "threat_triggered", "story_ended"]);
  assert.equal(traffic.session.state.endedWith, "full-outage", "the traffic arrived before the reload finished");

  // Earlier versions recorded the action's ending first and skipped the threat; those histories still replay.
  const [check, , , ended] = committed;
  const replayer = new Replayer();
  replayer.apply(creationEvent(seed));
  replayer.apply(check!.event);
  replayer.apply({ ...ended!.event, sequence: check!.event.sequence + 1 });
  assert.equal(replayer.state!.endedWith, "restored");
});

test("replay accepts an ending only right after the outcome or threat that causes it", () => {
  const corrupt = errorCode("CORRUPT_STORAGE");
  const seed = placed(nightMarketWorld("forged-ending"), { alex: "bridge", sam: "bridge" });
  const fresh = () => {
    const replayer = new Replayer();
    replayer.apply(creationEvent(seed));
    return replayer;
  };
  assert.throws(() => fresh().apply(nextEvent(initialState(seed), { type: "story_ended", endingId: "together" }, { source: "engine" })),
    corrupt, "an ending with nothing behind it is forged");

  const session = new Session(seed);
  const [check, ended] = session.commit({ actorId: "alex", action: { type: "attempt_check", challengeId: "confess" }, judgment: judged(false) });
  assert.ok(check && ended);
  for (const endingId of ["together", "night-ends"]) {
    const replayer = fresh();
    replayer.apply(check.event);
    assert.throws(() => replayer.apply({ ...ended.event, data: { type: "story_ended", endingId } }), corrupt, `${endingId} does not follow a failure`);
  }
  const replayer = fresh();
  replayer.apply(check.event);
  assert.throws(() => replayer.apply({ ...ended.event, requestId: "another-request" }), corrupt, "an ending belongs to its cause's request");
  replayer.apply(ended.event);
  assert.throws(() => replayer.apply(nextEvent(replayer.state!, {
    type: "utterance", actorId: "sam", locationId: "bridge", text: "Wait.", seconds: 10,
  }, { requestId: "after" })), corrupt, "nothing happens after the end");
});

test("worlds without health or stats refuse damage, wounds, and modifiers; endings must refer to what exists", () => {
  const problems = (change: (seed: WorldSeed) => void) => {
    const seed = outageWorld("rules");
    change(seed);
    return worldProblems(seed).map((problem) => `${problem.kind}: ${problem.message}`);
  };
  assert.deepEqual(problems(() => {}), []);
  for (const [change, expected] of [
    [(seed: WorldSeed) => { seed.challenges[0]!.failureDamage = 1; }, "challenge: search-logs deals damage, but this world has no health"],
    [(seed: WorldSeed) => { seed.threats![0]!.damage = 1; }, "threat: Threat social-media deals damage, but this world has no health"],
    [(seed: WorldSeed) => { seed.characters[0]!.hp = 5; }, "character: priya is hurt, but this world has no health"],
    [(seed: WorldSeed) => { seed.rulings!.maxFailureDamage = 2; }, "rules: Open-ended attempts may deal damage, but this world has no health"],
    [(seed: WorldSeed) => { seed.characters[0]!.modifiers.wisdom = 2; }, "character: priya has stats, but this world has none"],
    [(seed: WorldSeed) => { seed.endings![0]!.when = { challengeId: "nowhere", outcome: "success" }; },
      "ending: Ending restored waits on a challenge, threat, or threshold that does not exist"],
    [(seed: WorldSeed) => { seed.endings![1]!.when = { threatId: "nothing" }; },
      "ending: Ending full-outage waits on a challenge, threat, or threshold that does not exist"],
    [(seed: WorldSeed) => { seed.endings!.push({ ...seed.endings![0]!, id: "again" }); },
      "ending: Ending again waits on the same thing as restored, so it can never happen"],
  ] as const) {
    assert.deepEqual(problems(change), [expected]);
  }
  // Stats on: the world names them and modifiers count again.
  const seed = outageWorld("stats");
  seed.rules = { ...seed.rules!, stats: { strength: "Grit", dexterity: "Speed", wisdom: "Insight" } };
  seed.characters[0]!.modifiers.wisdom = 2;
  validateWorld(seed);
});

test("every bundled adventure is a valid world with a fitting cast and nothing the creator would flag", () => {
  for (const adventure of ADVENTURES) {
    const seed = adventure.world(adventure.id);
    validateWorld(seed);
    const cast = castSchema.parse(adventure.cast);
    assert.deepEqual(castProblems(cast, seed.characters, seed.id), [], adventure.id);
    const errors = draftProblems({ seed, cast }).filter((problem) => problem.severity === "error");
    assert.deepEqual(errors, [], adventure.id);
  }
  // The new worlds judge every challenge by what it takes, and every one can end.
  for (const id of ["night-market", "outage", "ashcombe"]) {
    const seed = ADVENTURES.find((adventure) => adventure.id === id)!.world(id);
    assert.equal(rulesOf(seed).outcomes, "judgment", id);
    assert.ok(seed.challenges.every((challenge) => challenge.criteria), id);
    assert.ok((seed.endings ?? []).length > 0, id);
  }
});

test("judged and ended worlds survive storage, restart, and branching", {
  skip: process.env.TEST_DATABASE_URL ? false : "Set TEST_DATABASE_URL to run real PostgreSQL integration tests",
}, async () => {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  let engine = new AdventureEngine(connectionString, { schema });
  try {
    await engine.initialize();
    const seed = placed(nightMarketWorld("stored-market"), { alex: "bridge", sam: "bridge" });
    await engine.createWorld(seed);
    const command = (requestId: string, expectedRevision: number, input: Partial<Command>) => (
      { role: "character", requestId, expectedRevision, actorId: "sam", ...input } as Command
    );
    await engine.execute(seed.id, command("tell", 1, {
      action: { type: "attempt_check", challengeId: "tell-alex", approach: "Say it plainly, then ask" },
      judgment: judged(true, "Sam tells it straight and waits for an answer."),
    }));
    const told = await engine.getWorld(seed.id);
    assert.equal(told.threats!.find((threat) => threat.id === "jordan-arrives")?.status, "disarmed");
    await engine.execute(seed.id, command("confess", told.revision, {
      actorId: "alex", action: { type: "attempt_check", challengeId: "confess" }, judgment: judged(true),
    }));
    const ended = await engine.getWorld(seed.id);
    assert.equal(ended.endedWith, "together");
    await assert.rejects(engine.execute(seed.id, command("late", ended.revision, { speech: "One more thing." })), errorCode("INVALID_ACTION"));

    await engine.close();
    engine = new AdventureEngine(connectionString, { schema });
    assert.deepEqual(await engine.getWorld(seed.id), ended, "replay from storage reaches the same ending");

    const branch = await engine.branchWorld(seed.id, told.revision, "market-branch");
    assert.equal(branch.endedWith, undefined);
    await engine.execute("market-branch", command("other-way", branch.revision, {
      actorId: "alex", action: { type: "attempt_check", challengeId: "confess" }, judgment: judged(false),
    }));
    assert.equal((await engine.getWorld("market-branch")).endedWith, "still-friends");
  } finally {
    await engine.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

test("conversation pace nudges later and never forces an action or stops a talking scene", () => {
  assert.equal(pacePolicy("action", DEFAULT_RUNNER_SETTINGS), DEFAULT_RUNNER_SETTINGS);
  assert.equal(pacePolicy(undefined, DEFAULT_RUNNER_SETTINGS), DEFAULT_RUNNER_SETTINGS);
  const policy = pacePolicy("conversation", DEFAULT_RUNNER_SETTINGS);
  assert.deepEqual(
    { nudgeAfter: policy.nudgeAfter, requireActionAfter: policy.requireActionAfter, stallTurns: policy.stallTurns, conversation: policy.conversation },
    { nudgeAfter: 6, requireActionAfter: 0, stallTurns: 0, conversation: true },
  );
  const talk = (count: number): TurnRecord[] => Array.from({ length: count }, (_, index) => (
    { requestId: `r${index}`, actorId: index % 2 ? "sam" : "alex", npc: false, addresseeId: null, acted: false, endedAt: index * 10 }
  ));
  assert.deepEqual(turnDirection(talk(5), [], "alex", policy), { stalled: 5, nudge: false, requireAction: false, steering: [], conversation: true });
  assert.deepEqual(turnDirection(talk(20), [], "alex", policy), { stalled: 20, nudge: true, requireAction: false, steering: [], conversation: true });
});

const noAction = {
  destinationId: null, recipientId: null, itemId: null, quantity: null, challengeId: null, approach: null, intent: null, minutes: null,
};
const say = (speech: string): ScriptStep => ({ role: "character", output: { speech, to: null, action: null } });
const act = (speech: string | null, action: Record<string, unknown>): ScriptStep => (
  { role: "character", output: { speech, to: null, action: { ...noAction, ...action } } }
);
const narrate = (narration: string): ScriptStep => ({ role: "dm", output: { narration } });
const unruled = { challengeId: null, name: null, ability: null, difficulty: null, failureDamage: null, minutes: null, success: null, verdict: null };
const rule = (ruling: Record<string, unknown>): ScriptStep => ({ role: "dm", output: { ...unruled, ...ruling } });
const label = (outcome: StepOutcome): string => {
  if (outcome.kind === "narration") return "narration";
  if (outcome.kind === "cancelled") return "cancelled";
  const who = outcome.kind === "turn" ? outcome.actorId : `failed:${outcome.actorId ?? "narrator"}`;
  return outcome.attempts > 1 ? `${who}×${outcome.attempts}` : who;
};
const CRITERIA_CANARY = "narrow the search by time";
const FANTASY = /\bHP\b|Strength|Dexterity|adventur|dungeon|\bparty\b/i;
const text = (request: ModelRequest) => `${request.system}\n${request.prompt}`;

test("judgment worlds with agents", {
  skip: process.env.TEST_DATABASE_URL ? false : "Set TEST_DATABASE_URL to run real PostgreSQL integration tests",
}, async (t) => {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  const engine = new AdventureEngine(connectionString, { schema });
  const scripted = (steps: ScriptStep[], cast: Cast) => {
    const provider = new ScriptedProvider(steps);
    return { provider, runner: new TurnRunner(engine, provider, cast) };
  };
  const eventsOf = async (worldId: string, type: string) => (await engine.getEvents(worldId)).filter((event) => event.data.type === type);
  try {
    await engine.initialize();

    await t.test("a listed challenge goes to the referee with its approach; only the referee reads what it takes", async () => {
      const { id } = await engine.createWorld(placed(outageWorld("judge-check"), { priya: "logs" }));
      const { provider, runner } = scripted([
        act("Filtering to the minute it broke.", { type: "attempt_check", challengeId: "search-logs", approach: "Filter checkout errors around 02:58" }),
        { role: "dm", output: { success: true, reason: "Narrowing to 02:58 surfaces the first errors." } },
        narrate("The first red line appears at 02:58:03."),
      ], outageCast);
      const outcomes = await runner.step(id, undefined, { actorId: "priya" });
      assert.deepEqual(outcomes.map(label), ["priya", "narration"]);
      const [check] = await eventsOf(id, "check_resolved");
      assert.ok(check?.data.type === "check_resolved");
      assert.equal(check.data.reason, "Narrowing to 02:58 surfaces the first errors.");
      assert.equal(check.data.approach, "Filter checkout errors around 02:58");
      assert.equal(check.data.roll, undefined);

      const [character, judge, narrator] = provider.requests;
      assert.equal(judge?.schemaName, "judge");
      assert.match(judge!.prompt, new RegExp(CRITERIA_CANARY));
      assert.match(judge!.prompt, /Filter checkout errors around 02:58/);
      for (const request of [character!, narrator!]) {
        assert.doesNotMatch(text(request), new RegExp(CRITERIA_CANARY), request.schemaName);
      }
      for (const request of provider.requests) assert.doesNotMatch(text(request), FANTASY, request.schemaName);
    });

    await t.test("an attempt the engine would refuse is sent back before the referee is asked", async () => {
      const { id } = await engine.createWorld(placed(outageWorld("judge-refused"), { priya: "logs" }));
      const { provider, runner } = scripted([
        act(null, { type: "attempt_check", challengeId: "inspect-certificate" }),
        say("Wrong console. Heading back."),
      ], outageCast);
      assert.deepEqual((await runner.step(id, undefined, { actorId: "priya" })).map(label), ["priya×2"]);
      assert.equal(provider.requests.length, 2, "no referee call");
      assert.match(provider.requests[1]!.prompt, /The engine rejected your proposal/);
    });

    await t.test("an open attempt is ruled and judged in one call: new, automatic, or impossible", async () => {
      const { id } = await engine.createWorld(outageWorld("judge-open"));
      const { provider, runner } = scripted([
        act(null, { type: "attempt", intent: "Page the security team" }),
        rule({ decision: "new", name: "Reach security", difficulty: "moderate", minutes: 2, reason: "At 3 a.m. it is a long shot.", success: false, verdict: "Nobody answers the page." }),
        narrate("The page rings out unanswered."),
        act(null, { type: "attempt", intent: "Refresh the dashboard" }),
        rule({ decision: "automatic", minutes: 1, reason: "Anyone can refresh a page." }),
        narrate("Still red."),
        act(null, { type: "attempt", intent: "Drive to the data center" }),
        rule({ decision: "impossible", reason: "The data center is a thousand miles away." }),
        say("Fine. Logs it is."),
      ], outageCast);
      for (const expected of [["dan", "narration"], ["dan", "narration"], ["dan×2"]]) {
        assert.deepEqual((await runner.step(id, undefined, { actorId: "dan" })).map(label), expected);
      }
      const [ruling] = await eventsOf(id, "ruling");
      assert.ok(ruling?.data.type === "ruling" && ruling.data.decision === "new");
      assert.equal(ruling.data.challenge?.ability, "wisdom", "a world without stats gets its first allowed stat");
      assert.equal(ruling.data.challenge?.failureDamage, 0);
      const [check] = await eventsOf(id, "check_resolved");
      assert.ok(check?.data.type === "check_resolved");
      assert.deepEqual([check.data.success, check.data.reason], [false, "Nobody answers the page."]);
      assert.match(provider.requests.at(-1)!.prompt, /thousand miles away/);
    });

    await t.test("the referee hears what the character says as they make the attempt", async () => {
      const { id } = await engine.createWorld(placed(outageWorld("judge-hears"), { priya: "logs" }));
      const { provider, runner } = scripted([
        act("Scoping it to checkout, 02:58 to 03:00.", { type: "attempt_check", challengeId: "search-logs", approach: "Filter the logs" }),
        { role: "dm", output: { success: true, reason: "Scoped to checkout at 02:58, the first error stands out." } },
        narrate("One red line."),
        act("Paging security, it's urgent.", { type: "attempt", intent: "Page the security team" }),
        rule({ decision: "automatic", minutes: 1, reason: "Anyone can send a page." }),
        narrate("The page goes out."),
      ], outageCast);
      await runner.step(id, undefined, { actorId: "priya" });
      await runner.step(id, undefined, { actorId: "priya" });
      const [, judge, , , ruling] = provider.requests;
      assert.equal(judge!.schemaName, "judge");
      assert.match(judge!.prompt, /As they do it, Priya says: "Scoping it to checkout, 02:58 to 03:00\."/);
      assert.match(judge!.system, /What the character says as they make the attempt is part of how they go about it/);
      assert.match(ruling!.prompt, /As they do it, Priya says: "Paging security, it's urgent\."/);
    });

    await t.test("a supporting character doesn't hand over what an attempt just failed to get from them", async () => {
      const { id } = await engine.createWorld(outageWorld("npc-holds"));
      const { provider, runner } = scripted([
        { role: "character", output: {
          speech: "Morgan, I need gateway admin. Trust me.", to: "morgan",
          action: { ...noAction, type: "attempt_check", challengeId: "get-access", approach: "Ask Morgan for access" },
        } },
        { role: "dm", output: { success: false, reason: "Priya offered no evidence." } },
        narrate("Morgan shakes their head."),
        { role: "dm", output: { speech: "Not on a hunch.", to: "priya", move: null, leave: false } },
        { role: "character", output: { speech: "Fair. I'll get you the logs.", to: "morgan", action: null } },
        { role: "dm", output: { speech: "Good.", to: "priya", move: null, leave: false } },
      ], outageCast);
      await runner.step(id, undefined, { actorId: "priya" });
      await runner.step(id, undefined, { actorId: "morgan" });
      const first = provider.requests[3]!;
      assert.match(first.prompt, /## Attempts that just failed in front of you\n- Priya tried "Get break-glass access", and it didn't work\. The referee: Priya offered no evidence\./);
      assert.match(first.prompt, /you did not give it: don't hand it over now in your own words/);
      assert.match(first.system, /If someone failed to get something from you, you didn't give it/);

      await runner.step(id, undefined, { actorId: "priya" });
      await runner.step(id, undefined, { actorId: "morgan" });
      assert.doesNotMatch(provider.requests[5]!.prompt, /Attempts that just failed/, "once Morgan has spoken since, the notice is gone");
    });

    await t.test("a talking scene keeps going at conversation pace", async () => {
      const { id } = await engine.createWorld(nightMarketWorld("talk"));
      const { provider, runner } = scripted(Array.from({ length: 9 }, (_, index) => say(`Line ${index + 1}.`)), nightMarketCast);
      const report = await runner.run(id, { maxTurns: 9 });
      assert.equal(report.stopReason, "max_turns");
      assert.ok(provider.requests.every((request) => !/you must take an action/.test(request.prompt)));
      assert.match(provider.requests.at(-1)!.prompt, /The scene is going in circles/);
      assert.doesNotMatch(provider.requests[0]!.system, /If talking is not getting anywhere/);
      assert.match(provider.requests[0]!.prompt, /Charm/);
      assert.doesNotMatch(text(provider.requests[0]!), /\bHP\b|Dexterity/);
    });

    await t.test("a run stops when the story ends, after narrating the ending", async () => {
      const { id } = await engine.createWorld(placed(nightMarketWorld("finale"), { alex: "bridge", sam: "bridge" }));
      const { runner } = scripted([
        act("Sam, I need to tell you something.", { type: "attempt_check", challengeId: "confess" }),
        { role: "dm", output: { success: true, reason: "It comes out plainly, and Sam hears every word." } },
        narrate("Sam laughs, then doesn't."),
      ], nightMarketCast);
      const report = await runner.run(id, { maxTurns: 5 });
      assert.equal(report.stopReason, "ended");
      assert.deepEqual(report.outcomes.map(label).slice(-1), ["narration"]);
      assert.equal((await engine.getWorld(id)).endedWith, "together");
      await assert.rejects(runner.step(id, undefined, { actorId: "sam" }), /The story has ended/);
    });

    await t.test("a run retries the ending's narration when the narrator fails, before it stops", async () => {
      const { id } = await engine.createWorld(placed(nightMarketWorld("finale-retry"), { alex: "bridge", sam: "bridge" }));
      const { runner } = scripted([
        act("Sam, I need to tell you something.", { type: "attempt_check", challengeId: "confess" }),
        { role: "dm", output: { success: true, reason: "It comes out plainly." } },
        { role: "dm", error: new ProviderError("timeout", "No reply within 120 s") },
        narrate("Sam laughs, then doesn't."),
      ], nightMarketCast);
      const report = await runner.run(id, { maxTurns: 5 });
      assert.equal(report.stopReason, "ended");
      assert.deepEqual(report.outcomes.map(label), ["alex", "failed:narrator", "narration"]);
      assert.equal(report.turns, 1);
      const [check] = await eventsOf(id, "check_resolved");
      const [ended] = await eventsOf(id, "story_ended");
      const [narration] = await eventsOf(id, "narration");
      assert.ok(check && ended && narration?.data.type === "narration");
      assert.deepEqual(narration.data.aboutSequences, [check.sequence]);
      assert.ok(narration.sequence > ended.sequence, "the ending is narrated after it is recorded");
    });

    await t.test("narration leaves out an arrival elsewhere that a threat caused during the turn", async () => {
      const seed = placed(outageWorld("arrival-elsewhere"), { priya: "gateway" });
      seed.characters = seed.characters.map((character) => (
        character.id === "priya" ? { ...character, inventory: { "admin-token": 1 } } : character
      ));
      seed.threats = seed.threats!.map((threat) => (threat.id === "vp-joins" ? { ...threat, at: 60 } : threat));
      const { id } = await engine.createWorld(seed);
      const { provider, runner } = scripted([
        act(null, { type: "attempt_check", challengeId: "rotate-certificate", approach: "Issue a new certificate and reload" }),
        { role: "dm", output: { success: true, reason: "The reload takes." } },
        narrate("The gateway reloads."),
      ], outageCast);
      assert.equal((await runner.run(id, { maxTurns: 5 })).stopReason, "ended");
      const [check] = await eventsOf(id, "check_resolved");
      const [entered] = await eventsOf(id, "character_entered");
      const [narration] = await eventsOf(id, "narration");
      assert.ok(check && entered && narration?.data.type === "narration");
      assert.deepEqual(narration.data.aboutSequences, [check.sequence]);
      assert.deepEqual(await engine.getPerceivers(id, narration.sequence), ["priya"], "only the one at the gateway hears it");
      assert.doesNotMatch(provider.requests.at(-1)!.prompt, /Sloane/);
    });
  } finally {
    await engine.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
