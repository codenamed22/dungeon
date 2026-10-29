import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { starterCast, starterWorld } from "../src/adventures/starter.ts";
import { direct } from "../src/agents/inspect.ts";
import { blankDraft, upsertPlace } from "../src/creator/operations.ts";
import { AdventureEngine } from "../src/engine.ts";
import { exportDesign, exportSave, importWorldFile, readWorldFile, worldFileName } from "../src/exchange.ts";
import type { WorldFile } from "../src/exchange.ts";
import type { AdventureEvent, Command } from "../src/model.ts";
import { DraftService } from "../src/server/drafts.ts";
import { errorCode, fixed } from "./support.ts";

/** What a file holds once written to disk and read back. */
const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** A history as another world would hold it: the same, but under its ID. */
const movedTo = (events: AdventureEvent[], worldId: string) => events.map((event) => ({
  ...event,
  worldId,
  ...(event.data.type === "world_created" ? { data: { ...event.data, seed: { ...event.data.seed, id: worldId } } } : {}),
}));

test("worlds go to files and come back: a design as a draft, a save as a world that plays on", {
  skip: process.env.TEST_DATABASE_URL ? false : "Set TEST_DATABASE_URL to run real PostgreSQL integration tests",
}, async () => {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  const engine = new AdventureEngine(connectionString, { schema, roll: fixed(10) });
  try {
    await engine.initialize();
    await engine.createWorld(starterWorld("source"));
    const turn = async (input: Partial<Command>) => {
      const { revision } = await engine.getWorld("source");
      await engine.execute("source", { role: "character", requestId: randomUUID(), expectedRevision: revision, ...input } as Command);
    };
    await turn({ actorId: "mira", speech: "Lantern first, then the bars." });
    await turn({ actorId: "bram", action: { type: "move", destinationId: "mouth" } });
    await turn({ actorId: "bram", action: { type: "attempt_check", challengeId: "pry-bars" } });
    await direct(engine, "source", { type: "steer", text: "Keep moving." });
    // Mira's first line, reworded; the copy keeps the new words.
    await direct(engine, "source", { type: "retcon", sequence: 2, replacement: "Lantern first, then we try the bars." });
    const models = { character: "test/character", dm: "test/dm", dmEffort: "low" as const };
    const cast = { ...starterCast, narratorStyle: "Clipped and cold." };
    await engine.saveSetup("source", { cast, models });
    await engine.setMuted("source", ["tamsin"], true);
    const source = await engine.getWorld("source");

    // A full save imports as a new world with the same history, perceivers, setup, and mutes.
    const save = roundTrip(await exportSave(engine, "source"));
    assert.equal(worldFileName(save), "source.save.json");
    assert.equal(save.kind === "save" && save.events.length, source.revision);
    const imported = await importWorldFile(engine, save);
    assert.equal(imported.kind, "save");
    const copy = imported.kind === "save" ? imported.world : undefined!;
    assert.equal(copy.id, "source-2", "the file's ID is taken, so the copy gets the next free one");
    assert.deepEqual({ ...copy, id: "source" }, source);
    assert.deepEqual(await engine.exportEvents("source-2"), movedTo(await engine.exportEvents("source"), "source-2"));
    assert.deepEqual(await engine.getPerceiverMap("source-2", 1, source.revision), await engine.getPerceiverMap("source", 1, source.revision));
    assert.deepEqual(await engine.replayWorld("source-2"), copy);
    assert.deepEqual(await engine.getSetup("source-2"), { cast, models });
    assert.deepEqual(await engine.getMuted("source-2"), ["tamsin"]);
    const reworded = (await engine.getPerceivedEvents("source-2", "mira", 50)).find((event) => event.sequence === 2);
    assert.equal(reworded?.data.type === "utterance" ? reworded.data.text : null, "Lantern first, then we try the bars.");
    // It plays on by itself.
    await direct(engine, "source-2", { type: "introduce", text: "Rain starts." });
    assert.equal((await engine.getWorld("source")).revision, source.revision);

    // A chosen ID is used as given, and must be free and well formed.
    assert.equal((await importWorldFile(engine, save, { worldId: "moved" })).kind, "save");
    await assert.rejects(importWorldFile(engine, save, { worldId: "moved" }), errorCode("REQUEST_CONFLICT"));
    await assert.rejects(importWorldFile(engine, save, { worldId: "not an id" }), errorCode("INVALID_INPUT"));

    // A history that doesn't hold together is refused, and nothing is stored.
    const events = save.kind === "save" ? save.events as AdventureEvent[] : [];
    const refused = async (changed: unknown[], message: RegExp) => {
      await assert.rejects(
        importWorldFile(engine, { ...save, events: changed }, { worldId: "tampered" }),
        (error) => errorCode("INVALID_INPUT")(error) && message.test((error as Error).message),
      );
    };
    await refused(events.filter((event) => event.sequence !== 3), /The file's history doesn't replay: Event history is out of sequence/);
    await refused(events.map((event) => (event.data.type === "check_resolved" ? { ...event, data: { ...event.data, roll: 2 } } : event)),
      /doesn't replay: Check outcome contradicts the world rules/);
    await refused([...events, { ...events[1]!, sequence: events.length + 1, requestId: "forged", source: "dm", data: { type: "narration", text: "A door opens.", aboutSequences: [1] } }],
      /doesn't replay: Narration references an event that cannot be narrated/);
    await refused(events.map((event, index) => (index === 1 ? { ...event, data: { type: "utterance" } } : event)), /^Event 2 in the file \(utterance\) isn't valid/);
    await refused(events.map((event, index) => (index === 1 ? { ...event, data: { type: "steering", text: "x".repeat(1001) } } : event)),
      /^Event 2 in the file \(steering\) isn't valid: data\.text is too long \(at most 1000 characters\)$/);
    await assert.rejects(engine.getWorld("tampered"), errorCode("NOT_FOUND"));
    // So is a setup that doesn't fit the world.
    await assert.rejects(
      importWorldFile(engine, { ...save, setup: { cast: { ...cast, characters: { ...cast.characters, ghost: cast.characters.mira } }, models } }, { worldId: "haunted" }),
      errorCode("INVALID_INPUT"),
    );
    await assert.rejects(engine.getWorld("haunted"), errorCode("NOT_FOUND"));

    // A design is the world as written, with the cast and models chosen since.
    const design = roundTrip(await exportDesign(engine, { worldId: "source" }));
    assert.equal(design.kind, "design");
    const written = design.kind === "design" ? design.draft : undefined!;
    assert.deepEqual(written, { seed: starterWorld("source"), cast, models });
    assert.equal(worldFileName(design), "the-dry-aqueduct.design.json");
    const drafted = await importWorldFile(engine, design);
    assert.equal(drafted.kind, "design");
    const draftId = drafted.kind === "design" ? drafted.draft.id : "";
    const drafts = new DraftService(engine);
    const published = await drafts.publish(draftId, "from-design", 1);
    assert.equal(published.worldId, "from-design");
    assert.deepEqual(await engine.getSetup("from-design"), { cast, models });
    assert.equal((await engine.getWorld("from-design")).revision, 1, "a design brings no history");

    // A draft's design leaves its chat behind and comes back as it was.
    const draft = upsertPlace(blankDraft("Half Written"), { name: "Hall" }).draft;
    const record = await engine.createDraft("half", draft);
    await engine.updateDraft("half", record.revision, { chat: [{ id: "c1", message: "Add a hall" }] });
    const fromDraft = roundTrip(await exportDesign(engine, { draftId: "half" }));
    assert.deepEqual(fromDraft, { format: "dungeons-world", version: 1, kind: "design", exportedAt: fromDraft.exportedAt, draft });
    const again = await importWorldFile(engine, fromDraft);
    assert.ok(again.kind === "design" && again.draft.id !== "half");
    assert.deepEqual(again.kind === "design" && [again.draft.draft, again.draft.chat], [draft, []]);
  } finally {
    await engine.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

test("a world file says what it is, and a file from elsewhere or a newer version is refused plainly", () => {
  const design: WorldFile = { format: "dungeons-world", version: 1, kind: "design", exportedAt: "2026-10-29T00:00:00.000Z", draft: blankDraft() };
  assert.deepEqual(readWorldFile(roundTrip(design)), design);
  const refuse = (input: unknown, message: RegExp) => assert.throws(() => readWorldFile(input), (error) => errorCode("INVALID_INPUT")(error) && message.test((error as Error).message));
  refuse({ hello: "world" }, /^This isn't a Dungeons world file\.$/);
  refuse(null, /isn't a Dungeons world file/);
  refuse({ ...design, version: 2 }, /newer version of Dungeons \(file version 2\)/);
  refuse({ ...design, kind: "everything" }, /kind/);
  refuse({ ...design, draft: { ...design.draft, chat: [] } }, /chat/);
  const wordy = { ...design, draft: { ...design.draft, cast: { ...design.draft.cast, narratorStyle: "x".repeat(2001) } } };
  refuse(wordy, /^The file isn't valid: draft\.cast\.narratorStyle is too long \(at most 2000 characters\)$/);
});
