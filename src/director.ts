import { parseArgs } from "node:util";
import { castForWorld } from "./adventures/index.ts";
import { REHEARSAL_ROLL, REHEARSAL_TURNS, rehearsalScript } from "./adventures/rehearsal.ts";
import { starterCast, starterWorld } from "./adventures/starter.ts";
import { describeEvent, formatClock } from "./agents/context.ts";
import { agentPrompts, direct, memoryReport } from "./agents/inspect.ts";
import { computeMetrics } from "./agents/metrics.ts";
import {
  capabilitiesOf, DEFAULT_OPENROUTER_MODEL, fetchOpenRouterModels, OpenRouterProvider, openRouterSettingsFromEnv,
  REASONING_EFFORTS,
} from "./agents/openrouter.ts";
import type { ModelCapabilities, OpenRouterModel } from "./agents/openrouter.ts";
import { ProviderConfigError, ScriptedProvider } from "./agents/provider.ts";
import { TurnRunner } from "./agents/runner.ts";
import type { RunReport, StepOutcome } from "./agents/runner.ts";
import { loadSetup, providerForSetup } from "./agents/setup.ts";
import { openConfiguredEngine } from "./config.ts";
import type { AdventureEngine, EngineOptions } from "./engine.ts";
import type { Belief } from "./memory.ts";
import { EngineError, rulesOf } from "./model.ts";
import type { AdventureEvent, WorldState } from "./model.ts";

const USAGE = `Usage: npm run director -- <command> [options]

Commands:
  init               Create the starter adventure, or resume it if it exists
  step               Run exactly one turn, plus any narration it needs
  cue CHARACTER      Run one turn by that character or NPC, even if muted
  mute [CHARACTER..] Stop the scheduler choosing them (no names: list who is muted)
  unmute CHARACTER.. Let the scheduler choose them again; unmute --all for everyone
  steer TEXT         Ask everyone to reconsider, outside the story; --to CHARACTER for one.
                     Each sees it on their next turn; it changes nothing in the world
  run --turns N      Run up to N turns; limit spending with --max-calls N, --max-tokens N,
                     --max-cost CREDITS
  show               Admin view of the world (never sent to agents)
  transcript         Admin transcript, including dice; --last N (default 40)
  view CHARACTER     Exactly what that character's (or NPC's) agent is sent
  memory CHARACTER   Their goals, beliefs with superseded history, and discoveries;
                     --search TEXT searches only the events they perceived
  traces             Recent model calls; --last N (default 10), --full for prompts and replies
  report             Session metrics: turns, invalid proposals, rulings, cost, latency
  rehearse           Play a scripted opening, with no model and fixed dice, into its own world
  models [TEXT]      List OpenRouter models, or only those whose ID or name contains TEXT

Options:
  --world ID         World to use (default aqueduct-adventure; rehearse uses aqueduct-rehearsal)
  --schema NAME      PostgreSQL schema (default public)
  --model ID         OpenRouter model for step and run (default ${DEFAULT_OPENROUTER_MODEL})

step and run call models through OpenRouter and need OPENROUTER_API_KEY (see README).
Press Ctrl+C once to pause (nothing from an unfinished turn commits), twice to quit.
`;

class UsageError extends Error {}

function parseCommandLine() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        world: { type: "string" },
        schema: { type: "string" },
        model: { type: "string" },
        turns: { type: "string" },
        "max-calls": { type: "string" },
        "max-tokens": { type: "string" },
        "max-cost": { type: "string" },
        last: { type: "string" },
        search: { type: "string" },
        to: { type: "string" },
        full: { type: "boolean" },
        all: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    if (error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")) {
      throw new UsageError(`${error.message}\n\n${USAGE}`);
    }
    throw error;
  }
}

function positiveInteger(value: string | undefined, name: string, fallback?: number): number | undefined {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new UsageError(`--${name} must be a positive integer`);
  }
  return parsed;
}

function positiveNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!/^\d*\.?\d+$/.test(value) || !Number.isFinite(parsed) || parsed <= 0) {
    throw new UsageError(`--${name} must be a positive number`);
  }
  return parsed;
}

