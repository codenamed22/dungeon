import assert from "node:assert/strict";
import test from "node:test";
import { outageWorld } from "../src/adventures/outage.ts";
import { starterWorld } from "../src/adventures/starter.ts";
import { describeEvent } from "../src/agents/context.ts";
import type { AdventureEvent, EventData, WorldSeed, WorldState } from "../src/model.ts";
import { Replayer } from "../src/rules.ts";
import { liveEvents, wipedBy } from "../src/wipes.ts";
import { creationEvent, errorCode, nextEvent, Session } from "./support.ts";

/** A director event made by hand, as the engine would: applied to the session's replay and kept in its log. */
function direct(session: Session, data: EventData, overrides: Partial<AdventureEvent> = {}): AdventureEvent {
  const event = nextEvent(session.state, data, { source: "director", requestId: `d${session.state.revision}`, ...overrides });
  session.replayer.apply(event);
  session.events.push(event);
  return event;
}

/** The wipe from `from`, at the time of the line before it, which is the time the story goes back to. */
function wipeEvent(session: Session, from: number): AdventureEvent {
  const before = session.events.find((event) => event.sequence === from - 1)?.elapsedSeconds ?? 0;
  return nextEvent(session.state, { type: "wiped", fromSequence: from }, {
    source: "director", requestId: `w${session.state.revision}`, elapsedSeconds: before,
  });
}

function wipe(session: Session, from: number): AdventureEvent {
  const event = wipeEvent(session, from);
  session.replayer.apply(event);
  session.events.push(event);
  return event;
}

/** The whole history replayed afresh, which must arrive where the session did. */
function replayed(seed: WorldSeed, events: AdventureEvent[]): WorldState {
  const replayer = new Replayer();
  replayer.apply(creationEvent(seed));
  for (const event of events) replayer.apply(event);
  return replayer.state!;
}

/** The state after the first `count` events, at revision `revision`. */
function stateAfter(seed: WorldSeed, events: AdventureEvent[], count: number, revision: number): WorldState {
  return { ...replayed(seed, events.slice(0, count)), revision };
}

const where = (state: WorldState, id: string) => state.characters.find((character) => character.id === id)!.locationId;
const goalsOf = (state: WorldState, id: string) => state.characters.find((character) => character.id === id)!.goals ?? [];

test("a wipe takes the world back to before a turn, keeping the director's edits of earlier lines", () => {
  const seed = starterWorld("wiped");
  const session = new Session(seed);
  session.commit({ speech: "The bars are rotten through.", addresseeId: "bram" }); // #2
  session.commit({ actorId: "elowen", action: { type: "wait", seconds: 60 } }); // #3
  session.commit({ actorId: "bram", speech: "Follow me.", action: { type: "move", destinationId: "mouth" } }); // #4, #5
  direct(session, { type: "retraction", targetSequence: 2, replacement: "The bars look solid." }); // #6
  session.commit({ action: { type: "wait", seconds: 30 } }); // #7
  assert.equal(where(session.state, "bram"), "mouth");

  const wiped = wipe(session, 3); // #8
  assert.equal(wiped.sequence, 8);
  assert.deepEqual(session.state, stateAfter(seed, session.events, 1, 8), "the world as it was after #2");
  assert.equal(where(session.state, "bram"), "camp");
  assert.deepEqual([...wipedBy(session.events)], [[3, 8], [4, 8], [5, 8], [7, 8]], "the edit of #2 outlives the wipe");
  assert.deepEqual(liveEvents(session.events).map((event) => event.sequence), [2, 6, 8]);
  assert.match(describeEvent(wiped, session.state, null), /\] The director wiped #3–#7; the story went back to before #3\.$/);

  // Play goes on from there, and a fresh replay of everything agrees.
  session.commit({ actorId: "bram", action: { type: "move", destinationId: "mouth" } }); // #9
  assert.equal(where(session.state, "bram"), "mouth");
  assert.deepEqual(replayed(seed, session.events), session.state);
});

test("a wipe starts at a turn's first line, outside any earlier wipe, and nothing refers to a wiped line again", () => {
  const seed = starterWorld("refused");
  const session = new Session(seed);
  session.commit({ speech: "The bars are rotten through." }); // #2
  session.commit({ actorId: "bram", speech: "Follow me.", action: { type: "move", destinationId: "mouth" } }); // #3, #4
  direct(session, { type: "retraction", targetSequence: 2, text: "Mira said nothing about the bars." }); // #5
  session.commit({ actorId: "elowen", action: { type: "wait", seconds: 60 } }); // #6
  const attempt = (from: number, overrides: Partial<AdventureEvent> = {}) => () => session.replayer.apply({ ...wipeEvent(session, from), ...overrides });
  assert.throws(attempt(1), errorCode("CORRUPT_STORAGE"), "the world's creation stays");
  assert.throws(attempt(4), errorCode("CORRUPT_STORAGE"), "Bram's move is the middle of his turn");
  assert.throws(attempt(5), errorCode("CORRUPT_STORAGE"), "a retcon outlives a wipe from it");
  assert.throws(attempt(7), errorCode("CORRUPT_STORAGE"), "no such line yet");
  assert.throws(attempt(3, { elapsedSeconds: 0 }), errorCode("CORRUPT_STORAGE"), "the clock goes back to the time of #2");
  assert.throws(attempt(3, { source: "character" }), errorCode("CORRUPT_STORAGE"));

  wipe(session, 3); // #7
  assert.throws(attempt(3), errorCode("CORRUPT_STORAGE"), "already wiped");
  assert.throws(attempt(5), errorCode("CORRUPT_STORAGE"), "within the wipe, though it outlived it");
  assert.throws(attempt(7), errorCode("CORRUPT_STORAGE"), "a wipe can't be wiped");
  const refer = (data: EventData, source: AdventureEvent["source"] = "director") => () => session.replayer.apply(nextEvent(session.state, data, { source }));
  assert.throws(refer({ type: "retraction", targetSequence: 3 }), errorCode("CORRUPT_STORAGE"), "a wiped line can't be deleted");
  assert.throws(refer({ type: "narration", text: "Bram strides off.", aboutSequences: [4] }, "dm"), errorCode("CORRUPT_STORAGE"));
  assert.throws(() => session.commit({
    speech: "Hm.", note: { about: "bram", attribute: "location", value: "the mouth", evidence: [4], confidence: "low" },
  }), errorCode("INVALID_ACTION"), "a note can't cite a wiped line");
  assert.deepEqual(replayed(seed, session.events), session.state);
});

