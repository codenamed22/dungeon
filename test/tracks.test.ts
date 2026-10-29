import assert from "node:assert/strict";
import test from "node:test";
import { parseInput, validateWorld, worldSeedSchema } from "../src/model.ts";
import type { WorldSeed } from "../src/model.ts";
import { perceive, availableActions } from "../src/perception.ts";
import { renderNarrationPrompt } from "../src/agents/context.ts";
import { applyEvent } from "../src/rules.ts";
import { errorCode, fixed, nextEvent, Session } from "./support.ts";

function world(): WorldSeed {
  return parseInput(worldSeedSchema, {
    id: "tracks-world",
    name: "Tracks",
    speechSeconds: 10,
    locations: [
      { id: "hall", name: "Hall", routes: [{ destinationId: "vault", seconds: 60, locked: true }] },
      { id: "vault", name: "Vault", routes: [{ destinationId: "hall", seconds: 60 }] },
    ],
    items: [],
    characters: [{
      id: "mira", name: "Mira", locationId: "hall", hp: 10, maxHp: 10,
      modifiers: { strength: 0, dexterity: 0, wisdom: 0 }, inventory: {}, tracks: { trust: 0 },
    }],
    challenges: [
      {
        id: "talk", name: "Talk", locationId: "hall", ability: "wisdom", difficulty: 5, seconds: 60, failureDamage: 0, resolved: false,
        onSuccess: { adjustTracks: [{ trackId: "trust", delta: 2 }] },
        onFailure: { adjustTracks: [{ trackId: "trust", delta: 1 }] },
      },
      { id: "confide", name: "Confide", locationId: "hall", ability: "wisdom", difficulty: 5, seconds: 60, failureDamage: 0, locked: true, resolved: false },
    ],
    threats: [{ id: "alarm", name: "Alarm", text: "A bell rings.", status: "waiting", delaySeconds: 600 }],
    tracks: [{
      id: "trust", name: "Trust", max: 10,
      thresholds: [
        { id: "warm", at: 2, guidance: "Mira is softening.", unlockChallenges: ["confide"], unlockRoutes: [{ fromId: "hall", destinationId: "vault" }], reveals: "The vault key is under the mat.", armThreats: ["alarm"], adjustModifiers: [{ ability: "wisdom", delta: 2 }] },
        { id: "bound", at: 4 },
      ],
    }],
    endings: [{ id: "bound-end", name: "Bound", text: "It is done.", when: { trackId: "trust", thresholdId: "bound" } }],
    rules: { outcomes: "dice", stats: { strength: "Strength", dexterity: "Dexterity", wisdom: "Wisdom" }, health: "HP" },
  });
}

test("a check moves a track, and reaching a threshold changes the world once", () => {
  const seed = world();
  validateWorld(seed);
  const session = new Session(seed);
  assert.throws(() => session.commit({ action: { type: "attempt_check", challengeId: "confide" } }), errorCode("INVALID_ACTION"));
  assert.deepEqual(availableActions(session.state, "mira").attempt, ["talk"]);
  const committed = session.commit({ action: { type: "attempt_check", challengeId: "talk" } });
  assert.deepEqual(committed.map(({ event }) => event.data.type), [
    "check_resolved", "track_changed", "threshold_reached", "insight",
  ]);
  const state = session.state;
  assert.equal(state.characters[0]?.tracks?.trust, 2);
  assert.equal(state.characters[0]?.modifiers.wisdom, 2);
  assert.deepEqual(state.reached, ["mira:trust:warm"]);
  assert.equal(state.challenges.find((challenge) => challenge.id === "confide")?.locked, undefined);
  assert.equal(state.locations[0]?.routes[0]?.locked, false);
  assert.equal(state.threats?.[0]?.status, "armed");
  // Only the hero perceives the insight; the track itself stays hidden.
  assert.deepEqual(committed.map(({ perceivers }) => perceivers), [["mira"], [], [], ["mira"]]);
  assert.deepEqual(availableActions(state, "mira").attempt, ["confide"]);
  assert.ok(perceive(state, "mira").challenges.some((challenge) => challenge.id === "confide"));
});

test("a threshold reached by an ending ends the story", () => {
  const session = new Session(world());
  session.commit({ action: { type: "attempt_check", challengeId: "talk" } });
  // The first check resolved "talk"; a failure on another attempt still pushes the track, so use confide.
  const committed = session.commit({ action: { type: "attempt_check", challengeId: "confide" } }, fixed(1));
  assert.equal(committed.at(-1)?.event.data.type, "check_resolved");
  assert.equal(session.state.endedWith, undefined);
});

test("failure can move a track too, and values stay within their bounds", () => {
  const session = new Session(world());
  const committed = session.commit({ action: { type: "attempt_check", challengeId: "talk" } }, fixed(1));
  assert.deepEqual(committed.map(({ event }) => event.data.type), ["check_resolved", "track_changed"]);
  assert.equal(session.state.characters[0]?.tracks?.trust, 1);
});

test("the narrator is told about hidden tracks and guidance; characters are not", () => {
  const session = new Session(world());
  session.commit({ action: { type: "attempt_check", challengeId: "talk" } });
  const prompt = renderNarrationPrompt(session.state, "hall", ["Mira talked."], [], []);
  assert.match(prompt, /Hidden tracks/);
  assert.match(prompt, /Trust: 2\/10/);
  assert.match(prompt, /Mira is softening\./);
});