/** Dollars per million tokens, from OpenRouter's per-token price. Routers list -1: they bill the model they pick. */
function perMillion(price: string | null | undefined): string {
  const value = price ? Number(price) : Number.NaN;
  if (!Number.isFinite(value)) return "?";
  if (value < 0) return "varies";
  if (value === 0) return "free";
  const dollars = value * 1_000_000;
  return dollars < 0.01 ? "<0.01" : dollars.toFixed(2);
}

function reasoningSummary(capabilities: ModelCapabilities): string {
  if (!capabilities.reasoning) return "no";
  const rank = (effort: string) => (REASONING_EFFORTS as readonly string[]).indexOf(effort);
  const efforts = capabilities.efforts?.toSorted((a, b) => rank(a) - rank(b)).join(", ") ?? "yes";
  return capabilities.defaultEffort ? `${efforts} (default ${capabilities.defaultEffort})` : efforts;
}

async function listModels(terms: string[]): Promise<void> {
  const needles = terms.map((term) => term.toLowerCase());
  const models = (await fetchOpenRouterModels())
    .filter((model) => needles.every((needle) => `${model.id} ${model.name ?? ""}`.toLowerCase().includes(needle)))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (models.length === 0) {
    console.log(`No OpenRouter model matches "${terms.join(" ")}".`);
    return;
  }
  const label = (model: OpenRouterModel) => (model.id === DEFAULT_OPENROUTER_MODEL ? `${model.id} (default)` : model.id);
  const width = Math.max(...models.map((model) => label(model).length));
  const row = (model: string, output: string, input: string, completion: string, context: string, reasoning: string) => (
    `${model.padEnd(width)}  ${output.padEnd(10)}  ${input.padStart(7)}  ${completion.padStart(7)}  ${context.padStart(9)}  ${reasoning}`
  );
  console.log(row("Model", "Output", "In $/M", "Out $/M", "Context", "Reasoning efforts"));
  for (const model of models) {
    const capabilities = capabilitiesOf(model);
    console.log(row(
      label(model),
      capabilities.structuredOutputs ? "structured" : capabilities.jsonMode ? "json" : "text",
      perMillion(model.pricing?.prompt),
      perMillion(model.pricing?.completion),
      model.context_length?.toLocaleString("en-US") ?? "?",
      reasoningSummary(capabilities),
    ));
    if (model.alias_target) console.log(`  alias for ${model.alias_target.slug}`);
  }
  console.log(
    `\n${models.length} model(s). Prices are dollars per million tokens; reasoning tokens are billed as output.`
    + "\nOutput: structured enforces the reply schema, json only asks for JSON, text has no format control."
    + "\nChoose with --model ID or DUNGEONS_MODEL (see .env.example).",
  );
}

function place(state: WorldState, id: string): string {
  return state.locations.find((location) => location.id === id)?.name ?? id;
}

function eventLine(event: AdventureEvent, state: WorldState): string {
  const where = event.data.type === "utterance" ? ` (at ${place(state, event.data.locationId)})` : "";
  return `#${event.sequence} ${describeEvent(event, state, null)}${where}`;
}

/**
 * Prints outcomes as they commit. Names never change, but a ruling can define a
 * new check mid-run, so its challenge joins the labels when it commits.
 */
function outcomePrinter(initial: WorldState): (outcome: StepOutcome) => void {
  const labels = structuredClone(initial);
  return (outcome) => {
    for (const event of outcome.kind === "turn" ? outcome.events : []) {
      if (event.data.type === "ruling" && event.data.challenge) labels.challenges.push(event.data.challenge);
    }
    printOutcome(outcome, labels);
  };
}

function printOutcome(outcome: StepOutcome, state: WorldState): void {
  if (outcome.kind === "failed") {
    const who = outcome.actorId ?? "narrator";
    console.log(`  ✗ ${who} failed after ${outcome.attempts} attempt(s): ${outcome.reason}`);
    return;
  }
  if (outcome.kind === "cancelled") {
    console.log(`  ‖ ${outcome.actorId ?? "narrator"} cancelled: ${outcome.reason}`);
    return;
  }
  for (const event of outcome.events) console.log(`  ${eventLine(event, state)}`);
  if (outcome.attempts > 1) console.log(`    (accepted on attempt ${outcome.attempts})`);
}

function credits(cost: number): string {
  return cost === 0 ? "0" : cost < 0.0001 ? "<0.0001" : cost.toFixed(4);
}