test("a wipe within a wipe goes with it, and wiping past an ending lets play go on", () => {
  const seed = starterWorld("nested");
  const session = new Session(seed);
  session.commit({ speech: "Ready?" }); // #2
  session.commit({ actorId: "elowen", action: { type: "wait", seconds: 60 } }); // #3
  wipe(session, 3); // #4
  session.commit({ actorId: "bram", action: { type: "move", destinationId: "mouth" } }); // #5
  session.commit({ speech: "Wait for me." }); // #6
  wipe(session, 6); // #7
  assert.equal(where(session.state, "bram"), "mouth");
  wipe(session, 5); // #8: takes the wipe at #7 with it
  assert.deepEqual(session.state, stateAfter(seed, session.events, 1, 8));
  assert.deepEqual([...wipedBy(session.events)], [[3, 4], [6, 7], [5, 8], [7, 8]]);
  assert.deepEqual(replayed(seed, session.events), session.state);

  const deadline = outageWorld("ended");
  deadline.threats = deadline.threats!.map((threat) => (threat.id === "morning-traffic" ? { ...threat, at: 600 } : threat));
  const ended = new Session(deadline);
  ended.commit({ actorId: "priya", action: { type: "wait", seconds: 1800 } }); // #2-#4: the wait, the traffic, the ending
  assert.equal(ended.state.endedWith, "full-outage");
  wipe(ended, 2);
  assert.equal(ended.state.endedWith, undefined);
  assert.equal(ended.state.elapsedSeconds, 0);
  ended.commit({ actorId: "dan", action: { type: "wait", seconds: 60 } });
  assert.deepEqual(replayed(deadline, ended.events), ended.state);
});

test("a note or a goal's latest change can be deleted quietly; a wipe keeps a goal deletion made since", () => {
  const seed = starterWorld("thoughts");
  const session = new Session(seed);
  session.commit({ role: "npc", actorId: "tamsin", speech: "Few come back out of that channel.", addresseeId: "mira" }); // #2
  session.commit({
    speech: "Hm.", note: { about: "channel", attribute: "danger", value: "few come back", evidence: [2], confidence: "low" },
  }); // #3, #4
  session.commit({ speech: "Right.", goal: { status: "adopted", kind: "goal", text: "Reach the cistern by dusk" } }); // #5, #6
  session.commit({ speech: "Done.", goal: { status: "fulfilled", goalId: "goal-6" } }); // #7, #8
  const retract = (targetSequence: number, extra: { text?: string; replacement?: string } = {}) => () => session.replayer.apply(
    nextEvent(session.state, { type: "retraction", targetSequence, ...extra }, { source: "director" }),
  );
  assert.throws(retract(4, { replacement: "many come back" }), errorCode("CORRUPT_STORAGE"), "a note isn't reworded");
  assert.throws(retract(4, { text: "Tamsin said nothing." }), errorCode("CORRUPT_STORAGE"), "a thought goes without a correction");
  assert.throws(retract(6), errorCode("CORRUPT_STORAGE"), "the goal changed later");

  direct(session, { type: "retraction", targetSequence: 4 }); // #9
  assert.throws(retract(4), errorCode("CORRUPT_STORAGE"), "only once");
  direct(session, { type: "retraction", targetSequence: 8 }); // #10: back to pursuing it
  assert.deepEqual(goalsOf(session.state, "mira"), [{ id: "goal-6", kind: "goal", text: "Reach the cistern by dusk", status: "adopted" }]);
  session.commit({ actorId: "elowen", action: { type: "wait", seconds: 60 } }); // #11
  direct(session, { type: "retraction", targetSequence: 6 }); // #12: now the adoption is the latest change
  assert.deepEqual(goalsOf(session.state, "mira"), []);
  session.commit({ actorId: "bram", action: { type: "move", destinationId: "mouth" } }); // #13

  wipe(session, 11); // #14: Bram's move goes; the goal's deletion at #12 stays
  assert.deepEqual(goalsOf(session.state, "mira"), []);
  assert.equal(where(session.state, "bram"), "camp");
  assert.deepEqual(replayed(seed, session.events), session.state);
  wipe(session, 7); // #15: the fulfilment and its deletion go; the deletions of the note and the adoption, earlier lines, stay
  assert.deepEqual(goalsOf(session.state, "mira"), []);
  assert.throws(retract(4), errorCode("CORRUPT_STORAGE"), "the note is still deleted");
  assert.throws(retract(8), errorCode("CORRUPT_STORAGE"), "the fulfilment was wiped");
  assert.deepEqual(replayed(seed, session.events), session.state);
});
