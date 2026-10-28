import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { REHEARSAL_ROLL, REHEARSAL_TURNS, rehearsalScript } from "../src/adventures/rehearsal.ts";
import { starterCast, starterWorld } from "../src/adventures/starter.ts";
import { computeMetrics } from "../src/agents/metrics.ts";
import { OpenRouterProvider } from "../src/agents/openrouter.ts";
import type { Cast } from "../src/agents/prompts.ts";
import { ProviderError, ScriptedProvider } from "../src/agents/provider.ts";
import type { ScriptStep } from "../src/agents/provider.ts";
import { TurnRunner } from "../src/agents/runner.ts";
import type { RunnerSettings, StepOutcome } from "../src/agents/runner.ts";
import { AdventureEngine } from "../src/engine.ts";
import type { WorldSeed } from "../src/model.ts";
import { sampleWorld } from "../src/sample-world.ts";
import { errorCode, fixed } from "./support.ts";

const connectionString = process.env.TEST_DATABASE_URL;

const none = {
  destinationId: null, recipientId: null, itemId: null, quantity: null, challengeId: null, intent: null, minutes: null,
};
const say = (speech: string, to: string | null = null): ScriptStep => ({ role: "character", output: { speech, to, action: null } });
const act = (speech: string | null, action: Record<string, unknown>): ScriptStep => (
  { role: "character", output: { speech, to: null, action: { ...none, ...action } } }
);
const attempt = (intent: string): ScriptStep => act(null, { type: "attempt", intent });
const narrate = (narration: string): ScriptStep => ({ role: "dm", output: { narration } });
const unruled = { challengeId: null, name: null, ability: null, difficulty: null, failureDamage: null, minutes: null };
const rule = (ruling: Record<string, unknown>): ScriptStep => ({ role: "dm", output: { ...unruled, ...ruling } });

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