function printReport(report: RunReport): void {
  const failed = report.outcomes.filter((outcome) => outcome.kind === "failed").length;
  console.log(
    `\nStopped: ${report.stopReason}. ${report.turns} turn(s), ${report.modelCalls} model call(s), `
    + `${report.tokens} token(s), ${credits(report.cost)} credit(s), ${failed} failed turn(s).`,
  );
}

async function show(engine: AdventureEngine, worldId: string): Promise<void> {
  const state = await engine.getWorld(worldId);
  const { cast } = await loadSetup(engine, worldId, state, castForWorld);
  const muted = new Set(await engine.getMuted(worldId));
  console.log(`${state.name} (${state.id}), revision ${state.revision}, clock ${formatClock(state.elapsedSeconds)}`);
  const rules = rulesOf(state);
  const stats = rules.stats ? `stats ${rules.stats.strength}/${rules.stats.dexterity}/${rules.stats.wisdom}` : "no stats";
  console.log(`Rules: ${rules.outcomes === "judgment" ? "the referee judges attempts" : "dice"}, ${stats}, ${rules.health ?? "no health"}, ${cast.pace ?? "action"} pace`);
  const ending = state.endings?.find((entry) => entry.id === state.endedWith);
  if (ending) console.log(`Ended: ${ending.name} (${ending.id})`);
  const limits = state.rulings;
  console.log(limits
    ? `Rulings: ${limits.abilities.join("/")}, up to ${limits.maxDifficulty}, ${limits.maxFailureDamage} damage, ${limits.maxSeconds / 60} min`
    : "Rulings: none (attempt is unavailable)");
  for (const location of state.locations) {
    console.log(`\n${location.name} (${location.id})${location.description ? `: ${location.description}` : ""}`);
    for (const route of location.routes) {
      console.log(`  exit → ${place(state, route.destinationId)} (${route.seconds} s)${route.locked ? ", locked" : ""}`);
    }
    for (const character of state.characters.filter((entry) => entry.locationId === location.id)) {
      const items = Object.entries(character.inventory).map(([id, count]) => `${id} ×${count}`).join(", ") || "nothing";
      const personas = character.npc ? cast.npcs ?? {} : cast.characters;
      const tags = [
        ...(character.npc ? ["supporting"] : []),
        ...(Object.hasOwn(personas, character.id) ? [] : ["no agent"]),
        ...(muted.has(character.id) ? ["muted"] : []),
      ];
      const tag = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
      const health = rules.health === null ? "" : `${rules.health} ${character.hp}/${character.maxHp}, `;
      console.log(`  ${character.name} (${character.id})${tag}: ${health}carrying ${items}`);
    }
    for (const challenge of state.challenges.filter((entry) => entry.locationId === location.id)) {
      const details = [
        rules.outcomes === "judgment" ? `judged, difficulty ${challenge.difficulty}` : `${challenge.ability} vs ${challenge.difficulty}`,
        ...(rules.health === null ? [] : [`${challenge.failureDamage} damage on failure`]),
        ...(challenge.requiresItemId ? [`needs ${challenge.requiresItemId}`] : []),
        ...(challenge.onFailure?.lockRoutes ?? []).map((route) => `failure blocks ${route.fromId}→${route.destinationId}`),
        ...(challenge.onFailure?.armThreats ?? []).map((id) => `failure arms ${id}`),
        ...(challenge.onSuccess?.disarmThreats ?? []).map((id) => `success disarms ${id}`),
        challenge.resolved ? "resolved" : "open",
      ];
      console.log(`  challenge ${challenge.name} (${challenge.id}): ${details.join(", ")}`);
      if (challenge.criteria) console.log(`    what it takes: ${challenge.criteria}`);
    }
  }
  const threats = state.threats ?? [];
  if (threats.length > 0) console.log("\nThreats:");
  for (const threat of threats) {
    const when = threat.status === "waiting" ? `${threat.delaySeconds! / 60} min after a consequence arms it` : `at ${formatClock(threat.at!)}`;
    const where = threat.locationIds?.map((id) => place(state, id)).join(", ") ?? "everywhere";
    const damage = threat.damage ? `, ${threat.damage} damage` : "";
    console.log(`  ${threat.name} (${threat.id}): ${threat.status}, ${when}, strikes ${where}${damage}`);
  }
  const endings = state.endings ?? [];
  if (endings.length > 0) console.log("\nEndings:");
  for (const entry of endings) {
    const trigger = "threatId" in entry.when ? `when ${entry.when.threatId} fires` : `when ${entry.when.challengeId} ${entry.when.outcome === "success" ? "succeeds" : "fails"}`;
    console.log(`  ${entry.name} (${entry.id}): ${trigger}`);
  }
}

