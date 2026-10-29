import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { nightMarketWorld } from "../src/adventures/night-market.ts";
import { REHEARSAL_ROLL } from "../src/adventures/rehearsal.ts";
import { ProviderError, ScriptedProvider } from "../src/agents/provider.ts";
import type { ModelProvider, ScriptStep } from "../src/agents/provider.ts";
import { AdventureEngine } from "../src/engine.ts";
import { sampleWorld } from "../src/sample-world.ts";
import { createApp } from "../src/server/app.ts";
import { RunManager } from "../src/server/runs.ts";
import type { RunStatus } from "../src/server/runs.ts";
import { fixed } from "./support.ts";

const connectionString = process.env.TEST_DATABASE_URL;

const say = (speech: string): ScriptStep => ({ role: "character", output: { speech, to: null, action: null } });

interface Reply {
  status: number;
  // The tests read whatever shape each route returns.
  body: any;
}

test("web director integration", {
  skip: connectionString ? false : "Set TEST_DATABASE_URL to run real PostgreSQL integration tests",
}, async (t) => {
  assert.ok(connectionString);
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  const engine = new AdventureEngine(connectionString, { schema, roll: fixed(10) });
  const staticDir = await mkdtemp(path.join(tmpdir(), "dungeons-web-"));
  let provider: ModelProvider = new ScriptedProvider([]);
  const runs = new RunManager({
    engine,
    providerFor: async () => provider,
    rehearsalEngine: () => new AdventureEngine(connectionString, { schema, roll: () => REHEARSAL_ROLL }),
    settings: { narrate: false },
  });
  const server = createServer(createApp({
    engine, runs, env: { OPENROUTER_API_KEY: "test-key" }, allowedHosts: ["localhost", "127.0.0.1"], staticDir, pollMs: 50,
  }));
  try {
    await engine.initialize();
    await writeFile(path.join(staticDir, "index.html"), "<!doctype html><title>UI</title>");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const base = `http://localhost:${port}`;

    const call = async (method: string, route: string, body?: unknown): Promise<Reply> => {
      const response = await fetch(`${base}${route}`, {
        method,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, body: response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
    };
    /** A raw request, for headers fetch will not let a caller set. */
    const raw = (method: string, route: string, headers: Record<string, string>, body = "") => new Promise<Reply>((resolve, reject) => {
      const outgoing = httpRequest({ host: "127.0.0.1", port, method, path: route, headers }, (response) => {
        let text = "";
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }));
      });
      outgoing.on("error", reject);
      outgoing.end(body);
    });
    const settled = async (worldId: string): Promise<RunStatus> => {
      for (let tries = 0; tries < 200; tries += 1) {
        const run = (await call("GET", `/api/worlds/${worldId}`)).body.run as RunStatus | null;
        if (run && (run.state === "finished" || run.state === "failed")) return run;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`The run on ${worldId} did not finish`);
    };
    const create = async (id: string, extra: Record<string, unknown> = { adventureId: "aqueduct" }) => {
      const reply = await call("POST", "/api/worlds", { id, ...extra });
      assert.equal(reply.status, 201, JSON.stringify(reply.body));
      return reply.body;
    };

    await t.test("answers only on its own host names, and takes writes only as same-site JSON", async () => {
      await create("guarded");
      assert.equal((await raw("GET", "/api/worlds", { Host: `rebound.example:${port}` })).status, 403);
      assert.equal((await raw("GET", "/api/worlds", { Host: `127.0.0.1:${port}` })).status, 200);
      const json = { Host: `localhost:${port}`, "Content-Type": "application/json" };
      assert.equal((await raw("POST", "/api/worlds/guarded/pause", { ...json, Origin: "https://evil.example" }, "{}")).status, 403);
      assert.equal((await raw("POST", "/api/worlds/guarded/pause", { ...json, Origin: `http://localhost:5173` }, "{}")).status, 200);
      assert.equal((await raw("POST", "/api/worlds/guarded/pause", { Host: `localhost:${port}`, "Content-Type": "text/plain" }, "{}")).status, 415);
      assert.equal((await raw("POST", "/api/worlds/guarded/steer", json, "{nope")).status, 400);
      assert.equal((await call("GET", "/api/nowhere")).status, 404);
    });

    await t.test("creates worlds from an adventure or a seed, each with a cast, and refuses duplicates", async () => {
      const created = await create("from-adventure");
      assert.equal(created.world.id, "from-adventure");
      assert.equal(created.setupSaved, true);
      assert.deepEqual(Object.keys(created.setup.cast.characters).sort(), ["bram", "elowen", "mira"]);
      assert.deepEqual(Object.keys(created.setup.cast.npcs), ["tamsin"]);
      assert.equal((await call("POST", "/api/worlds", { id: "from-adventure", adventureId: "aqueduct" })).status, 409);
      assert.equal((await call("POST", "/api/worlds", { id: "nowhere", adventureId: "atlantis" })).status, 404);

      const custom = await create("from-seed", { seed: sampleWorld("ignored"), name: "My Ridge" });
      assert.equal(custom.world.id, "from-seed");
      assert.equal(custom.world.name, "My Ridge");
      assert.equal(custom.setup.cast.characters.mira.summary, "Mira, one of the main characters.");
      assert.equal((await call("POST", "/api/worlds", { id: "broken", seed: { ...sampleWorld(), characters: [] } })).status, 400);

      const listed = await call("GET", "/api/worlds");
      assert.ok(listed.body.worlds.some((world: { id: string }) => world.id === "from-seed"));
      assert.equal(listed.body.keyConfigured, true);
      assert.equal((await call("GET", "/api/adventures")).body[0].id, "aqueduct");
    });

    await t.test("saves the director's setup, checked against the world, and agents are sent it", async () => {
      const { setup } = await create("cast");
      const bad = (characters: Record<string, unknown>) => call("PUT", "/api/worlds/cast/setup", { ...setup, cast: { ...setup.cast, characters } });
      assert.equal((await bad({ ...setup.cast.characters, ghost: setup.cast.characters.mira })).status, 400);
      assert.equal((await bad({ ...setup.cast.characters, tamsin: setup.cast.characters.mira })).status, 400);
      const mira = { ...setup.cast.characters.mira, summary: "CANARY-PERSONA-31, a scout." };
      const saved = await call("PUT", "/api/worlds/cast/setup", {
        cast: { ...setup.cast, characters: { ...setup.cast.characters, mira } },
        models: { character: "vendor/character-model", dmEffort: "low" },
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(saved.body.models.character, "vendor/character-model");
      assert.deepEqual(saved.body.setup.models, { character: "vendor/character-model", dmEffort: "low" });
      const prompts = await call("GET", "/api/worlds/cast/agents/mira");
      assert.match(prompts.body.system, /CANARY-PERSONA-31/);
      assert.match(prompts.body.prompt, /## Available actions/);
      assert.equal((await call("GET", "/api/worlds/cast/agents/tamsin")).body.npc, true);
      assert.equal((await call("GET", "/api/worlds/cast/agents/nobody")).status, 404);

      // The premise reaches every agent: party, NPC, narrator, and referee.
      const premise = "CANARY-PREMISE-55: a city under the sea.";
      assert.equal((await call("PUT", "/api/worlds/cast/setup", { ...saved.body.setup, cast: { ...saved.body.setup.cast, premise } })).status, 200);
      for (const id of ["mira", "tamsin"]) assert.match((await call("GET", `/api/worlds/cast/agents/${id}`)).body.system, /The world: CANARY-PREMISE-55/);
      const roles = (await call("GET", "/api/worlds/cast/prompts")).body;
      assert.match(roles.narrator, /The world: CANARY-PREMISE-55/);
      assert.match(roles.referee, /The world: CANARY-PREMISE-55/);
    });

    await t.test("steering and introduced events commit, stream live, and reach only who should know", async () => {
      await create("directed");
      const response = await fetch(`${base}/api/worlds/directed/stream`);
      const reader = response.body!.getReader();
      let streamed = "";
      const until = async (text: string) => {
        while (!streamed.includes(text)) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`The stream ended before "${text}"`);
          streamed += new TextDecoder().decode(value);
        }
      };
      try {
        await until("event: run");
        const wind = await call("POST", "/api/worlds/directed/introduce", {
          text: "A CANARY-WIND-77 gust comes up the channel.", locationIds: ["mouth"],
        });
        assert.equal(wind.status, 201);
        assert.equal((await call("POST", "/api/worlds/directed/steer", { text: "Look for another way.", targetId: "bram" })).status, 201);
        assert.equal((await call("POST", "/api/worlds/directed/steer", { text: "Hm.", targetId: "ghost" })).status, 422);
        assert.equal((await call("POST", "/api/worlds/directed/introduce", { text: "Rain.", locationIds: ["sewer"] })).status, 422);
        await until("Look for another way.");
        assert.match(streamed, /\nid: \d+\nevent: events\ndata: \[\{"sequence":2,/);
        assert.match(streamed, /"line":"\[0:00:00\] Introduced by the director: A CANARY-WIND-77 gust comes up the channel\."/);
      } finally {
        await reader.cancel();
      }
      const events = (await call("GET", "/api/worlds/directed/events")).body;
      assert.deepEqual(events.map((event: { type: string; perceivers: string[] }) => [event.type, event.perceivers]), [
        ["world_created", []], ["introduced", ["elowen"]], ["steering", []],
      ]);
      assert.equal((await call("GET", "/api/worlds/directed/memory/elowen?search=gust")).body.matches.length, 1);
      assert.deepEqual((await call("GET", "/api/worlds/directed/memory/mira?search=gust")).body.matches, []);
      assert.deepEqual((await call("GET", "/api/worlds/directed/memory/bram?search=another%20way")).body.matches, []);
      assert.match((await call("GET", "/api/worlds/directed/agents/bram")).body.prompt, /- Look for another way\./);
      assert.equal((await call("GET", "/api/worlds/directed/report")).body.steeringRequests, 1);
    });

    await t.test("the director brings characters in and sends them away, seen only where it happens", async () => {
      await create("staged");
      const away = await call("POST", "/api/worlds/staged/exit", { characterId: "bram", text: "Bram goes back for the mule." });
      assert.equal(away.status, 201);
      assert.equal((await call("POST", "/api/worlds/staged/exit", { characterId: "bram" })).status, 422);
      assert.equal((await call("POST", "/api/worlds/staged/enter", { characterId: "bram", locationId: "sewer" })).status, 422);
      assert.equal((await call("POST", "/api/worlds/staged/enter", { characterId: "ghost", locationId: "mouth" })).status, 422);
      assert.equal((await call("POST", "/api/worlds/staged/enter", { characterId: "bram" })).status, 400);
      assert.equal((await call("POST", "/api/worlds/staged/enter", { characterId: "bram", locationId: "mouth" })).status, 201);
      const events = (await call("GET", "/api/worlds/staged/events")).body as { type: string; perceivers: string[]; line: string }[];
      assert.deepEqual(events.slice(1).map((event) => [event.type, event.perceivers]), [
        ["character_exited", ["bram", "mira", "tamsin"]], ["character_entered", ["bram", "elowen"]],
      ]);
      assert.match(events[1]!.line, /Sent away by the director: Bram goes back for the mule\. Bram has left the scene\./);
      const world = (await call("GET", "/api/worlds/staged")).body.world as { characters: { id: string; locationId: string; away?: true }[] };
      const bram = world.characters.find((character) => character.id === "bram");
      assert.equal(bram?.locationId, "mouth");
      assert.equal(bram?.away, undefined);
    });

    await t.test("a retcon withdraws words from the agents who heard them, with a correction, and leaves the log intact", async () => {
      await create("retconned");
      assert.equal((await call("POST", "/api/worlds/retconned/rehearse", {})).status, 202);
      await settled("retconned");
      const events = (await call("GET", "/api/worlds/retconned/events")).body as {
        sequence: number; type: string; perceivers: string[]; data: { text?: string };
      }[];
      // Tamsin's warning to Mira at camp: "Few come back out of that channel".
      const warning = events.find((event) => event.type === "utterance" && event.data.text?.includes("Few come back"))!;
      assert.match((await call("GET", "/api/worlds/retconned/agents/mira")).body.prompt, /Few come back out/);
      const retcon = await call("POST", "/api/worlds/retconned/retcon", {
        sequence: warning.sequence, text: "Tamsin never warned anyone off the channel.",
      });
      assert.equal(retcon.status, 201, JSON.stringify(retcon.body));
      const [correction] = (await call("GET", `/api/worlds/retconned/events?after=${retcon.body.sequence - 1}`)).body;
      assert.equal(correction.type, "retraction");
      assert.deepEqual(correction.perceivers, warning.perceivers);
      assert.match(correction.line, new RegExp(`Retcon of #${warning.sequence} by the director: Tamsin never warned`));
      const prompt = (await call("GET", "/api/worlds/retconned/agents/mira")).body.prompt as string;
      assert.doesNotMatch(prompt, /Few come back out/);
      assert.match(prompt, /Correction: something you were told earlier did not happen, and is withdrawn\. Tamsin never warned/);
      assert.deepEqual((await call("GET", "/api/worlds/retconned/memory/mira?search=channel%20come%20back")).body.matches, []);
      // The admin log keeps the original; replay agrees.
      assert.ok((await call("GET", "/api/worlds/retconned/events")).body.some((event: { sequence: number }) => event.sequence === warning.sequence));
      assert.deepEqual(await engine.replayWorld("retconned"), (await call("GET", "/api/worlds/retconned")).body.world);
      const refused = async (sequence: number) => (await call("POST", "/api/worlds/retconned/retcon", { sequence, text: "No." })).status;
      assert.equal(await refused(warning.sequence), 422, "already retconned");
      assert.equal(await refused(events.find((event) => event.type === "check_resolved")!.sequence), 422, "a check changed the world");
      assert.equal(await refused(1), 422);
      assert.equal(await refused(9999), 422);
    });

    await t.test("a line can be reworded or deleted: agents see the new words or nothing, and nobody gets a correction", async () => {
      await create("edited");
      assert.equal((await call("POST", "/api/worlds/edited/rehearse", {})).status, 202);
      await settled("edited");
      type Line = { sequence: number; type: string; perceivers: string[]; data: { text?: string }; line: string };
      const events = (await call("GET", "/api/worlds/edited/events")).body as Line[];
      const warning = events.find((event) => event.type === "utterance" && event.data.text?.includes("Few come back"))!;
      const latest = events.findLast((event) => event.type === "utterance" && event.perceivers.includes("mira") && event.sequence !== warning.sequence)!;
      const prompt = async () => (await call("GET", "/api/worlds/edited/agents/mira")).body.prompt as string;
      assert.ok((await prompt()).includes(latest.data.text!));
      const retcon = async (body: Record<string, unknown>) => {
        const reply = await call("POST", "/api/worlds/edited/retcon", body);
        if (reply.status !== 201) return reply.status;
        return ((await call("GET", `/api/worlds/edited/events?after=${reply.body.sequence - 1}`)).body as Line[])[0]!;
      };

      const first = await retcon({ sequence: warning.sequence, replacement: "The channel floods at dusk, so keep to the ledge." });
      assert.ok(typeof first === "object");
      assert.deepEqual(first.perceivers, [], "nobody perceives an edit");
      assert.match(first.line, new RegExp(`The director reworded #${warning.sequence}: The channel floods at dusk`));
      const edited = await retcon({ sequence: warning.sequence, replacement: "The channel floods at dawn, so keep to the ledge." });
      assert.ok(typeof edited === "object", "a line can be reworded again");
      let seen = await prompt();
      assert.doesNotMatch(seen, /Few come back out|floods at dusk/);
      assert.match(seen, /The channel floods at dawn, so keep to the ledge\./);
      const memory = async (search: string) => (await call("GET", `/api/worlds/edited/memory/mira?search=${encodeURIComponent(search)}`)).body.matches as
        { sequence: number; line: string; snippet: string | null }[];
      const found = (await memory("floods dawn ledge")).find((match) => match.sequence === warning.sequence);
      assert.match(found?.line ?? "", /floods at dawn/);
      assert.match(found?.snippet ?? "", /«floods»/);
      assert.equal((await memory("few come back")).some((match) => match.sequence === warning.sequence), false, "the old words are gone from memory");

      const deleted = await retcon({ sequence: latest.sequence });
      assert.ok(typeof deleted === "object");
      assert.deepEqual(deleted.perceivers, [], "nobody perceives a plain delete");
      assert.match(deleted.line, new RegExp(`The director deleted #${latest.sequence}\\.`));
      seen = await prompt();
      assert.ok(!seen.includes(latest.data.text!));
      assert.doesNotMatch(seen, /Correction/);

      assert.equal(await retcon({ sequence: latest.sequence, replacement: "Something else." }), 422, "nothing changes a deleted line");
      assert.equal(await retcon({ sequence: warning.sequence, replacement: "x".repeat(701) }), 422, "speech keeps its limit");
      assert.equal(await retcon({ sequence: warning.sequence, replacement: "" }), 400);
      assert.equal(await retcon({ sequence: warning.sequence, text: "No.", replacement: "Yes." }), 400);
      assert.deepEqual(await engine.replayWorld("edited"), (await call("GET", "/api/worlds/edited")).body.world);
    });

    await t.test("steps and runs play in the background, one at a time, and pause before anything uncommitted lands", async () => {
      await create("played");
      provider = new ScriptedProvider([say("Hm.")]);
      const step = await call("POST", "/api/worlds/played/step", {});
      assert.equal(step.status, 202);
      const stepped = await settled("played");
      assert.deepEqual([stepped.kind, stepped.stopReason, stepped.turns, stepped.error], ["step", "stepped", 1, null]);
      assert.equal((await call("GET", "/api/worlds/played")).body.world.revision, 2);

      let started!: () => void;
      const waiting = new Promise<void>((resolve) => { started = resolve; });
      provider = new ScriptedProvider([{
        role: "character",
        respond: (request) => new Promise((_, reject) => {
          started();
          request.signal?.addEventListener("abort", () => reject(new ProviderError("cancelled", "The call was cancelled")), { once: true });
        }),
      }]);
      assert.equal((await call("POST", "/api/worlds/played/run", { turns: 3, maxModelCalls: 9 })).status, 202);
      await waiting;
      const busy = await call("POST", "/api/worlds/played/step", {});
      assert.deepEqual([busy.status, busy.body.code], [409, "WORLD_BUSY"]);
      assert.equal((await call("POST", "/api/worlds/played/pause", {})).body.state, "pausing");
      const paused = await settled("played");
      assert.deepEqual([paused.kind, paused.stopReason, paused.error], ["run", "paused", null]);
      assert.equal((await call("GET", "/api/worlds/played")).body.world.revision, 2, "the cancelled turn committed nothing");
      assert.equal((await call("POST", "/api/worlds/played/run", { turns: 0 })).status, 400);
      assert.equal((await call("POST", "/api/worlds/played/run", { turns: 101 })).status, 400);
    });

    await t.test("plays the scripted opening for free, only on a new Dry Aqueduct world", async () => {
      assert.equal((await create("rehearsed")).rehearsable, true);
      assert.equal((await call("POST", "/api/worlds/rehearsed/rehearse", {})).status, 202);
      const run = await settled("rehearsed");
      assert.deepEqual([run.stopReason, run.turns, run.modelCalls, run.error], ["max_turns", 8, 14, null]);
      const state = (await call("GET", "/api/worlds/rehearsed")).body.world;
      assert.equal(state.challenges.find((challenge: { id: string }) => challenge.id === "pry-bars").resolved, true);
      assert.equal(state.characters.find((character: { id: string }) => character.id === "elowen").locationId, "channel");
      assert.deepEqual(await engine.replayWorld("rehearsed"), state);
      assert.equal((await call("GET", "/api/worlds/rehearsed")).body.rehearsable, false, "only before anything has happened");
      const again = await call("POST", "/api/worlds/rehearsed/rehearse", {});
      assert.equal(again.status, 400);
      assert.match(again.body.error, /only plays on a new Dry Aqueduct world/);
      await create("renamed", { adventureId: "aqueduct", name: "Same aqueduct, another name" });
      assert.equal((await call("POST", "/api/worlds/renamed/rehearse", {})).status, 202);
      assert.equal((await settled("renamed")).error, null);
      assert.equal((await create("ridge-world", { adventureId: "ridge" })).rehearsable, false);
      assert.equal((await call("POST", "/api/worlds/ridge-world/rehearse", {})).status, 400);
    });

    await t.test("a step that ends the story says so, and the world stays ended", async () => {
      const market = await create("market", { adventureId: "night-market" });
      assert.deepEqual([market.setup.cast.pace, market.rehearsable], ["conversation", false]);
      const seed = nightMarketWorld("ignored");
      seed.characters = seed.characters.map((character) => (character.npc ? character : { ...character, locationId: "bridge" }));
      await create("finale", { seed });
      provider = new ScriptedProvider([
        { role: "character", output: { speech: null, to: null, action: {
          type: "attempt_check", destinationId: null, recipientId: null, itemId: null, quantity: null, challengeId: "confess",
          approach: "Say it plainly", intent: null, minutes: null,
        } } },
        { role: "dm", output: { success: false, reason: "It comes out as a joke, and Sam laughs it off." } },
      ]);
      assert.equal((await call("POST", "/api/worlds/finale/step", {})).status, 202);
      const stepped = await settled("finale");
      assert.deepEqual([stepped.stopReason, stepped.turns, stepped.error], ["ended", 1, null]);
      assert.equal((await call("GET", "/api/worlds/finale")).body.world.endedWith, "still-friends");
      assert.equal((await call("POST", "/api/worlds/finale/run", { turns: 3 })).status, 202);
      assert.deepEqual([(await settled("finale")).stopReason], ["ended"]);
      const steered = await call("POST", "/api/worlds/finale/steer", { text: "Try again." });
      assert.equal(steered.status, 422);
      assert.match(steered.body.error, /The story has ended/);
    });

    await t.test("branches a world where a turn ends, with its history and setup, and the branch goes its own way", async () => {
      await create("trunk");
      assert.equal((await call("POST", "/api/worlds/trunk/rehearse", {})).status, 202);
      await settled("trunk");
      const events = (await call("GET", "/api/worlds/trunk/events")).body as {
        sequence: number; requestId: string; type: string; line: string; perceivers: string[];
      }[];
      const mid = events.find((event, index) => events[index + 1]?.requestId === event.requestId)!;
      assert.equal((await call("POST", "/api/worlds/trunk/branch", { through: mid.sequence, id: "split" })).status, 400);
      // The end of the turn in which Mira noted the rumor.
      let end = events.find((event) => event.type === "belief_noted")!.sequence;
      while (events[end]?.requestId === events[end - 1]!.requestId) end += 1;
      const branch = await call("POST", "/api/worlds/trunk/branch", { through: end, id: "branch", name: "What if Mira waited" });
      assert.equal(branch.status, 201, JSON.stringify(branch.body));
      assert.deepEqual([branch.body.world.revision, branch.body.world.name, branch.body.setupSaved], [end, "What if Mira waited", true]);
      assert.equal((await call("POST", "/api/worlds/trunk/branch", { through: end, id: "branch" })).status, 409);
      const copied = (await call("GET", "/api/worlds/branch/events")).body as { line: string; perceivers: string[] }[];
      assert.deepEqual(
        copied.slice(1).map((event) => [event.line, event.perceivers]),
        events.slice(1, end).map((event) => [event.line, event.perceivers]),
      );
      assert.deepEqual(await engine.replayWorld("branch"), branch.body.world);
      assert.equal((await call("POST", "/api/worlds/branch/introduce", { text: "Only in the branch." })).status, 201);
      assert.equal((await call("GET", "/api/worlds/trunk")).body.world.revision, events.length);
      assert.equal((await call("GET", "/api/worlds/branch")).body.world.revision, end + 1);
    });

    await t.test("downloads a world or draft as a file, and imports one as a draft or a world", async () => {
      await create("exported");
      const download = async (route: string) => {
        const response = await fetch(`${base}${route}`);
        return { status: response.status, disposition: response.headers.get("content-disposition"), text: await response.text() };
      };
      const save = await download("/api/worlds/exported/export?kind=save");
      assert.deepEqual([save.status, save.disposition], [200, "attachment; filename=\"exported.save.json\""]);
      const design = await download("/api/worlds/exported/export");
      assert.deepEqual([design.status, design.disposition], [200, "attachment; filename=\"the-dry-aqueduct.design.json\""]);
      assert.match(design.text, /^\{\n {2}"format": "dungeons-world"/, "a design is indented for reading");
      assert.equal((await download("/api/worlds/exported/export?kind=everything")).status, 400);
      assert.equal((await download("/api/worlds/nowhere/export?kind=save")).status, 404);

      const world = await call("POST", "/api/import", JSON.parse(save.text));
      assert.equal(world.status, 201, JSON.stringify(world.body));
      assert.deepEqual([world.body.kind, world.body.world.world.id, world.body.world.setupSaved], ["save", "exported-2", true]);
      const chosen = await call("POST", "/api/import?worldId=chosen", JSON.parse(save.text));
      assert.equal(chosen.body.world.world.id, "chosen");
      const drafted = await call("POST", "/api/import", JSON.parse(design.text));
      assert.deepEqual([drafted.status, drafted.body.kind, drafted.body.draft.draft.seed.name], [201, "design", "The Dry Aqueduct"]);
      const again = await download(`/api/drafts/${drafted.body.draft.id}/export`);
      assert.equal(again.disposition, "attachment; filename=\"the-dry-aqueduct.design.json\"");
      assert.deepEqual(JSON.parse(again.text).draft, JSON.parse(design.text).draft);

      const junk = await call("POST", "/api/import", { hello: "world" });
      assert.deepEqual([junk.status, junk.body.error], [400, "This isn't a Dungeons world file."]);
      // An import may be larger than other requests, up to 16 MiB.
      const json = { Host: `localhost:${port}`, "Content-Type": "application/json" };
      assert.equal((await raw("POST", "/api/import", json, JSON.stringify({ format: "dungeons-world", padding: "x".repeat(600_000) }))).status, 400);
      assert.equal((await raw("POST", "/api/worlds/exported/steer", json, JSON.stringify({ text: "x".repeat(600_000) }))).status, 413);
      assert.equal((await raw("POST", "/api/import", json, JSON.stringify({ padding: "x".repeat(17 * 1024 * 1024) }))).status, 413);
    });

    await t.test("serves the web UI, with client-side routes falling back to it", async () => {
      await writeFile(path.join(staticDir, "app.js"), "console.log(1)");
      const page = await fetch(`${base}/worlds/anything`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<title>UI<\/title>/);
      const script = await fetch(`${base}/app.js`);
      assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
      const escape = await fetch(`${base}/..%2f..%2fpackage.json`);
      assert.equal(escape.status, 404);
      assert.doesNotMatch(await escape.text(), /dungeons/);
    });
  } finally {
    await runs.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await engine.close();
    await rm(staticDir, { recursive: true, force: true });
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
