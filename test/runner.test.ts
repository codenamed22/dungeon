import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { REHEARSAL_ROLL, REHEARSAL_TURNS, rehearsalScript } from "../src/adventures/rehearsal.ts";
import { starterCast, starterWorld } from "../src/adventures/starter.ts";
import { OpenRouterProvider } from "../src/agents/openrouter.ts";
import type { Cast } from "../src/agents/prompts.ts";
import { ProviderError, ScriptedProvider } from "../src/agents/provider.ts";
import type { ScriptStep } from "../src/agents/provider.ts";
import { TurnRunner } from "../src/agents/runner.ts";
import type { RunnerSettings, StepOutcome } from "../src/agents/runner.ts";
import { AdventureEngine } from "../src/engine.ts";
import type { WorldSeed } from "../src/model.ts";
import { sampleWorld } from "../src/sample-world.ts";
import { fixed } from "./support.ts";

const connectionString = process.env.TEST_DATABASE_URL;

const none = { destinationId: null, recipientId: null, itemId: null, quantity: null, challengeId: null, minutes: null };
const say = (speech: string): ScriptStep => ({ role: "character", output: { speech, action: null } });
const act = (speech: string | null, action: Record<string, unknown>): ScriptStep => (
  { role: "character", output: { speech, action: { ...none, ...action } } }
);
const narrate = (narration: string): ScriptStep => ({ role: "dm", output: { narration } });

const sampleCast: Cast = {
  narratorStyle: "Plain.",
  characters: {
    mira: { summary: "A scout.", voice: "Brief.", goals: ["Explore"], riskTolerance: "bold" },
    bram: { summary: "A guard.", voice: "Slow.", goals: ["Protect the others"], riskTolerance: "cautious" },
    elowen: { summary: "A scholar.", voice: "Precise.", goals: ["Learn"], riskTolerance: "balanced" },
  },
};

function label(outcome: StepOutcome): string {
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
    .filter((event) => event.source === "character" && event.data.type === "utterance")
    .map((event) => ("actorId" in event.data ? event.data.actorId : ""));
  try {
    await engine.initialize();

    await t.test("the scripted rehearsal runs end to end, and replay reproduces state and perceivers", async () => {
      const worldId = await create(starterWorld("rehearsal"));
      const { provider, runner } = scripted(rehearsalScript(), starterCast);
      const report = await runner.run(worldId, { maxTurns: REHEARSAL_TURNS });
      assert.equal(report.stopReason, "max_turns");
      assert.equal(report.turns, REHEARSAL_TURNS);
      assert.equal(report.modelCalls, 11);
      assert.equal(provider.remaining, 0);
      assert.deepEqual(report.outcomes.map(label), [
        "mira", "narration", "bram", "narration", "elowen", "mira×2", "bram", "narration", "elowen", "narration",
      ]);
      const state = await engine.getWorld(worldId);
      assert.deepEqual(await engine.replayWorld(worldId), state);
      assert.equal(state.challenges.find((challenge) => challenge.id === "pry-bars")?.resolved, true);
      assert.equal(state.characters.find((character) => character.id === "elowen")?.locationId, "channel");
      // Mira's move from camp was seen at both ends, and so was its narration.
      assert.deepEqual(await engine.getPerceivers(worldId, 3), ["bram", "elowen", "mira"]);
      assert.deepEqual(await engine.getPerceivers(worldId, 4), ["bram", "elowen", "mira"]);
      // The engine's reason for rejecting Mira's proposal went back to her agent.
      const traces = await engine.getTraces(worldId, 50);
      assert.equal(traces.length, 11);
      assert.deepEqual(traces.filter((trace) => trace.outcome !== "committed").map((trace) => [trace.turnId, trace.outcome]), [
        ["t8-mira", "invalid_action"],
      ]);
      assert.match(
        provider.requests[6]!.prompt,
        /The engine rejected your proposal: pry-bars requires crowbar, which mira does not carry/,
      );
      assert.equal(traces.filter((trace) => trace.role === "dm" && trace.actorId === null).length, 4);
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
        { role: "character", output: { speech: null, action: { ...none, type: "wait" } } },
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
            return { speech: "Let's go.", action: null };
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
        const { runner: first } = scripted([say("A's words.")]);
        const { runner: second } = scripted([{
          role: "character",
          respond: async () => {
            await first.step(worldId);
            return { speech: words, action: null };
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

    await t.test("an OpenRouter turn commits, and its traces record the routed model and tokens", async () => {
      const worldId = await create(sampleWorld("openrouter"));
      const replies = [
        JSON.stringify({ speech: "Up to the ridge.", action: { ...none, type: "move", destinationId: "ridge" } }),
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
          usage: { prompt_tokens: 900, completion_tokens: 40 },
        });
      }) as typeof globalThis.fetch;
      const provider = await OpenRouterProvider.create({
        apiKey: "sk-or-test", models: { character: "test/model", dm: "test/model" },
        efforts: { character: undefined, dm: undefined }, maxOutputTokens: 1024, fetch,
      });
      assert.deepEqual((await new TurnRunner(engine, provider, sampleCast).step(worldId)).map(label), ["mira", "narration"]);
      assert.deepEqual(bodies.map((body) => body.response_format.json_schema.name), ["take_turn", "narrate"]);
      assert.deepEqual((await engine.getTraces(worldId)).map((trace) => (
        [trace.role, trace.provider, trace.model, trace.inputTokens, trace.outputTokens, trace.outcome]
      )), [
        ["character", "openrouter", "test/model-0001", 900, 40, "committed"],
        ["dm", "openrouter", "test/model-0001", 900, 40, "committed"],
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