async function steer(engine: AdventureEngine, worldId: string, words: string[], targetId: string | undefined): Promise<void> {
  const text = words.join(" ").trim();
  if (!text) throw new UsageError("steer needs the request, for example: steer \"Find a way that avoids the channel\"");
  await direct(engine, worldId, { type: "steer", text, ...(targetId === undefined ? {} : { targetId }) });
  console.log(`Steering recorded for ${targetId ?? "everyone"}. Each sees it on their next turn; no agent remembers it.`);
}

async function transcript(engine: AdventureEngine, worldId: string, last: number): Promise<void> {
  const state = await engine.getWorld(worldId);
  for (const event of await engine.getEvents(worldId, Math.max(0, state.revision - last), last)) {
    console.log(eventLine(event, state));
  }
}

async function view(engine: AdventureEngine, worldId: string, characterId: string | undefined): Promise<void> {
  if (!characterId) throw new UsageError("view needs a character ID");
  const state = await engine.getWorld(worldId);
  const { cast } = await loadSetup(engine, worldId, state, castForWorld);
  const prompts = await agentPrompts(engine, worldId, state, cast, characterId);
  const silent = prompts.npc ? "(no persona: this NPC never speaks)" : "(no persona: this character never takes turns)";
  console.log(`=== System prompt ===\n${prompts.system ?? silent}`);
  console.log(prompts.npc ? "\n=== Turn prompt (sent when someone speaks to them) ===" : "\n=== Turn prompt ===");
  console.log(prompts.prompt);
}

function beliefText(belief: Belief): string {
  const cited = belief.evidence.length === 0 ? "" : ` from ${belief.evidence.map((sequence) => `#${sequence}`).join(", ")}`;
  const noted = belief.source === "observed" ? "" : `, ${belief.confidence} confidence, noted #${belief.sequence}`;
  return `${belief.value} [${belief.source}${cited}${noted}]`;
}

/** The inspection view of one character's personal memory. */
async function memory(engine: AdventureEngine, worldId: string, characterId: string | undefined, search: string | undefined): Promise<void> {
  if (!characterId) throw new UsageError("memory needs a character ID");
  const state = await engine.getWorld(worldId);
  const report = await memoryReport(engine, worldId, state, characterId, search);
  const name = state.characters.find((character) => character.id === characterId)!.name;
  console.log(`=== ${name}: goals and commitments ===`);
  if (report.goals.length === 0) console.log("None.");
  for (const goal of report.goals) console.log(`${goal.id} (${goal.kind}, ${goal.status}): ${goal.text}`);
  console.log("\n=== Beliefs, newest first; earlier ones that differ indented beneath ===");
  if (report.beliefs.length === 0) console.log("None.");
  for (const topic of report.beliefs) {
    const about = topic.aboutName === null ? topic.about : `${topic.aboutName} (${topic.about})`;
    console.log(`${about}, ${topic.attribute}: ${beliefText(topic.current)}`);
    for (const older of topic.earlier) console.log(`    was ${beliefText(older)}`);
  }
  console.log(`\n=== Discoveries (only ${name} perceived these) ===`);
  if (report.discoveries.length === 0) console.log("None.");
  for (const entry of report.discoveries) console.log(`#${entry.sequence} ${entry.line}`);
  if (!report.matches) return;
  console.log(`\n=== Perceived events matching "${search}", best first ===`);
  if (report.matches.length === 0) console.log("None.");
  for (const match of report.matches) {
    console.log(`#${match.sequence} ${match.line}`);
    if (match.snippet) console.log(`    …${match.snippet}…`);
  }
}