test("turn runner integration", {
  skip: connectionString ? false : "Set TEST_DATABASE_URL to run real PostgreSQL integration tests",
}, async (t) => {
  assert.ok(connectionString);
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  const engine = new AdventureEngine(connectionString, { schema, roll: fixed(REHEARSAL_ROLL) });
  const scripted = (steps: ScriptStep[], cast = sampleCast, settings: Partial<RunnerSettings> = {}) => {
    const provider = new ScriptedProvider(steps);
    return { provider, runner: new TurnRunner(engine, provider, cast, settings) };
  };
  const create = async (seed: WorldSeed) => (await engine.createWorld(seed)).id;
  const speakers = async (worldId: string) => (await engine.getEvents(worldId))
    .filter((event) => event.data.type === "utterance")
    .map((event) => ("actorId" in event.data ? event.data.actorId : ""));
  try {
    await engine.initialize();

    await t.test("the scripted rehearsal runs end to end, and replay reproduces state and perceivers", async () => {
      const worldId = await create(starterWorld("rehearsal"));
      const { provider, runner } = scripted(rehearsalScript(), starterCast);
      const report = await runner.run(worldId, { maxTurns: REHEARSAL_TURNS });
      assert.equal(report.stopReason, "max_turns");
      assert.equal(report.turns, REHEARSAL_TURNS);
      assert.equal(report.modelCalls, 14);
      assert.equal(provider.remaining, 0);
      // Tamsin answers only because Mira spoke to her; Bram answers Mira's call.
      assert.deepEqual(report.outcomes.map(label), [
        "mira", "tamsin", "mira", "narration", "bram", "narration", "elowen", "mira×2", "bram", "narration",
        "elowen", "narration",
      ]);
      const state = await engine.getWorld(worldId);
      assert.deepEqual(await engine.replayWorld(worldId), state);
      assert.equal(state.challenges.find((challenge) => challenge.id === "pry-bars")?.resolved, true);
      assert.equal(state.characters.find((character) => character.id === "elowen")?.locationId, "channel");
      const events = await engine.getEvents(worldId);
      assert.deepEqual(events[2]?.data, {
        type: "utterance", actorId: "tamsin", locationId: "camp", addresseeId: "mira", seconds: 10,
        text: "Through the aqueduct mouth, if your big friend can shift rusted bars. Few come back out of that channel, mind.",
      });
      assert.equal(events[2]?.source, "dm");
      // The ruling committed before the roll it called for.
      assert.deepEqual(events.slice(14, 16).map((event) => event.data.type), ["ruling", "check_resolved"]);
      assert.deepEqual(events[14]?.data, {
        type: "ruling", actorId: "bram", intent: "heave the bars apart with the crowbar", decision: "existing",
        challengeId: "pry-bars", reason: "Levering the bars apart is exactly what the crowbar is for.",
      });
      // Mira's move from camp was seen at both ends, and so was its narration.
      assert.deepEqual(await engine.getPerceivers(worldId, 6), ["bram", "elowen", "mira", "tamsin"]);
      assert.deepEqual(await engine.getPerceivers(worldId, 7), ["bram", "elowen", "mira", "tamsin"]);
      // Tamsin's warning stays hearsay in Mira's note; the note and Bram's commitment are private.
      assert.deepEqual(events[4]?.data, {
        type: "belief_noted", actorId: "mira", about: "channel", attribute: "danger", value: "Few who go in come back out",
        evidence: [3], confidence: "low", source: "reported",
      });
      assert.deepEqual(await engine.getPerceivers(worldId, 5), ["mira"]);
      assert.deepEqual(await engine.getPerceivers(worldId, 9), ["bram"]);
      assert.deepEqual(state.characters.find((character) => character.id === "bram")?.goals, [
        { id: "goal-9", kind: "commitment", text: "Get those bars open for Mira", status: "adopted" },
      ]);
      assert.match(provider.requests[7]!.prompt, /Dry Channel \(channel\), danger: Few who go in come back out \[hearsay from #3; low confidence\]/);
      assert.match(provider.requests[9]!.prompt, /- goal-9 \(commitment\): Get those bars open for Mira/);
      // Nobody else sees them: not Tamsin, Elowen, the referee, or the narrator; not each other.
      const sees = (index: number, text: string) => provider.requests[index]!.prompt.includes(text);
      for (const index of [1, 3, 4, 5, 6, 9, 10, 11, 12, 13]) assert.ok(!sees(index, "Few who go in"), `request ${index} saw Mira's note`);
      for (const index of [5, 6, 7, 8, 10, 11, 12, 13]) assert.ok(!sees(index, "Get those bars open"), `request ${index} saw Bram's goal`);
      // The engine's reason for rejecting Mira's proposal went back to her agent.
      const traces = await engine.getTraces(worldId, 50);
      assert.deepEqual(traces.map((trace) => trace.task), [
        "character_turn", "npc_turn", "character_turn", "narration", "character_turn", "narration", "character_turn",
        "character_turn", "character_turn", "ruling", "character_turn", "narration", "character_turn", "narration",
      ]);
      assert.deepEqual(traces.filter((trace) => trace.outcome !== "committed").map((trace) => [trace.turnId, trace.outcome]), [
        ["t12-mira", "invalid_action"], ["t13-bram", "ruled"],
      ]);
      assert.match(
        provider.requests[8]!.prompt,
        /The engine rejected your proposal: pry-bars requires crowbar, which mira does not carry/,
      );
      assert.match(provider.requests[1]!.prompt, /Mira said to you: "You there\. Is there a way into that city\?"/);
      const metrics = computeMetrics(events, traces, state);
      assert.deepEqual([metrics.characterTurns, metrics.npcTurns, metrics.turnsToFirstAction], [7, 1, 2]);
      assert.deepEqual(metrics.turnsByActor, { mira: 3, tamsin: 1, bram: 2, elowen: 2 });
      assert.deepEqual(metrics.rulings, { existing: 1, new: 0, automatic: 0, impossible: 0 });
      assert.equal(metrics.invalidProposalRate, 1 / 10);
      assert.equal(metrics.cost, null);
    });

    await t.test("characters perceive only their location, and narration reaches only its audience (canary)", async () => {
      const worldId = await create(sampleWorld("canary"));
      const { provider, runner } = scripted([
        say("Morning, Bram."),
        say("Morning."),
        act("CANARY-RIDGE-41 is carved into this rock.", { type: "wait", minutes: 1 }),
        narrate("CANARY-NARRATION-77: the wind shifts on the ridge."),
        act("Quiet out here.", { type: "wait", minutes: 1 }),
        narrate("The gate creaks."),
      ]);
      await runner.run(worldId, { maxTurns: 4 });
      assert.equal(provider.remaining, 0);
      const miraTurn = provider.requests[4]!;
      const gateNarrator = provider.requests[5]!;
      assert.match(miraTurn.prompt, /Bram said: "Morning\."/, "positive control: Mira hears Bram");
      for (const request of [miraTurn, gateNarrator]) {
        for (const hidden of ["CANARY-RIDGE-41", "CANARY-NARRATION-77", "torch", "Torch"]) {
          assert.ok(!request.prompt.includes(hidden), `${request.role} prompt must not contain ${hidden}`);
        }
        assert.doesNotMatch(request.prompt, /Rolled|against \d/);
      }
      const perceived = async (characterId: string) => (await engine.getPerceivedEvents(worldId, characterId))
        .map((event) => JSON.stringify(event.data));
      assert.ok((await perceived("elowen")).some((data) => data.includes("CANARY-NARRATION-77")));
      assert.ok((await perceived("elowen")).some((data) => data.includes("CANARY-RIDGE-41")));
      for (const characterId of ["mira", "bram"]) {
        assert.ok(!(await perceived(characterId)).some((data) => data.includes("CANARY")));
      }
    });

    await t.test("a rejected action returns the engine's reason; past the revision limit the turn fails uncommitted", async () => {
      const worldId = await create(sampleWorld("revisions"));
      const nowhere = act("Let's go.", { type: "move", destinationId: "nowhere" });
      const { provider, runner } = scripted([nowhere, nowhere, nowhere], sampleCast, { maxRevisions: 2 });
      assert.deepEqual(await runner.step(worldId), [{
        kind: "failed", role: "character", actorId: "mira", attempts: 3, reason: "No route from gate to nowhere",
      }]);
      assert.equal((await engine.getWorld(worldId)).revision, 1);
      assert.deepEqual((await engine.getTraces(worldId)).map((trace) => trace.outcome), [
        "invalid_action", "invalid_action", "invalid_action",
      ]);
      assert.match(provider.requests[1]!.prompt, /The engine rejected your proposal: No route from gate to nowhere/);
      assert.doesNotMatch(provider.requests[0]!.prompt, /rejected/);
    });

    await t.test("invalid output is traced and sent back as feedback", async () => {
      const worldId = await create(sampleWorld("invalid-output"));
      const { provider, runner } = scripted([
        { role: "character", output: { speech: 5 } },
        { role: "character", output: { speech: null, to: null, action: { ...none, type: "wait" } } },
        say("Sorry. Hello."),
      ]);
      assert.deepEqual((await runner.step(worldId)).map(label), ["mira×3"]);
      assert.deepEqual((await engine.getTraces(worldId)).map((trace) => trace.outcome), [
        "invalid_output", "invalid_output", "committed",
      ]);
      assert.match(provider.requests[1]!.prompt, /did not match the turn format/);
      assert.match(provider.requests[2]!.prompt, /wait requires minutes/);
    });

    await t.test("invalid narration is revised before it commits", async () => {
      const worldId = await create(sampleWorld("narration-revisions"));
      const { runner } = scripted([
        act(null, { type: "wait", minutes: 1 }), narrate("  "), narrate("x".repeat(1001)), narrate("Time passes."),
      ]);
      assert.deepEqual((await runner.step(worldId)).map(label), ["mira", "narration×3"]);
      const narration = (await engine.getEvents(worldId)).at(-1)?.data;
      assert.deepEqual(narration, { type: "narration", aboutSequences: [2], text: "Time passes." });
    });

    await t.test("provider failures fail the turn at once; a run stops after consecutive failures", async () => {
      const refused = new ProviderError("refused", "The model declined", { usage: { inputTokens: 100, outputTokens: 0 } });
      const timeout = new ProviderError("timeout", "No reply within 60 s");
      const worldId = await create(sampleWorld("provider-errors"));
      const { runner } = scripted([
        { role: "character", error: refused },
        { role: "character", error: timeout },
      ], sampleCast, { maxConsecutiveFailures: 2 });
      const report = await runner.run(worldId, { maxTurns: 10 });
      assert.equal(report.stopReason, "consecutive_failures");
      assert.deepEqual([report.turns, report.modelCalls, report.tokens], [2, 2, 100]);
      assert.deepEqual(report.outcomes.map((outcome) => outcome.kind === "failed" && outcome.reason), [
        "refused: The model declined", "timeout: No reply within 60 s",
      ]);
      const traces = await engine.getTraces(worldId);
      assert.deepEqual(traces.map((trace) => [trace.outcome, trace.inputTokens]), [["provider_error", 100], ["provider_error", null]]);
      assert.equal((await engine.getWorld(worldId)).revision, 1);

      // A successful turn resets the count.
      const flakyWorld = await create(sampleWorld("provider-flaky"));
      const { runner: flaky } = scripted([
        { role: "character", error: timeout }, say("Still here."),
        { role: "character", error: timeout }, { role: "character", error: timeout },
      ], sampleCast, { maxConsecutiveFailures: 2 });
      const flakyReport = await flaky.run(flakyWorld, { maxTurns: 10 });
      assert.equal(flakyReport.stopReason, "consecutive_failures");
      assert.deepEqual(flakyReport.outcomes.map(label), ["failed:mira", "mira", "failed:bram", "failed:bram"]);
    });

    await t.test("a run stops at its call and token budgets; owed narration comes first next time", async () => {
      const worldId = await create(sampleWorld("call-budget"));
      const { runner } = scripted([act("Ridge, then.", { type: "move", destinationId: "ridge" })]);
      const report = await runner.run(worldId, { maxTurns: 5, maxModelCalls: 1 });
      assert.equal(report.stopReason, "max_model_calls");
      assert.deepEqual([report.turns, report.modelCalls], [1, 1]);
      assert.deepEqual(report.outcomes.map(label), ["mira"]);

      const { provider, runner: resumed } = scripted([narrate("Mira climbs toward the ridge."), say("Safe travels.")]);
      assert.deepEqual((await resumed.step(worldId)).map(label), ["narration", "bram"]);
      assert.equal(provider.remaining, 0);
      const narration = (await engine.getEvents(worldId)).find((event) => event.data.type === "narration");
      assert.deepEqual(narration?.data.type === "narration" && narration.data.aboutSequences, [3]);

      const tokenWorld = await create(sampleWorld("token-budget"));
      const { runner: wordy } = scripted([say("One."), say("Two.")]);
      const tokenReport = await wordy.run(tokenWorld, { maxTurns: 5, maxTokens: 1 });
      assert.equal(tokenReport.stopReason, "max_tokens");
      assert.deepEqual([tokenReport.turns, tokenReport.modelCalls], [1, 1]);
    });

    await t.test("a run stops after consecutive turns without an action", async () => {
      const worldId = await create(sampleWorld("stall"));
      const settings = { stallTurns: 3 };
      const { runner } = scripted([say("We should go."), say("Agreed."), say("Soon."), say("Unused.")], sampleCast, settings);
      const report = await runner.run(worldId, { maxTurns: 10 });
      assert.deepEqual([report.stopReason, report.turns], ["stalled", 3]);
      const { runner: stillStalled } = scripted([], sampleCast, settings);
      assert.equal((await stillStalled.run(worldId, { maxTurns: 1 })).stopReason, "stalled");
      // An explicit step can still act, which clears the stall.
      const { runner: mover } = scripted([act(null, { type: "wait", minutes: 1 }), narrate("Time passes.")], sampleCast, settings);
      await mover.step(worldId);
      const { runner: unstuck } = scripted([say("Finally.")], sampleCast, settings);
      assert.equal((await unstuck.run(worldId, { maxTurns: 1 })).stopReason, "max_turns");
    });

    await t.test("speakers rotate in world order, skip those who cannot act, and continue across restarts", async () => {
      const seed = sampleWorld("rotation");
      seed.characters.find((character) => character.id === "bram")!.hp = 0;
      const worldId = await create(seed);
      await scripted([say("One.")]).runner.step(worldId);
      const { runner: restarted } = scripted([say("Two."), say("Three.")]);
      await restarted.step(worldId);
      await restarted.step(worldId);
      assert.deepEqual(await speakers(worldId), ["mira", "elowen", "mira"]);

      const soloCast: Cast = { narratorStyle: "Plain.", characters: { elowen: sampleCast.characters.elowen! } };
      const { runner: solo } = scripted([say("Four."), say("Five.")], soloCast);
      await solo.step(worldId);
      await solo.step(worldId);
      assert.deepEqual((await speakers(worldId)).slice(3), ["elowen", "elowen"]);

      const nobodyCast: Cast = { narratorStyle: "Plain.", characters: { bram: sampleCast.characters.bram! } };
      const { provider, runner: nobody } = scripted([], nobodyCast);
      assert.equal((await nobody.run(worldId, { maxTurns: 3 })).stopReason, "no_active_characters");
      assert.deepEqual(await nobody.step(worldId), []);
      assert.equal(provider.requests.length, 0);
    });

    await t.test("a stale proposal is regenerated from fresh context", async () => {
      const worldId = await create(sampleWorld("stale"));
      const { provider, runner } = scripted([
        {
          role: "character",
          respond: async () => {
            // Another writer commits while Mira's reply is being generated.
            await engine.execute(worldId, {
              role: "character", requestId: "interloper", expectedRevision: 1, actorId: "bram", speech: "Wait for me.",
            });
            return { speech: "Let's go.", to: null, action: null };
          },
        },
        say("You said wait, Bram?"),
      ]);
      const [outcome] = await runner.step(worldId);
      assert.ok(outcome?.kind === "turn");
      assert.equal(outcome.attempts, 2);
      assert.equal(outcome.events[0]?.requestId, "t2-mira");
      assert.deepEqual((await engine.getTraces(worldId)).map((trace) => [trace.turnId, trace.outcome]), [
        ["t1-mira", "stale"], ["t2-mira", "committed"],
      ]);
      assert.match(provider.requests[1]!.prompt, /Bram said: "Wait for me\."/);
    });

    await t.test("a duplicated turn cannot commit twice", async () => {
      for (const [worldName, words, expected] of [
        ["duplicate-different", "B's words.", ["failed:mira"]],
        ["duplicate-identical", "A's words.", ["mira"]],
      ] as const) {
        const worldId = await create(sampleWorld(worldName));
        // A runner whose lease lapsed commits the same turn while this one generates it.
        const { runner: second } = scripted([{
          role: "character",
          respond: async () => {
            await engine.execute(worldId, {
              role: "character", requestId: "t1-mira", expectedRevision: 1, actorId: "mira", speech: "A's words.",
            });
            return { speech: words, to: null, action: null };
          },
        }]);
        assert.deepEqual((await second.step(worldId)).map(label), expected);
        const utterances = (await engine.getEvents(worldId)).filter((event) => event.data.type === "utterance");
        assert.equal(utterances.length, 1);
      }
    });

    await t.test("step runs exactly one turn, and nothing runs without step or run", async () => {
      const worldId = await create(sampleWorld("explicit"));
      const { provider, runner } = scripted([
        act("Up to the ridge.", { type: "move", destinationId: "ridge" }), narrate("Mira climbs."), say("Unused."),
      ]);
      assert.equal(provider.requests.length, 0);
      assert.equal((await engine.getWorld(worldId)).revision, 1);
      assert.deepEqual((await runner.step(worldId)).map(label), ["mira", "narration"]);
      assert.equal(provider.remaining, 1);
      const { runner: silent } = scripted([act(null, { type: "wait", minutes: 1 })], sampleCast, { narrate: false });
      assert.deepEqual((await silent.step(worldId)).map(label), ["bram"]);
    });

    await t.test("the addressed character answers, but nobody waits more than a round", async () => {
      const worldId = await create(sampleWorld("address"));
      const { provider, runner } = scripted([
        say("Bram?", "bram"), say("Mira.", "mira"), say("Bram!", "bram"), say("Hello, ridge."), say("My turn at last."),
      ]);
      await runner.run(worldId, { maxTurns: 5 });
      assert.equal(provider.remaining, 0);
      // Elowen interrupts the ping-pong after a full round; then Bram has waited longest.
      assert.deepEqual(await speakers(worldId), ["mira", "bram", "mira", "elowen", "bram"]);
      const events = await engine.getEvents(worldId);
      assert.deepEqual(
        events.slice(1, 4).map((event) => event.data.type === "utterance" && event.data.addresseeId),
        ["bram", "mira", "bram"],
      );

      const absentWorld = await create(sampleWorld("address-absent"));
      const { provider: absent, runner: caller } = scripted([say("Elowen?", "elowen"), say("Never mind.")]);
      assert.deepEqual((await caller.step(absentWorld)).map(label), ["mira×2"]);
      assert.match(absent.requests[1]!.prompt, /The engine rejected your proposal: elowen is not here to hear mira/);
    });

    await t.test("NPCs speak only when spoken to, through the DM, and may walk away", async () => {
      const worldId = await create(starterWorld("npc"));
      const { provider, runner } = scripted([
        say("Ready, Bram?", "bram"),
        say("Ready."),
        say("Hurry up there."),
        say("Which way, grandmother?", "tamsin"),
        { role: "dm", output: { speech: "Down to the mouth. I'll show you.", to: "mira", move: "mouth" } },
      ], starterCast);
      const report = await runner.run(worldId, { maxTurns: 5 });
      assert.equal(provider.remaining, 0);
      assert.deepEqual(report.outcomes.map(label), ["mira", "bram", "elowen", "mira", "tamsin"]);
      const events = await engine.getEvents(worldId);
      assert.deepEqual(events.slice(-2).map((event) => [event.source, event.data.type]), [
        ["dm", "utterance"], ["dm", "character_moved"],
      ]);
      const state = await engine.getWorld(worldId);
      assert.equal(state.characters.find((character) => character.id === "tamsin")?.locationId, "mouth");
      assert.deepEqual(await engine.replayWorld(worldId), state);
      assert.match(provider.requests[4]!.system, /You are voicing Old Tamsin/);

      // Without a persona, an NPC stays silent and the turn passes on.
      const mute = await create(starterWorld("npc-mute"));
      const { runner: muteRunner } = scripted([say("Grandmother?", "tamsin"), say("She's asleep.")], { ...starterCast, npcs: {} });
      await muteRunner.run(mute, { maxTurns: 2 });
      assert.deepEqual(await speakers(mute), ["mira", "bram"]);
    });

    await t.test("an open-ended attempt is ruled within the world's limits, and the ruling commits before the roll", async () => {
      const worldId = await create(starterWorld("rulings"));
      const elowenCast: Cast = { narratorStyle: "Plain.", characters: { elowen: starterCast.characters.elowen! } };
      const climb = { decision: "new", name: "Climb the arch", ability: "dexterity", failureDamage: 2, minutes: 3, reason: "Crumbling brick." };
      const { provider, runner } = scripted([
        attempt("fly over the bars"),
        rule({ decision: "impossible", reason: "Nobody here can fly." }),
        attempt("climb the arch above the bars"),
        rule({ ...climb, difficulty: "very hard" }),
        rule({ ...climb, difficulty: "hard" }),
        narrate("Elowen hauls herself onto the arch."),
      ], elowenCast);
      assert.deepEqual((await runner.step(worldId)).map(label), ["elowen×2", "narration"]);
      assert.equal(provider.remaining, 0);
      assert.deepEqual((await engine.getTraces(worldId)).map((trace) => [trace.task, trace.outcome]), [
        ["ruling", "ruled_impossible"], ["character_turn", "ruled_impossible"],
        ["ruling", "invalid_ruling"], ["ruling", "ruled"], ["character_turn", "committed"],
        ["narration", "committed"],
      ]);
      assert.match(provider.requests[2]!.prompt, /The referee ruled that "fly over the bars" cannot work: Nobody here can fly\./);
      assert.match(provider.requests[4]!.prompt, /The engine rejected your ruling: Difficulty must be a band up to hard/);
      const [ruling, check, narration] = (await engine.getEvents(worldId)).slice(1);
      assert.ok(ruling?.data.type === "ruling" && check?.data.type === "check_resolved");
      assert.equal(ruling.source, "dm");
      assert.equal(ruling.data.challengeId, "ruled-2");
      assert.deepEqual(
        [ruling.data.challenge?.ability, ruling.data.challenge?.difficulty, ruling.data.challenge?.failureDamage],
        ["dexterity", 16, 2],
      );
      assert.deepEqual([check.data.challengeId, check.data.roll, check.data.modifier, check.data.success], ["ruled-2", 15, 1, true]);
      assert.deepEqual(narration?.data.type === "narration" && narration.data.aboutSequences, [2, 3]);
      const state = await engine.getWorld(worldId);
      assert.equal(state.elapsedSeconds, 180);
      assert.deepEqual(await engine.replayWorld(worldId), state);

      // A world without ruling limits offers no attempt action.
      const plain = await create(sampleWorld("no-rulings"));
      const { provider: plainProvider, runner: plainRunner } = scripted([attempt("dig"), say("Never mind.")]);
      assert.deepEqual((await plainRunner.step(plain)).map(label), ["mira×2"]);
      assert.match(plainProvider.requests[1]!.prompt, /attempt is not one of your available actions/);
    });

    await t.test("pausing cancels an unfinished turn before it commits", async () => {
      const worldId = await create(sampleWorld("pause"));
      const pause = new AbortController();
      const { runner } = scripted([{
        role: "character",
        respond: () => {
          pause.abort();
          return { speech: "Too late.", to: null, action: null };
        },
      }]);
      const report = await runner.run(worldId, { maxTurns: 5 }, undefined, { signal: pause.signal });
      assert.deepEqual([report.stopReason, report.turns], ["paused", 0]);
      assert.deepEqual(report.outcomes.map(label), ["cancelled:mira"]);
      assert.equal((await engine.getWorld(worldId)).revision, 1);
      assert.deepEqual((await engine.getTraces(worldId)).map((trace) => trace.outcome), ["cancelled"]);

      const { provider: idle, runner: idleRunner } = scripted([]);
      assert.equal((await idleRunner.run(worldId, { maxTurns: 1 }, undefined, { signal: AbortSignal.abort() })).stopReason, "paused");
      assert.deepEqual(await idleRunner.step(worldId, undefined, { signal: AbortSignal.abort() }), []);
      assert.equal(idle.requests.length, 0);

      // A pause during narration keeps the committed turn; the next step narrates it first.
      const pausing = new AbortController();
      const { runner: mover } = scripted([
        act("Ridge.", { type: "move", destinationId: "ridge" }),
        {
          role: "dm",
          respond: () => {
            pausing.abort();
            return { narration: "Unused." };
          },
        },
      ]);
      assert.deepEqual((await mover.step(worldId, undefined, { signal: pausing.signal })).map(label), ["mira", "cancelled:narrator"]);
      const { runner: resumed } = scripted([narrate("Mira climbs."), say("Go on, then.")]);
      assert.deepEqual((await resumed.step(worldId)).map(label), ["narration", "bram"]);
    });

    await t.test("a second scheduler on the same world is refused, and losing the lease cancels the turn", async () => {
      const worldId = await create(sampleWorld("lease"));
      const { runner: rival } = scripted([say("Me first.")]);
      const { runner } = scripted([{
        role: "character",
        respond: async () => {
          await assert.rejects(rival.step(worldId), errorCode("WORLD_BUSY"));
          return { speech: "Mine.", to: null, action: null };
        },
      }]);
      assert.deepEqual((await runner.step(worldId)).map(label), ["mira"]);
      assert.deepEqual((await rival.step(worldId)).map(label), ["bram"], "the lease is released after each step");

      // A turn that outlasts the lease's lifetime keeps it, because it is renewed meanwhile.
      const { runner: slow } = scripted([{
        role: "character",
        respond: async () => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          await assert.rejects(scripted([]).runner.step(worldId), errorCode("WORLD_BUSY"));
          return { speech: "Slow and steady.", to: null, action: null };
        },
      }], sampleCast, { leaseMs: 40 });
      assert.deepEqual((await slow.step(worldId)).map(label), ["elowen"]);

      const { runner: usurped } = scripted([{
        role: "character",
        respond: async () => {
          await admin.query(
            `UPDATE "${schema}".adventure_leases SET holder = 'usurper', expires_at = clock_timestamp() + interval '1 hour'
             WHERE world_id = $1`,
            [worldId],
          );
          return { speech: "Still mine?", to: null, action: null };
        },
      }]);
      const report = await usurped.run(worldId, { maxTurns: 3 });
      assert.equal(report.stopReason, "lease_lost");
      assert.deepEqual(report.outcomes.map(label), ["cancelled:mira"]);
      assert.equal((await engine.getWorld(worldId)).revision, 4);
      await assert.rejects(scripted([]).runner.step(worldId), errorCode("WORLD_BUSY"));
      await admin.query(`DELETE FROM "${schema}".adventure_leases WHERE world_id = $1`, [worldId]);
    });

    await t.test("muted characters are skipped until unmuted, and a cue runs anyone who can act", async () => {
      const worldId = await create(sampleWorld("mutes-runner"));
      await engine.setMuted(worldId, ["bram"], true);
      const { runner } = scripted([say("Bram?", "bram"), say("Quiet up here."), say("Fine, then.")]);
      await runner.run(worldId, { maxTurns: 3 });
      // Muted Bram neither takes a turn nor answers when spoken to.
      assert.deepEqual(await speakers(worldId), ["mira", "elowen", "mira"]);
      const { runner: cued } = scripted([say("Sorry, I was miles away.")]);
      assert.deepEqual((await cued.step(worldId, undefined, { actorId: "bram" })).map(label), ["bram"]);

      await engine.setMuted(worldId, ["mira", "elowen"], true);
      const { provider: idle, runner: idleRunner } = scripted([]);
      assert.equal((await idleRunner.run(worldId, { maxTurns: 3 })).stopReason, "all_muted");
      assert.deepEqual(await idleRunner.step(worldId), []);
      assert.equal(idle.requests.length, 0);
      await assert.rejects(idleRunner.step(worldId, undefined, { actorId: "nobody" }), errorCode("NOT_FOUND"));
      const soloCast: Cast = { narratorStyle: "Plain.", characters: { elowen: sampleCast.characters.elowen! } };
      await assert.rejects(
        scripted([], soloCast).runner.step(worldId, undefined, { actorId: "mira" }),
        /mira cannot take a turn: mira has no persona in the cast/,
      );
      await engine.setMuted(worldId, ["mira", "bram", "elowen"], false);
      const { runner: unmuted } = scripted([say("All of us again.")]);
      assert.deepEqual((await unmuted.step(worldId)).map(label), ["elowen"]);

      // A muted NPC stays silent when spoken to, but can be cued, unaddressed.
      const npcWorld = await create(starterWorld("mutes-npc"));
      await engine.setMuted(npcWorld, ["tamsin"], true);
      await scripted([say("Grandmother?", "tamsin"), say("Asleep, I think.")], starterCast).runner.run(npcWorld, { maxTurns: 2 });
      assert.deepEqual(await speakers(npcWorld), ["mira", "bram"]);
      const { provider: npcProvider, runner: npcCue } = scripted(
        [{ role: "dm", output: { speech: "Who's asking?", to: null, move: null } }], starterCast,
      );
      assert.deepEqual((await npcCue.step(npcWorld, undefined, { actorId: "tamsin" })).map(label), ["tamsin"]);
      assert.match(npcProvider.requests[0]!.prompt, /It is your turn to speak/);
    });

    await t.test("a run stops at its cost budget", async () => {
      const worldId = await create(sampleWorld("cost-budget"));
      const costly = (speech: string): ScriptStep => ({
        role: "character", output: { speech, to: null, action: null }, usage: { inputTokens: 10, outputTokens: 5, cost: 0.03 },
      });
      const { runner } = scripted([costly("One."), costly("Two."), costly("Unused.")]);
      const report = await runner.run(worldId, { maxTurns: 5, maxCost: 0.05 });
      assert.equal(report.stopReason, "max_cost");
      assert.deepEqual([report.turns, report.modelCalls, report.tokens], [2, 2, 30]);
      assert.ok(Math.abs(report.cost - 0.06) < 1e-9);
      assert.deepEqual((await engine.getTraces(worldId)).map((trace) => trace.cost), [0.03, 0.03]);
      await assert.rejects(runner.run(worldId, { maxTurns: 1, maxCost: 0 }), errorCode("INVALID_INPUT"));
    });

    await t.test("an OpenRouter turn commits, and its traces record the routed model and tokens", async () => {
      const worldId = await create(sampleWorld("openrouter"));
      const replies = [
        JSON.stringify({ speech: "Up to the ridge.", to: null, action: { ...none, type: "move", destinationId: "ridge" } }),
        '```json\n{"narration": "Mira climbs to the windy ridge."}\n```',
      ];
      const bodies: { response_format: { json_schema: { name: string } } }[] = [];
      const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/models")) {
          return Response.json({ data: [{ id: "test/model", supported_parameters: ["response_format", "structured_outputs"] }] });
        }
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({
          model: "test/model-0001",
          choices: [{ finish_reason: "stop", message: { content: replies.shift() } }],
          usage: { prompt_tokens: 900, completion_tokens: 40, cost: 0.0021 },
        });
      }) as typeof globalThis.fetch;
      const provider = await OpenRouterProvider.create({
        apiKey: "sk-or-test", models: { character: "test/model", dm: "test/model" },
        efforts: { character: undefined, dm: undefined }, maxOutputTokens: 1024, fetch,
      });
      assert.deepEqual((await new TurnRunner(engine, provider, sampleCast).step(worldId)).map(label), ["mira", "narration"]);
      assert.deepEqual(bodies.map((body) => body.response_format.json_schema.name), ["take_turn", "narrate"]);
      assert.deepEqual((await engine.getTraces(worldId)).map((trace) => (
        [trace.role, trace.task, trace.provider, trace.model, trace.inputTokens, trace.outputTokens, trace.cost, trace.outcome]
      )), [
        ["character", "character_turn", "openrouter", "test/model-0001", 900, 40, 0.0021, "committed"],
        ["dm", "narration", "openrouter", "test/model-0001", 900, 40, 0.0021, "committed"],
      ]);
      const state = await engine.getWorld(worldId);
      assert.equal(state.characters.find((character) => character.id === "mira")?.locationId, "ridge");
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
