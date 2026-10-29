import assert from "node:assert/strict";
import test from "node:test";
import { starterCast, starterWorld } from "../src/adventures/starter.ts";
import {
  describeEvent, formatClock, renderCharacterPrompt, renderNpcPrompt, renderRulingPrompt,
} from "../src/agents/context.ts";
import {
  characterSystemPrompt, frameOf, judgeSystemPrompt, narratorSystemPrompt, npcSystemPrompt, refereeSystemPrompt,
} from "../src/agents/prompts.ts";
import {
  characterTurnSchema, ProposalError, rulingSchema, toNpcParts, toRuling, toTurnParts,
} from "../src/agents/protocol.ts";
import { ProviderError, ScriptedProvider } from "../src/agents/provider.ts";
import { availableActions, perceive } from "../src/perception.ts";
import { sampleWorld } from "../src/sample-world.ts";
import { commitTurn, fixed, initialState } from "./support.ts";

const none = {
  destinationId: null, recipientId: null, itemId: null, quantity: null, challengeId: null, intent: null, minutes: null,
};

test("model output converts to engine commands with per-action checks", () => {
  assert.deepEqual(toTurnParts({ to: null, speech: "  Hello.  ", action: null }), { speech: "Hello." });
  assert.deepEqual(toTurnParts({ to: null, speech: null, action: { ...none, type: "move", destinationId: "ridge" } }), {
    action: { type: "move", destinationId: "ridge" },
  });
  assert.deepEqual(toTurnParts({ to: null, speech: "", action: { ...none, type: "wait", minutes: 5 } }), {
    action: { type: "wait", seconds: 300 },
  });
  assert.deepEqual(toTurnParts({
    to: null,
    speech: "Take it.",
    action: { ...none, type: "transfer_item", recipientId: "bram", itemId: "rope", quantity: 1 },
  }), {
    speech: "Take it.", action: { type: "transfer_item", recipientId: "bram", itemId: "rope", quantity: 1 },
  });
  // An addressee needs speech to address; an attempt carries its trimmed intent.
  assert.deepEqual(toTurnParts({ to: " bram ", speech: "Here.", action: null }), { speech: "Here.", addresseeId: "bram" });
  assert.deepEqual(toTurnParts({ to: "bram", speech: null, action: { ...none, type: "attempt", intent: " climb the arch " } }), {
    action: { type: "attempt", intent: "climb the arch" },
  });
  for (const [output, message] of [
    [{ to: null, speech: "   ", action: null }, /Say something/],
    [{ to: null, speech: "x".repeat(701), action: null }, /at most 700/],
    [{ to: null, speech: null, action: { ...none, type: "move" } }, /move requires destinationId/],
    [{ to: null, speech: null, action: { ...none, type: "transfer_item", recipientId: "bram", itemId: "rope" } }, /requires quantity/],
    [{ to: null, speech: null, action: { ...none, type: "wait", minutes: 0 } }, /between 1 and 60/],
    [{ to: null, speech: null, action: { ...none, type: "wait", minutes: 61 } }, /between 1 and 60/],
    [{ to: null, speech: null, action: { ...none, type: "attempt" } }, /attempt requires intent/],
    [{ to: null, speech: null, action: { ...none, type: "attempt", intent: "  " } }, /intent must not be empty/],
    [{ to: null, speech: null, action: { ...none, type: "attempt", intent: "x".repeat(201) } }, /at most 200/],
  ] as const) {
    assert.throws(() => toTurnParts(output), (error) => error instanceof ProposalError && message.test(error.message));
  }
});

test("the turn schema is strict about fields", () => {
  assert.ok(characterTurnSchema.safeParse({ to: null, speech: null, action: { ...none, type: "wait", minutes: 1 } }).success);
  for (const output of [
    { speech: null, action: null },
    { to: null, speech: "Hi.", action: null, mood: "happy" },
    { to: null, speech: null, action: { type: "wait", minutes: 1 } },
    { to: null, speech: null, action: { ...none, type: "fly" } },
    { to: null, speech: 5, action: null },
  ]) {
    assert.equal(characterTurnSchema.safeParse(output).success, false);
  }
});