async function traces(engine: AdventureEngine, worldId: string, last: number, full: boolean): Promise<void> {
  for (const trace of await engine.getTraces(worldId, last)) {
    const tokens = trace.inputTokens === null ? "?" : `${trace.inputTokens}+${trace.outputTokens}`;
    const cost = trace.cost === null ? "" : `, ${credits(trace.cost)} credits`;
    console.log(
      `#${trace.id} ${trace.turnId} ${trace.task ?? trace.role} ${trace.actorId ?? "narrator"} attempt ${trace.attempt}: ${trace.outcome}`
      + ` [${trace.provider}/${trace.model}, prompt ${trace.promptVersion}, ${tokens} tokens${cost}, ${trace.latencyMs} ms]`
      + (trace.error ? `\n    ${trace.error}` : ""),
    );
    if (full) {
      console.log(`--- system\n${trace.request.system}\n--- prompt\n${trace.request.prompt}`);
      console.log(`--- response\n${JSON.stringify(trace.response, null, 2)}\n`);
    }
  }
}

async function report(engine: AdventureEngine, worldId: string): Promise<void> {
  const state = await engine.getWorld(worldId);
  // The latest 1000 events and model calls: the whole of any session so far.
  const events = await engine.getEvents(worldId, Math.max(0, state.revision - 1000), 1000);
  const metrics = computeMetrics(events, await engine.getTraces(worldId, 1000), state);
  const percent = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
  const ms = (value: number | null) => (value === null ? "n/a" : `${Math.round(value)} ms`);
  const amount = (value: number | null) => (value === null ? "unreported" : `${credits(value)} credits`);
  const turns = Object.entries(metrics.turnsByActor).map(([id, count]) => `${id} ${count}`).join(", ") || "none";
  console.log(`${state.name} (${state.id}), revision ${state.revision}, clock ${formatClock(state.elapsedSeconds)}\n`);
  console.log(`Turns: ${metrics.characterTurns} character, ${metrics.npcTurns} NPC (${turns})`);
  console.log(`Turns to first action: ${metrics.turnsToFirstAction ?? "none yet"}; longest run without an action: ${metrics.longestStall}`);
  console.log(`Threats fired: ${metrics.threatsFired}; director steering requests: ${metrics.steeringRequests}`);
  const { rulings } = metrics;
  console.log(`Rulings: ${rulings.existing} existing, ${rulings.new} new, ${rulings.automatic} automatic, ${rulings.impossible} impossible`);
  console.log(`Invalid proposals: ${percent(metrics.invalidProposalRate)} of answered turn and ruling calls`);
  console.log(`Model calls: ${metrics.calls}, ${metrics.tokens} tokens, ${amount(metrics.cost)}`);
  console.log(`Per turn: ${amount(metrics.costPerTurn)}, ${ms(metrics.latencyPerTurnMs)} of model time\n`);
  for (const task of metrics.tasks.filter((entry) => entry.calls > 0)) {
    console.log(
      `  ${task.task.padEnd(15)} ${String(task.calls).padStart(4)} call(s), ${task.invalid} invalid, `
      + `${task.providerErrors} provider error(s), ${task.cancelled} cancelled, mean ${ms(task.meanLatencyMs)}, ${amount(task.cost)}`,
    );
  }
}

