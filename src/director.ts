import { parseArgs } from "node:util";
import { REHEARSAL_ROLL, REHEARSAL_TURNS, rehearsalScript } from "./adventures/rehearsal.ts";
import { starterCast, starterWorld } from "./adventures/starter.ts";
import { describeEvent, formatClock } from "./agents/context.ts";
import {
  capabilitiesOf, DEFAULT_OPENROUTER_MODEL, fetchOpenRouterModels, OpenRouterProvider, openRouterSettingsFromEnv,
  REASONING_EFFORTS,
} from "./agents/openrouter.ts";
import type { ModelCapabilities, OpenRouterModel } from "./agents/openrouter.ts";
import { characterSystemPrompt } from "./agents/prompts.ts";
import { ProviderConfigError, ScriptedProvider } from "./agents/provider.ts";
import { buildCharacterPrompt, DEFAULT_RUNNER_SETTINGS, TurnRunner } from "./agents/runner.ts";
import type { RunReport, StepOutcome } from "./agents/runner.ts";
import { openConfiguredEngine } from "./config.ts";
import type { AdventureEngine, EngineOptions } from "./engine.ts";
import { EngineError } from "./model.ts";
import type { AdventureEvent, WorldState } from "./model.ts";

const USAGE = `Usage: npm run director -- <command> [options]

Commands:
  init               Create the starter adventure, or resume it if it exists
  step               Run exactly one character turn, plus any narration it needs
  run --turns N      Run up to N turns; limit spending with --max-calls N, --max-tokens N
  show               Admin view of the world (never sent to agents)
  transcript         Admin transcript, including dice; --last N (default 40)
  view CHARACTER     Exactly what that character's agent is sent
  traces             Recent model calls; --last N (default 10), --full for prompts and replies
  rehearse           Play a scripted opening, with no model and fixed dice, into its own world
  models [TEXT]      List OpenRouter models, or only those whose ID or name contains TEXT

Options:
  --world ID         World to use (default aqueduct-adventure; rehearse uses aqueduct-rehearsal)
  --schema NAME      PostgreSQL schema (default public)
  --model ID         OpenRouter model for step and run (default ${DEFAULT_OPENROUTER_MODEL})

step and run call models through OpenRouter and need OPENROUTER_API_KEY (see README).
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
        last: { type: "string" },
        full: { type: "boolean" },
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

function printOutcome(outcome: StepOutcome, state: WorldState): void {
  if (outcome.kind === "failed") {
    const who = outcome.actorId ?? "narrator";
    console.log(`  ✗ ${who} failed after ${outcome.attempts} attempt(s): ${outcome.reason}`);
    return;
  }
  for (const event of outcome.events) console.log(`  ${eventLine(event, state)}`);
  if (outcome.attempts > 1) console.log(`    (accepted on attempt ${outcome.attempts})`);
}

function printReport(report: RunReport): void {
  const failed = report.outcomes.filter((outcome) => outcome.kind === "failed").length;
  console.log(
    `\nStopped: ${report.stopReason}. ${report.turns} turn(s), ${report.modelCalls} model call(s), `
    + `${report.tokens} token(s), ${failed} failed turn(s).`,
  );
}

async function show(engine: AdventureEngine, worldId: string): Promise<void> {
  const state = await engine.getWorld(worldId);
  console.log(`${state.name} (${state.id}), revision ${state.revision}, clock ${formatClock(state.elapsedSeconds)}`);
  for (const location of state.locations) {
    console.log(`\n${location.name} (${location.id})${location.description ? `: ${location.description}` : ""}`);
    for (const route of location.routes) {
      console.log(`  exit → ${place(state, route.destinationId)} (${route.seconds} s)${route.locked ? ", locked" : ""}`);
    }
    for (const character of state.characters.filter((entry) => entry.locationId === location.id)) {
      const items = Object.entries(character.inventory).map(([id, count]) => `${id} ×${count}`).join(", ") || "nothing";
      const persona = Object.hasOwn(starterCast.characters, character.id) ? "" : " [no agent]";
      console.log(`  ${character.name} (${character.id})${persona}: HP ${character.hp}/${character.maxHp}, carrying ${items}`);
    }
    for (const challenge of state.challenges.filter((entry) => entry.locationId === location.id)) {
      const details = [
        `${challenge.ability} vs ${challenge.difficulty}`,
        `${challenge.failureDamage} damage on failure`,
        ...(challenge.requiresItemId ? [`needs ${challenge.requiresItemId}`] : []),
        challenge.resolved ? "resolved" : "open",
      ];
      console.log(`  challenge ${challenge.name} (${challenge.id}): ${details.join(", ")}`);
    }
  }
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
  const character = state.characters.find((entry) => entry.id === characterId);
  if (!character) throw new EngineError("NOT_FOUND", `Unknown character: ${characterId}`);
  const persona = starterCast.characters[characterId];
  console.log("=== System prompt ===");
  console.log(persona ? characterSystemPrompt(character.name, persona) : "(no persona: this character never takes turns)");
  console.log("\n=== Turn prompt ===");
  console.log(await buildCharacterPrompt(engine, worldId, state, characterId, DEFAULT_RUNNER_SETTINGS.recentEvents));
}

async function traces(engine: AdventureEngine, worldId: string, last: number, full: boolean): Promise<void> {
  for (const trace of await engine.getTraces(worldId, last)) {
    const tokens = trace.inputTokens === null ? "?" : `${trace.inputTokens}+${trace.outputTokens}`;
    console.log(
      `#${trace.id} ${trace.turnId} ${trace.actorId ?? "narrator"} attempt ${trace.attempt}: ${trace.outcome}`
      + ` [${trace.provider}/${trace.model}, prompt ${trace.promptVersion}, ${tokens} tokens, ${trace.latencyMs} ms]`
      + (trace.error ? `\n    ${trace.error}` : ""),
    );
    if (full) {
      console.log(`--- system\n${trace.request.system}\n--- prompt\n${trace.request.prompt}`);
      console.log(`--- response\n${JSON.stringify(trace.response, null, 2)}\n`);
    }
  }
}

