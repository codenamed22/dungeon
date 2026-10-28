# Dungeons

A director-mode multi-agent adventure engine. Character agents talk and propose
actions; a rules engine decides outcomes; a DM agent narrates what was committed.
Phase 1 delivered durable world state and validated actions. Phase 2a adds the
turn pipeline: speech, perception, narration, and a command-line director.
See [the full plan](./PLAN.md).

## Requirements

- Node.js 24 or newer.
- PostgreSQL 14 or newer, locally or through Neon.
- A database role allowed to create the engine's tables, functions, and triggers.
- An [OpenRouter](https://openrouter.ai) API key for live play (`step` and `run`).

## Setup with Neon

The app is linked to Neon project `snowy-dream-76584629`, branch `production`,
in organization `org-rapid-wind-66619885`. [neon.ts](./neon.ts) configures
PostgreSQL only; Auth and other optional services are not enabled.

```sh
npm install
npx neon@latest deploy
npm run build
npm start
```

`neon deploy` provisions backend services and pulls their environment variables;
it does not host this Node application. The app is a command-line program, not a
web server. `npm start` runs the compiled demo and exits.

The CLI writes `.env.local`, or `.env` if it already exists. App commands load
both files: `.env.local` overrides `.env`, and exported environment variables take
precedence over both. Keep these files private; both are ignored by Git.

The app validates `DATABASE_URL` and `DATABASE_URL_UNPOOLED` using `@neon/env`
against the service configuration. Pooled `DATABASE_URL` handles runtime queries;
direct `DATABASE_URL_UNPOOLED` handles migrations. Neon host URLs are normalized
to `sslmode=verify-full` in memory, preserving certificate and hostname
verification. No Neon API key is needed at app runtime.

For manual configuration, copy `.env.example` to `.env` and supply both URLs.
For local PostgreSQL they may be the same direct connection string. Keep TLS
enabled for Neon; never disable certificate validation to resolve a connection
error.

**Every app command migrates the database it connects to.** The first Phase 2a
command run against a Phase 1 database upgrades it in place (see
[Persistence](#persistence)). Point development at local PostgreSQL or a Neon
development branch, not `production`.

The demo (`npm start`, or `npm run demo` from source) creates the small sample
adventure if needed, commits one minute of waiting, and verifies event replay.
Run it again to resume the same world. It makes real writes. Credentials are
never hard-coded or printed.

### Verify the deployed database

```sh
npm run build
npm run verify:neon
```

Verification checks direct TLS connectivity, migrations, pooled writes, a turn
with speech and an item transfer, movement and time, who perceived each event,
reconnect persistence, event replay, idempotent retry, and stale action
rejection. It works in a unique schema and removes only that schema.

## Director CLI

```sh
npm run director -- <command> [--world ID] [--schema NAME] [--model ID]
```

| Command | What it does |
|---|---|
| `init` | Create the starter adventure, *The Dry Aqueduct*, or resume it. |
| `step` | Run exactly one character turn, plus any narration it needs. |
| `run --turns N` | Run up to N turns. `--max-calls N` and `--max-tokens N` cap spending. |
| `show` | Admin view of the world: places, exits, characters, challenges with numbers. |
| `transcript [--last N]` | Admin transcript, including dice rolls. |
| `view CHARACTER` | Exactly what that character's agent is sent: system prompt and turn prompt. |
| `traces [--last N] [--full]` | Recent model calls with outcome, tokens, and latency; `--full` adds prompts and replies. |
| `rehearse` | Play a scripted opening, with no model and every die showing 15, into its own world (`aqueduct-rehearsal`). |
| `models [TEXT]` | List OpenRouter models whose ID or name contains TEXT, with output support, prices, context, and reasoning efforts. Needs no key. |

Nothing runs on its own: turns happen only on `step` or `run`. A run stops at
its turn, model-call, or token limit; after three consecutive failed turns; or
after six consecutive character turns without an action (a stalled debate),
whichever comes first. `show` and `transcript` reveal hidden numbers; never paste
them into an agent's context.

`rehearse` exercises the whole pipeline without credentials: travel, a
speech-only turn, a proposal the engine rejects and the agent revises, a check
that unlocks a route, and narration after each action. Follow it with
`view elowen --world aqueduct-rehearsal` to see one character's context.

### Models

`step` and `run` call models through [OpenRouter](https://openrouter.ai). Set
`OPENROUTER_API_KEY` in `.env.local` or `.env`, or export it (see
[.env.example](./.env.example)). Characters and narrator default to
`~deepseek/deepseek-pro-latest`, OpenRouter's alias for the latest DeepSeek Pro.
Pick another model with `--model` for one command, or in the environment:

```sh
npm run director -- models deepseek
npm run director -- step --model ~deepseek/deepseek-flash-latest
```

| Variable | Default | Meaning |
|---|---|---|
| `DUNGEONS_MODEL` | `~deepseek/deepseek-pro-latest` | Model for both roles. |
| `DUNGEONS_CHARACTER_MODEL`, `DUNGEONS_DM_MODEL` | `DUNGEONS_MODEL` | Model for one role. `--model` overrides both. |
| `DUNGEONS_REASONING_EFFORT` | `low` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `default` (the model's own). |
| `DUNGEONS_CHARACTER_EFFORT`, `DUNGEONS_DM_EFFORT` | `DUNGEONS_REASONING_EFFORT` | Effort for one role. |
| `DUNGEONS_MAX_OUTPUT_TOKENS` | `4096` | Output limit per call, reasoning included. |

Before the first turn, the director checks each model against OpenRouter's
catalog and prints the model and settings each role will use. Requests use only
what a model supports: structured output (the reply schema is enforced) where
available, otherwise JSON mode, otherwise instructions alone. OpenRouter routes
them only to providers that honor every parameter sent.

Reasoning effort defaults to `low` because reasoning tokens are billed as
output, and the default model otherwise reasons at `high`. If no effort is
configured and a model does not offer `low`, the nearest effort it does offer
is used, and the startup banner says so. A configured effort the model does not
support is an error. `models` shows each model's headline price; the provider
that serves a request may charge differently, so check spend on OpenRouter and
cap runs with `--max-calls` and `--max-tokens`.

Rate limits, server errors, and network errors are retried twice with backoff.
Every other failure (a timeout, refusal, truncated reply, invalid key, or
exhausted credits) fails the attempt at once and is traced, and a run stops
after three consecutive failed turns.

Providers implement `ModelProvider` in
[src/agents/provider.ts](./src/agents/provider.ts); `rehearse` uses a scripted
provider with no network. The runner validates every reply again, so a provider
cannot commit anything the engine would reject.

## How a turn works

1. If the last character turn's actions have no narration yet, the DM narrates
   them first.
2. The next speaker is chosen round-robin in world order, skipping characters
   who are incapacitated or have no persona in the cast. The order comes from
   the event log, so it survives restarts.
3. The character's agent receives only its own perception (place, exits,
   people present and their visible condition, challenges with difficulty
   *bands*), its inventory, the events it perceived, and its legal actions with
   entity IDs.
4. It replies with optional speech and an optional action. Speech is committed
   before the action, atomically, under one request ID.
5. An invalid reply, or an action the engine rejects, goes back to the agent
   with the reason, up to two revisions. If the world changed meanwhile, the
   proposal is regenerated from fresh context. A turn that never validates is
   recorded as failed and commits nothing; the same character is asked again
   next time.
6. The DM narrates committed actions. Narration reaches exactly the characters
   who perceived those actions, and the narrator sees earlier events only if
   every one of those characters perceived them too.

Every model call is traced: role, model, prompt version, the context sent, the
raw reply, outcome, tokens, and latency. Turn request IDs derive from the world
revision and speaker (`t12-mira`), so a duplicated or resumed turn cannot commit
twice.

## Engine API

```ts
import { openConfiguredEngine } from "./src/config.ts";
import { sampleWorld } from "./src/sample-world.ts";

const engine = await openConfiguredEngine();
try {
  const state = await engine.createWorld(sampleWorld());
  const result = await engine.execute(state.id, {
    role: "character",
    requestId: "mira-scouts-ridge-001",
    expectedRevision: state.revision,
    actorId: "mira",
    speech: "I'll check the ridge.",
    action: { type: "move", destinationId: "ridge" },
  });
  console.log(result.events);
} finally {
  await engine.close();
}
```

A character command carries `speech`, `action`, or both. A DM command narrates
committed actions: `{ role: "dm", requestId, expectedRevision, action: { type:
"narrate", aboutSequences: [12], text } }`.

Provide a unique request ID for each new command. Retry an uncertain request with
**exactly the same input**, including its original expected revision. A retry
returns the original events and the state right after them, not the latest
snapshot. Changed input under an existing request ID fails with
`REQUEST_CONFLICT`. A new command against an old revision fails with
`STALE_REVISION`; fetch current state and reconsider.

| Method | Returns |
|---|---|
| `getWorld(worldId)` | Full admin state. Never send it to an agent. |
| `getEvents(worldId, afterSequence, limit)` | Bounded, ordered admin history. |
| `getPerceivedEvents(worldId, characterId, limit)` | The most recent events that character perceived, oldest first. |
| `getPerceivers(worldId, sequence)` | Who perceived one event. |
| `replayWorld(worldId)` | State rebuilt from events, after checking it and every event's perceivers against storage. |
| `recordTrace`, `getTraces` | Model-call traces. |

For what a character can currently perceive and do, use `perceive` and
`availableActions` from [src/perception.ts](./src/perception.ts).

### Actions and world rules

| Action | Rules |
|---|---|
| `move` | Follow an outgoing, unlocked route; its definition determines elapsed time. |
| `transfer_item` | Positive integer quantity, owned items, a different recipient in the same location. Takes no time. |
| `attempt_check` | An unresolved challenge in the actor's location, carrying any required item. The engine rolls d20 and uses the world's difficulty, ability modifier, time, and failure damage. |
| `wait` | Advance in-world time by 1 to 3600 seconds. |

Speech costs the world's `speechSeconds` (10 in the bundled adventures), so long
debates let time pass. Checks succeed when `d20 + modifier >= difficulty`, with
no natural-1/20 overrides. A successful check can unlock routes and grant items,
as its world definition says. Failed checks stay available, with their normal
time and damage costs. Zero-HP characters cannot act and perceive nothing.
Routes are directional.

Perceivers are recorded when an event commits: conscious characters at the
event's location, plus the actor. A move is perceived at both ends.

## Persistence

- Each accepted command writes its events, their perceivers, the snapshot, and a
  retry receipt in one transaction. A per-world row lock serializes commands
  across application instances.
- Event sequence numbers are world revisions; creation is revision 1. Events
  record their source: `director`, `character`, `dm`, or `engine`.
- Events carry a format version. Phase 1 events (format 1, time in minutes) are
  upcast when read; stored history is never rewritten.
- Schema changes are numbered migrations recorded in `schema_migrations`,
  serialized by an advisory lock, and run in one transaction: a failed migration
  changes nothing. Migration 2 rebuilds snapshots and backfills perceivers from
  history. An app refuses a database migrated by a newer version.
- Database triggers reject ordinary SQL UPDATE, DELETE, and TRUNCATE on events,
  perceivers, and receipts. A database owner can still disable triggers or drop
  tables: this is not tamper-proof storage.
- `createWorld` resumes an existing world only if its original seed matches. The
  sample world matches upcast Phase 1 copies, so they keep resuming.
- Traces are diagnostic records, not canonical history.

Use a separate migration role and restricted runtime role before deploying a
shared production service.

## Tests

```sh
npm run typecheck
npm test
```

Pure tests always run: rules, perception, upcasting, the agent protocol, and
prompt canaries. Integration tests require `TEST_DATABASE_URL` and are skipped
when it is absent. Use a dedicated test database or Neon test branch; the tests
create uniquely named schemas and remove only those.

```sh
createdb dungeons_test
TEST_DATABASE_URL='postgresql://localhost:5432/dungeons_test' npm test
```

Integration coverage includes:

- **Engine:** restart and replay, concurrent commands, idempotent retries
  without rerolled dice, atomic speech and action, perceivers and narration
  audiences, tamper detection, rollback after a forced write failure,
  append-only protection, pagination, and corrupt snapshots.
- **Migrations:** Phase 1 databases upgrade in place and keep playing; a failed
  migration rolls back completely; reruns and concurrent runs are safe; newer
  databases are refused.
- **Turn runner:** the scripted rehearsal end to end; context isolation with
  canary phrases; rejected and invalid proposals with feedback; provider
  failures; turn, call, token, and stall limits; owed narration after an
  interruption; speaker rotation across restarts; stale proposals; duplicate
  turns.