async function rehearse(engine: AdventureEngine, worldId: string): Promise<void> {
  const initial = await engine.createWorld(starterWorld(worldId));
  if (initial.revision > 1) {
    throw new UsageError(`World ${worldId} already has turns; pass --world with a new ID to rehearse again`);
  }
  console.log(`Rehearsing ${worldId}: scripted agents, every die shows ${REHEARSAL_ROLL}.\n`);
  const runner = new TurnRunner(engine, new ScriptedProvider(rehearsalScript()), starterCast);
  const report = await runner.run(worldId, { maxTurns: REHEARSAL_TURNS }, outcomePrinter(initial));
  printReport(report);
  await engine.replayWorld(worldId);
  console.log("Replay reproduced the stored state and perceivers.");
  console.log(`Try: npm run director -- view elowen --world ${worldId}`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseCommandLine();
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  const known = [
    "init", "step", "cue", "mute", "unmute", "steer", "run", "show", "transcript", "view", "memory", "traces", "report",
    "rehearse", "models",
  ];
  if (!known.includes(command)) throw new UsageError(`Unknown command: ${command}\n\n${USAGE}`);
  if (command === "models") {
    await listModels(rest);
    return;
  }
  const worldId = values.world ?? (command === "rehearse" ? "aqueduct-rehearsal" : "aqueduct-adventure");
  const turns = command === "run" ? positiveInteger(values.turns, "turns") : undefined;
  if (command === "run" && turns === undefined) throw new UsageError("run needs --turns N");
  const limits = {
    maxModelCalls: positiveInteger(values["max-calls"], "max-calls"),
    maxTokens: positiveInteger(values["max-tokens"], "max-tokens"),
    maxCost: positiveNumber(values["max-cost"], "max-cost"),
  };
  const last = positiveInteger(values.last, "last", command === "traces" ? 10 : 40)!;
  if (command === "cue" && rest.length !== 1) throw new UsageError("cue needs exactly one character ID");
  if (command === "unmute" && rest.length === 0 && !values.all) throw new UsageError("unmute needs character IDs, or --all");
  // The API key is checked before the database is touched; the models come from the world's setup unless --model overrides them.
  const playing = command === "step" || command === "run" || command === "cue";
  if (playing) openRouterSettingsFromEnv(process.env, values.model);

  const options: EngineOptions = {
    ...(values.schema === undefined ? {} : { schema: values.schema }),
    ...(command === "rehearse" ? { roll: () => REHEARSAL_ROLL } : {}),
  };
  const engine = await openConfiguredEngine(options);
  try {
    switch (command) {
      case "init": {
        const state = await engine.createWorld(starterWorld(worldId));
        console.log(state.revision === 1 ? `Created ${worldId}.\n` : `Resumed ${worldId}.\n`);
        await show(engine, worldId);
        break;
      }
      case "mute":
      case "unmute": {
        const ids = command === "unmute" && values.all ? await engine.getMuted(worldId) : rest;
        const muted = ids.length === 0 ? await engine.getMuted(worldId) : await engine.setMuted(worldId, ids, command === "mute");
        console.log(muted.length === 0 ? "Nobody is muted." : `Muted: ${muted.join(", ")}`);
        break;
      }
      case "step":
      case "cue":
      case "run": {
        const state = await engine.getWorld(worldId);
        const setup = await loadSetup(engine, worldId, state, castForWorld);
        const provider = values.model === undefined
          ? await providerForSetup(setup.models, process.env)
          : await OpenRouterProvider.create(openRouterSettingsFromEnv(process.env, values.model));
        console.log(`Characters: ${provider.describe("character")}\nNarrator: ${provider.describe("dm")}\n`);
        const runner = new TurnRunner(engine, provider, setup.cast);
        const print = outcomePrinter(state);
        const pause = new AbortController();
        const interrupt = () => {
          if (pause.signal.aborted) process.exit(130);
          pause.abort();
          console.log("\nPausing: an unfinished turn will not commit. Press Ctrl+C again to quit now.");
        };
        process.on("SIGINT", interrupt);
        try {
          const options = { signal: pause.signal };
          if (command === "run") printReport(await runner.run(worldId, { maxTurns: turns!, ...limits }, print, options));
          else if ((await runner.step(worldId, print, { ...options, actorId: rest[0] })).length === 0) {
            console.log("Nobody took a turn: no unmuted character can act. Cue one with cue CHARACTER, or unmute someone.");
          }
        } finally {
          process.off("SIGINT", interrupt);
        }
        break;
      }
      case "show":
        await show(engine, worldId);
        break;
      case "transcript":
        await transcript(engine, worldId, last);
        break;
      case "view":
        await view(engine, worldId, rest[0]);
        break;
      case "memory":
        await memory(engine, worldId, rest[0], values.search);
        break;
      case "steer":
        await steer(engine, worldId, rest, values.to);
        break;
      case "traces":
        await traces(engine, worldId, last, values.full ?? false);
        break;
      case "report":
        await report(engine, worldId);
        break;
      case "rehearse":
        await rehearse(engine, worldId);
        break;
    }
  } finally {
    await engine.close();
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof UsageError || error instanceof ProviderConfigError) {
    console.error(error.message);
  } else if (error instanceof EngineError) {
    console.error(`${error.code}: ${error.message}`);
  } else {
    throw error;
  }
  process.exitCode = 1;
}