test("characters see 'you' and outcomes; only the admin view shows dice", () => {
  const state = initialState(sampleWorld("describe"));
  const check = commitTurn(state, { action: { type: "attempt_check", challengeId: "gate-trap" } }, fixed(15)).committed[0]!.event;
  assert.equal(describeEvent(check, state, "mira"), "[0:02:00] You attempted \"Disarm the gate trap\" and succeeded.");
  assert.equal(describeEvent(check, state, "bram"), "[0:02:00] Mira attempted \"Disarm the gate trap\" and succeeded.");
  assert.match(describeEvent(check, state, null), /\(Rolled 15 \+3 against 13\.\)$/);
  assert.equal(formatClock(3725), "1:02:05");
});

test("a character prompt lists IDs and legal actions, and carries feedback", () => {
  const state = initialState(starterWorld("prompt"));
  const prompt = renderCharacterPrompt(
    perceive(state, "elowen"), availableActions(state, "elowen"), [], ["pry-bars requires crowbar"],
  );
  assert.match(prompt, /Aqueduct Mouth \(mouth\)/);
  assert.match(prompt, /Dry Channel \(channel\): 2 minutes away, blocked/);
  assert.match(prompt, /- move: destinationId one of camp\n/);
  assert.match(prompt, /needs Crowbar \(you do not carry it\)/);
  assert.match(prompt, /## Your previous proposal was rejected\n- pry-bars requires crowbar/);
  assert.doesNotMatch(prompt, /attempt_check/);
  const system = characterSystemPrompt("Elowen", starterCast.characters.elowen!);
  assert.match(system, /You are Elowen/);
  assert.match(system, /How you take risks: with judgment/);
  assert.doesNotMatch(system, /short sentences|balanced/);
});

test("every agent knows who's who, and a turn ends with the story, not the format", () => {
  const state = initialState(starterWorld("who"));
  const frame = frameOf(starterCast, state);
  assert.deepEqual(frame.people.map((person) => person.name), ["Mira", "Bram", "Elowen", "Old Tamsin"]);
  const system = characterSystemPrompt("Mira", starterCast.characters.mira!, frame);
  assert.match(system, /Who you are to the others: the party's scout/);
  assert.match(system, /Who's who, as everyone in the story knows:\n- Bram: a former quarry worker/);
  assert.match(system, /- Old Tamsin: a goatherd/);
  assert.doesNotMatch(system, /- Mira:/, "nobody is listed to themselves");
  assert.match(system, /Don't announce your own action/);
  assert.match(npcSystemPrompt("Old Tamsin", starterCast.npcs!.tamsin!, frame), /- Mira: the party's scout/);
  for (const prompt of [narratorSystemPrompt("Plain.", frame), refereeSystemPrompt(frame), judgeSystemPrompt(frame)]) {
    assert.match(prompt, /- Elowen: a scholar of old waterworks/);
  }
  // A cast without known-as lines lists nobody.
  const plain = { ...starterCast, characters: { mira: { ...starterCast.characters.mira!, knownAs: undefined } }, npcs: {} };
  assert.deepEqual(frameOf(plain, state).people, []);
  assert.doesNotMatch(characterSystemPrompt("Mira", plain.characters.mira, frameOf(plain, state)), /Who's who|to the others:/);

  const recent = ["#2 [0:00:10] Bram said to you: \"Shall we?\""];
  const prompt = renderCharacterPrompt(perceive(state, "mira"), availableActions(state, "mira"), recent, []);
  const order = ["## Available actions", "## Remembering, alongside your turn", "## What you perceived recently", "## Your turn"].map((heading) => prompt.indexOf(heading));
  assert.ok(order.every((index, position) => index > (order[position - 1] ?? -1)), `sections in order: ${order.join(", ")}`);
  assert.match(prompt, /## Your turn\nRespond to what just happened, as yourself/);
  const alone = renderCharacterPrompt(perceive(state, "elowen"), availableActions(state, "elowen"), [], []);
  assert.match(alone, /## Your turn\nNobody else is here, so act rather than speak\./);
});

test("prompts never contain hidden facts (canary)", () => {
  const seed = starterWorld("canary");
  seed.items.push({ id: "canary-item", name: "CANARY-INVENTORY-5d1e" });
  seed.characters.find((character) => character.id === "bram")!.inventory["canary-item"] = 1;
  seed.challenges.find((challenge) => challenge.id === "clear-rubble")!.description = "CANARY-ELSEWHERE-90b2";
  seed.challenges.find((challenge) => challenge.id === "pry-bars")!.difficulty = 37;
  const state = initialState(seed);
  for (const viewer of ["mira", "elowen"]) {
    const prompt = renderCharacterPrompt(perceive(state, viewer), availableActions(state, viewer), [], []);
    for (const canary of ["CANARY-INVENTORY-5d1e", "canary-item", "CANARY-ELSEWHERE-90b2", "37"]) {
      assert.ok(!prompt.includes(canary), `${viewer}'s prompt must not contain ${canary}`);
    }
  }
  const bram = renderCharacterPrompt(perceive(state, "bram"), availableActions(state, "bram"), [], []);
  assert.ok(bram.includes("CANARY-INVENTORY-5d1e"), "positive control: Bram sees his own inventory");
});

test("every agent's system prompt carries the world's premise, which gives nothing away", () => {
  const premise = "CANARY-PREMISE-7f3a: a drowned kingdom.";
  const withPremise = [
    characterSystemPrompt("Mira", starterCast.characters.mira!, { premise }),
    npcSystemPrompt("Old Tamsin", starterCast.npcs!.tamsin!, { premise }),
    refereeSystemPrompt({ premise }),
    refereeSystemPrompt({ premise, rules: { outcomes: "judgment", stats: null, health: null } }),
    judgeSystemPrompt({ premise }),
    narratorSystemPrompt(starterCast.narratorStyle, { premise }),
  ];
  for (const system of withPremise) assert.match(system, /\n\nThe world: CANARY-PREMISE-7f3a: a drowned kingdom\.\n\n/);
  const without = [
    characterSystemPrompt("Mira", starterCast.characters.mira!),
    npcSystemPrompt("Old Tamsin", starterCast.npcs!.tamsin!),
    refereeSystemPrompt(),
    narratorSystemPrompt(starterCast.narratorStyle),
  ];
  for (const system of without) assert.doesNotMatch(system, /The world:/);
  // The party reads the premise, so it must not spoil the discovery or the threats.
  for (const secret of ["hall drain", "north wall", "sluice", "water", "ceiling"]) {
    assert.ok(!starterCast.premise!.toLowerCase().includes(secret), `the premise gives away "${secret}"`);
  }
});

test("the scripted provider fails explicitly when used out of order or too often", async () => {
  const request = { role: "character" as const, system: "", prompt: "", schema: characterTurnSchema, schemaName: "t" };
  const provider = new ScriptedProvider([
    { role: "dm", output: { narration: "x" } },
    { role: "character", error: new ProviderError("refused", "No.") },
  ]);
  await assert.rejects(provider.generate(request), (error) => error instanceof ProviderError && error.kind === "script_exhausted");
  await assert.rejects(provider.generate(request), (error) => error instanceof ProviderError && error.kind === "refused");
  await assert.rejects(provider.generate(request), (error) => error instanceof ProviderError && error.kind === "script_exhausted");
  assert.equal(provider.remaining, 0);
});

test("an NPC reply must speak, and may answer someone and walk away", () => {
  assert.deepEqual(toNpcParts({ speech: " Ask the bars. ", to: "mira", move: "mouth" }), {
    speech: "Ask the bars.", addresseeId: "mira", destinationId: "mouth",
  });
  assert.deepEqual(toNpcParts({ speech: "Hm.", to: null, move: null }), { speech: "Hm." });
  assert.throws(() => toNpcParts({ speech: " ", to: "mira", move: "mouth" }), /your turn to speak/);
});

test("a referee's flat ruling converts to the engine's ruling, in seconds", () => {
  const unused = { challengeId: null, name: null, ability: null, difficulty: null, failureDamage: null, minutes: null };
  assert.deepEqual(toRuling({ ...unused, decision: "existing", challengeId: "pry-bars", reason: "That is the bars." }), {
    kind: "ruling", ruling: { decision: "existing", challengeId: "pry-bars", reason: "That is the bars." },
  });
  assert.deepEqual(toRuling({
    ...unused, decision: "new", name: " Climb the arch ", ability: "dexterity", difficulty: "hard",
    failureDamage: 2, minutes: 3, reason: "Loose brick.",
  }), {
    kind: "ruling",
    ruling: {
      decision: "new", name: "Climb the arch", ability: "dexterity", difficulty: "hard",
      failureDamage: 2, seconds: 180, reason: "Loose brick.",
    },
  });
  assert.deepEqual(toRuling({ ...unused, decision: "automatic", minutes: 1, reason: "Easy." }), {
    kind: "ruling", ruling: { decision: "automatic", seconds: 60, reason: "Easy." },
  });
  assert.deepEqual(toRuling({ ...unused, decision: "impossible", reason: " Stone does not fly. " }), {
    kind: "impossible", reason: "Stone does not fly.",
  });
  for (const [output, message] of [
    [{ ...unused, decision: "existing", reason: "x" }, /existing requires challengeId/],
    [{ ...unused, decision: "new", name: "Climb", ability: "dexterity", difficulty: "hard", minutes: 1, reason: "x" }, /requires failureDamage/],
    [{ ...unused, decision: "new", name: "Climb", ability: "dexterity", difficulty: "hard", failureDamage: -1, minutes: 1, reason: "x" }, /negative/],
    [{ ...unused, decision: "automatic", minutes: 61, reason: "x" }, /between 1 and 60/],
    [{ ...unused, decision: "automatic", minutes: 1, reason: "  " }, /reason must not be empty/],
  ] as const) {
    assert.throws(() => toRuling(output), (error) => error instanceof ProposalError && message.test(error.message));
  }
  assert.equal(rulingSchema.safeParse({ ...unused, decision: "maybe", reason: "x" }).success, false);
  assert.equal(rulingSchema.safeParse({ ...unused, decision: "new", difficulty: "brutal", reason: "x" }).success, false);
});

test("NPC and referee prompts carry their rules", () => {
  const state = initialState(starterWorld("npc-prompts"));
  const npc = renderNpcPrompt(perceive(state, "tamsin"), ["[0:00:00] Mira said to you: \"Hello?\""], []);
  assert.match(npc, /Ridge Camp \(camp\)/);
  assert.match(npc, /Mira said to you/);
  assert.match(npc, /Set "to" to the ID of the one person you answer: mira, bram; or null\./);
  assert.match(npc, /set "move" to one of mouth/);
  assert.doesNotMatch(npc, /Elowen/, "Tamsin cannot see who is at the mouth");
  const cued = renderNpcPrompt(perceive(state, "tamsin"), [], [], "cued");
  assert.match(cued, /It is your turn to speak/);
  assert.match(cued, /the one person you speak to: mira, bram/);
  const agenda = renderNpcPrompt(perceive(state, "tamsin"), [], [], "agenda", undefined, ["CANARY-STEER: mention the goats"]);
  assert.match(agenda, /Nobody has spoken to you, but you have aims of your own/);
  assert.match(agenda, /## A request from the director, outside the story\n- CANARY-STEER: mention the goats/);
  const system = npcSystemPrompt("Old Tamsin", starterCast.npcs!.tamsin!);
  assert.match(system, /You are voicing Old Tamsin/);
  assert.match(system, /not one of the main characters/);
  assert.match(system, /forty years/);
  assert.match(system, /What you work toward, and bring up unprompted: Warn anyone heading for the channel about the sluice/);

  const ruling = renderRulingPrompt(state, "elowen", "read the old carvings", [], ["No such challenge here"]);
  assert.match(ruling, /Elowen \(elowen\) attempts: "read the old carvings"/);
  assert.match(ruling, /Pry open the bars \(pry-bars\): strength against 13; failure deals 2 damage; needs Crowbar; open/);
  assert.match(ruling, /Difficulty: easy, moderate, hard\./);
  assert.match(ruling, /Minutes: 1 to 10\./);
  assert.match(ruling, /## Your previous ruling was rejected\n- No such challenge here/);
  // Challenges elsewhere are named only so the referee can point the way: never their rules.
  assert.match(ruling, /## Challenges elsewhere \(only to point the way\)\n- Shift the rubble fall, at Dry Channel: Loose blocks/);
  assert.doesNotMatch(ruling, /Shift the rubble fall \(/, "no ID, ability, or difficulty for a challenge elsewhere");
  assert.match(ruling, /## Away from the scene\nNobody\./);
  assert.match(refereeSystemPrompt(), /never decide whether the attempt succeeds/);
  assert.match(characterSystemPrompt("Mira", starterCast.characters.mira!), /set "to" to their ID/);
});

test("a cancelled request never reaches the scripted provider's script", async () => {
  const provider = new ScriptedProvider([{ role: "dm", output: { narration: "x" } }]);
  const signal = AbortSignal.abort();
  await assert.rejects(
    provider.generate({ role: "dm", system: "", prompt: "", schema: characterTurnSchema, schemaName: "t", signal }),
    (error) => error instanceof ProviderError && error.kind === "cancelled",
  );
  assert.equal(provider.remaining, 1);
  assert.equal(provider.requests.length, 0);
});