async function rehearse(engine: AdventureEngine, worldId: string): Promise<void> {
  const initial = await engine.createWorld(starterWorld(worldId));
  if (initial.revision > 1) {
    throw new UsageError(`World ${worldId} already has turns; pass --world with a new ID to rehearse again`);
  }
  console.log(`Rehearsing ${worldId}: scripted agents, every die shows ${REHEARSAL_ROLL}.\n`);
  const runner = new TurnRunner(engine, new ScriptedProvider(rehearsalScript()), starterCast);
  const report = await runner.run(worldId, { maxTurns: REHEARSAL_TURNS }, (outcome) => printOutcome(outcome, initial));
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
  const known = ["init", "step", "run", "show", "transcript", "view", "traces", "rehearse", "models"];
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
  };
  const last = positiveInteger(values.last, "last", command === "traces" ? 10 : 40)!;
  // Provider configuration is checked before the database is touched.
  const provider = command === "step" || command === "run"
    ? await OpenRouterProvider.create(openRouterSettingsFromEnv(process.env, values.model))
    : undefined;

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
      case "step":
      case "run": {
        console.log(`Characters: ${provider!.describe("character")}\nNarrator: ${provider!.describe("dm")}\n`);
        // Names never change, so the current state can label every outcome.
        const state = await engine.getWorld(worldId);
        const runner = new TurnRunner(engine, provider!, starterCast);
        const print = (outcome: StepOutcome) => printOutcome(outcome, state);
        if (command === "step") await runner.step(worldId, print);
        else printReport(await runner.run(worldId, { maxTurns: turns!, ...limits }, print));
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
      case "traces":
        await traces(engine, worldId, last, values.full ?? false);
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