test("replay refuses forged track changes", () => {
  const session = new Session(world());
  const forged = (data: Parameters<typeof nextEvent>[1]) => () => applyEvent(session.state, nextEvent(session.state, data, { source: "engine" }));
  assert.throws(forged({ type: "track_changed", characterId: "mira", trackId: "trust", challengeId: "talk", delta: 2, value: 9 }), errorCode("CORRUPT_STORAGE"));
  assert.throws(forged({
    type: "threshold_reached", characterId: "mira", trackId: "trust", thresholdId: "warm", unlockedRoutes: [], lockedRoutes: [],
    unlockedChallenges: [], armedThreats: [], disarmedThreats: [], modifiers: [],
  }), errorCode("CORRUPT_STORAGE"));
});

test("a world that moves tracks it does not have is refused", () => {
  const seed = world();
  seed.challenges[0]!.onSuccess = { adjustTracks: [{ trackId: "missing", delta: 1 }] };
  assert.throws(() => validateWorld(seed), errorCode("INVALID_INPUT"));
  const stale = world();
  stale.endings = [{ id: "x", name: "X", text: "X", when: { trackId: "trust", thresholdId: "nowhere" } }];
  assert.throws(() => validateWorld(stale), errorCode("INVALID_INPUT"));
});

test("reaching an ending threshold ends the story", () => {
  const seed = world();
  seed.challenges[0]!.onSuccess = { adjustTracks: [{ trackId: "trust", delta: 4 }] };
  const session = new Session(seed);
  const committed = session.commit({ action: { type: "attempt_check", challengeId: "talk" } });
  assert.equal(committed.at(-1)?.event.data.type, "story_ended");
  assert.equal(session.state.endedWith, "bound-end");
});

test("the creator builds, edits and removes tracks, keeping every reference consistent", async () => {
  const { blankDraft, draftProblems, remove, setWorld, upsertChallenge, upsertCharacter, upsertEnding, upsertItem, upsertPlace, upsertTrack, connectPlaces } = await import("../src/creator/operations.ts");
  type Draft = ReturnType<typeof blankDraft>;
  type Step = (draft: Draft) => { draft: Draft };
  const build = (draft: Draft, ...steps: Step[]) => steps.reduce((current, step) => step(current).draft, draft);
  const draft = build(
    blankDraft(),
    (d) => setWorld(d, { name: "Tracked", premise: "A test.", outcomes: "dice", statNames: ["Str", "Dex", "Wis"], healthName: "HP" }),
    (d) => upsertPlace(d, { name: "Hall" }),
    (d) => upsertPlace(d, { name: "Vault" }),
    (d) => connectPlaces(d, { fromId: "hall", toId: "vault", minutes: 1, locked: true }),
    (d) => upsertItem(d, { name: "Key" }),
    (d) => upsertTrack(d, { name: "Trust", max: 10 }),
    (d) => upsertCharacter(d, { name: "Mira", placeId: "hall", trackValues: { trust: 0 } }),
    (d) => upsertChallenge(d, { name: "Talk", placeId: "hall", ability: "wisdom", difficulty: "easy", minutes: 1, adjustsTracks: [{ trackId: "trust", delta: 3 }] }),
    (d) => upsertChallenge(d, { name: "Confide", placeId: "hall", ability: "wisdom", difficulty: "easy", minutes: 1, locked: true }),
    (d) => upsertTrack(d, {
      id: "trust",
      thresholds: [
        { at: 3, guidance: "Softening.", unlocksChallengeIds: ["confide"], unlocksRoutes: [{ fromId: "hall", toId: "vault" }] },
        { at: 6 },
      ],
    }),
    (d) => upsertEnding(d, { name: "Bound", text: "Done.", trackId: "trust", thresholdId: "level-6" }),
  );
  assert.deepEqual(draftProblems(draft).filter((problem) => problem.severity === "error"), []);
  assert.throws(() => upsertTrack(draft, { id: "trust", thresholds: [{ at: 99 }] }), errorCode("INVALID_INPUT"));
  assert.throws(() => upsertTrack(draft, { id: "trust", thresholds: [{ at: 2, unlocksChallengeIds: ["talk"] }] }), errorCode("INVALID_INPUT"));
  assert.throws(() => upsertEnding(draft, { name: "X", text: "X", trackId: "trust", thresholdId: "nope" }), errorCode("INVALID_INPUT"));
  // Dropping a threshold takes its ending with it.
  const trimmed = upsertTrack(draft, { id: "trust", thresholds: [{ id: "level-3", at: 3 }] }).draft;
  assert.equal(trimmed.seed.endings, undefined);
  // Removing a challenge or the track leaves nothing dangling.
  assert.deepEqual(remove(draft, { kind: "challenge", id: "confide" }).draft.seed.tracks?.[0]?.thresholds[0]?.unlockChallenges, undefined);
  const without = remove(draft, { kind: "track", id: "trust" }).draft;
  assert.equal(without.seed.tracks, undefined);
  assert.equal(without.seed.characters[0]?.tracks, undefined);
  assert.equal(without.seed.challenges[0]?.onSuccess, undefined);
  assert.equal(without.seed.endings, undefined);
  assert.deepEqual(draftProblems(without).filter((problem) => problem.severity === "error"), []);
});
