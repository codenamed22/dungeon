# Dungeons

A director-mode multi-agent adventure engine. Character agents talk and propose
actions; a rules engine decides outcomes; a DM agent narrates what was committed.
Phase 1 delivered durable world state and validated actions. Phase 2a added the
turn pipeline: speech, perception, narration, and a command-line director.
Phase 2b added the ensemble: speaker selection by direct address, NPCs voiced by
the DM, open-ended attempts resolved by DM rulings, pause, a per-world scheduler
lease, cost limits, and session metrics. Phase 3 added personal memory: private
discoveries, evidence-linked beliefs that keep hearsay as hearsay, goals and
commitments, and recall of older events scoped to what each character perceived.
Phase 4 added world progression: timed threats that interrupt travel and waiting,
hidden delayed consequences of checks, NPCs with agendas of their own, a bounded
response to stalled debate, and director steering outside the story.
Phase 5 adds the web director: set up the agents, watch the conversation live,
and direct it by steering, introducing events, retconning, and branching.
Stories need not be fantasy: each world chooses dice or a referee AI's judgment,
its own stats and health (or none), its pace, and optional endings. A friendship
story, an incident on call, and a country-house mystery are bundled alongside
the dungeon. See [the full plan](./PLAN.md).

## Requirements

- Node.js 24 or newer.
- PostgreSQL 14 or newer, locally or through Neon.
- A database role allowed to create the engine's tables, functions, and triggers.
- An [OpenRouter](https://openrouter.ai) API key for live play (`step` and `run`).
- For the web director: React and Vite, installed as development dependencies
  by `npm install`.

`package-lock.json` names only the public npm registry, so a build machine such
as Vercel can install from it. npm on a machine with a private mirror still
downloads through the mirror, but writes the mirror's URLs into the lockfile
when it adds or updates a package: run `npm run lock:public` afterwards. A test
fails until you do.

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

## Web director

The web director shows every character's private memory and spends model
credit. Without a login it stays on your machine: it listens only on
`127.0.0.1`, refuses any other `HOST`, and answers only requests addressed to
`localhost`, `127.0.0.1`, or `::1`, which stops other websites from reaching it
through DNS rebinding. Writes must be JSON, and a browser's `Origin` must be one
of those hosts. [Google sign-in](#google-sign-in) adds a login.

```sh
npm install
npm run build:web
createdb dungeons_dev   # once
DATABASE_URL=postgresql://localhost:5432/dungeons_dev \
DATABASE_URL_UNPOOLED=postgresql://localhost:5432/dungeons_dev \
npm run web
```

Then open <http://localhost:4317>. `npm run web` reads `.env.local` like the
other commands; exported variables take precedence over the files, so the
example above uses a local database whatever `.env.local` says. The banner
prints the database host and name it connected to (never credentials) and
whether an OpenRouter key is set. `PORT` changes the port and `DUNGEONS_SCHEMA`
the schema. Ctrl+C pauses runs (an unfinished turn does not commit) and stops.

To work on the interface, run `npm run web` and, in another terminal,
`npm run dev:web`: Vite serves the interface with hot reload at
<http://127.0.0.1:5173> and forwards `/api` to the server.

### Google sign-in

Sign-in is set up as in Traveller: Auth.js (`@auth/core`, the core of
next-auth) with the Google provider, a session cookie, and an email allowlist.
Set all five variables in `.env.local`. Setting only some stops the server,
which names the missing ones; setting none keeps the no-login mode above.

| Variable | Purpose |
|---|---|
| `AUTH_SECRET` | Random secret of at least 32 characters for the session cookie: `openssl rand -base64 33` |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | Google OAuth web-client credentials. Traveller's client works once the redirect URI below is added to it |
| `ALLOWED_EMAILS` | Comma-separated Google accounts that may sign in. No other account can, and removing one takes effect at its next request |
| `AUTH_URL` | The director's origin: `http://localhost:4317` locally, the deployed https origin elsewhere |

Add `http://localhost:4317/api/auth/callback/google` (and the deployed
origin's equivalent) to the OAuth client's authorized redirect URIs. Use one
host name consistently: open the director at `localhost`, not `127.0.0.1`.
Google returns to `AUTH_URL`, so sign in on the built interface there, not
through the Vite dev server.

With sign-in on, every page asks for an allowed Google account first, on this
machine too, and the header has a sign-out button. The API answers only
`/api/health` and `/api/session` without a session: anything else gets 401, or
403 for an account taken off the list. The host and same-site checks above
still apply. The server may then listen beyond this machine (for example
`HOST=0.0.0.0`), but only with an https `AUTH_URL`, so the cookie never travels
unencrypted; TLS comes from whatever sits in front of it. A localhost
`AUTH_URL` must use the same port as `PORT`. The banner says whether login is
on and how many accounts are allowed, never which. Sessions last 30 days
(Auth.js's default); signing out clears the cookie in that browser.

What you can do:

- **Worlds.** Reopen any world, most recent first, or start a new one: describe
  it to the AI creator, start blank, copy a bundled story to change it, or play
  one as it is. The bundled stories are *The Dry Aqueduct* and *The Ridge*
  (fantasy, with dice and HP), *The Night Market* (two friends, one confession,
  no danger), *The 3 A.M. Outage* (two engineers, a failing checkout, an
  incident commander with the wrong theory), and *Dinner at Ashcombe House* (a
  1926 murder, five people, several lies). Several browser tabs can follow the
  same world.
- **Create.** The world creator edits a draft with simple forms, one section at
  a time. **Story** holds the title, the premise, the narrator's style, the
  rules, and whether characters may try things no challenge covers (and within
  what limits). The rules say how attempts are decided (AI judgment or dice),
  whether characters have stats (three, named for the world, such as Charm, Wit,
  and Empathy) and health (named too, such as HP or Composure), and the pace:
  *action* presses a group that only talks to act; *conversation* lets talk
  carry the scene. Turning stats or health off clears them everywhere, with
  Undo. **Places** have descriptions and ways out, timed in minutes, which may
  start blocked. **Characters** are main characters (each played by its own
  agent) or supporting characters (voiced by the game master), with a starting
  place, health and stats if the world has them, what they carry, and their
  persona. **Items**, **Challenges** (how hard it is, what it takes, which only
  the referee reads, the stat it leans on, what success opens, gives, reveals
  privately, sets off, or stops, and what failure blocks or sets off),
  **Threats** (at a set time, or after a challenge sets them off, in some places
  or everywhere), and **Endings** (closing text, set off by a challenge's
  success or failure or by a threat) complete it. Drafts save as you type. **Review** lists
  what stops the world being played, and what would improve it, each with a link
  to where you fix it; then **Create world** makes it playable. A draft that
  became a world no longer changes; copy it to make another version. Removing
  something removes every reference to it, and offers Undo.
- **AI creator.** Drag the Creator tab in from the right edge, or tap it, and
  ask for a whole world or one piece of it: "Draft a first date at a night
  market", "Set up a 3 a.m. outage for two engineers", "Add a character who
  lies", "Give it an ending", "What's missing?". It works through the same
  operations as the forms, as tool calls, so the draft changes in front of you
  and every step is listed. Each message's changes can be undone while nothing
  has changed since, and Stop keeps what it has done so far. A message is
  limited to 8 model calls, 40 tool calls, and 0.50 credits (or 400,000 tokens
  when the cost is not reported), and the panel shows what the draft has cost.
  Pick any OpenRouter model that can call tools; the server's default is
  `DUNGEONS_CREATOR_MODEL` (see [Models](#models)).
- **Premise.** Every AI is told the world's premise in its system prompt:
  setting, genre, tone, and stakes. The main characters read it too, so keep
  secrets and solutions out of it.
- **Agents.** Choose which main characters an agent plays, and write each one's
  persona: who they are, who they are to the others, how they speak, what they
  want, and their attitude to risk. "Who they are to the others" (such as "the
  incident commander tonight") goes into every AI's system prompt as a who's-who
  list, so the characters know who they're talking to; keep secrets out of it. Do the same for supporting characters, whom the game master voices, with
  what they know (which may be wrong), what they want, and an optional agenda
  that makes them speak up unprompted. Edit the premise and the pace, and see
  the narrator's and referee's system prompts. Pick the character and game
  master models, searchable among OpenRouter's
  models with prices, and each role's reasoning effort. The setup is saved with
  the world and applies from the next turn, in the web director and the CLI
  alike.
- **Play.** Step one turn, run several within turn, model-call, and credit
  limits, cue one character, or pause. On a new Dry Aqueduct world, the
  scripted opening plays eight turns for free, with no model and every die
  showing 15. Nothing runs on its own. When a story reaches an ending, a banner
  shows its closing text and nothing more can happen; branch from an earlier
  event to play on.
- **Watch.** Committed events appear as they happen: speech, narration, checks,
  threats, and the director's own events, each marked with who perceived it and
  whether it was private, hidden, or out of the story. Switch the feed to one
  character to see only what they perceived. The side panel shows character
  sheets, the true state of the world, exactly what each agent is sent, each
  character's memory with search, the session report, and every model call with
  its prompt and reply.
- **Direct.** Mute and unmute characters, and steer everyone or one character
  outside the story, as in the CLI. Introduce an event: something that happens
  in the story, where you say (or everywhere), perceived and remembered by the
  conscious characters there, and optionally blocking or opening a way.
  Send a character away from the scene, or bring one in at a place you choose,
  with optional words for how it looks; whoever is there sees it happen.
  Retcon a narration, a line of speech, or an introduced event that changed no
  route: those who perceived it receive a correction, and their agents no
  longer see the original, in their transcript or in search. Branch a world
  after any turn, into a new world with the same history and setup, to try
  another course; the original is untouched.

The interface works on a phone-sized screen, with a dark theme that follows
the system (or the header's switch): the world page shows one pane at a time,
chosen from a bar at the bottom, and run controls and event actions open as
sheets. The web director only listens on this machine, so a phone cannot reach
it until it is deployed with a login.

Retcons never delete anything: the original stays in the log, struck through,
and a `retraction` event records the correction. A retcon cannot undo a change
of state (a move, a check, an item handed over); branch from before it instead.

The server's HTTP API, under `/api`, is what the interface uses:

| Route | What it does |
|---|---|
| `GET /api/worlds`, `POST /api/worlds` | List worlds; create one from `{id, name?, adventureId}` or `{id, name?, seed}`. |
| `GET /api/worlds/:id` | The world's state, mutes, setup, resolved models, and run status. |
| `GET /api/worlds/:id/events?after=N` | The admin log, with each event's perceivers. |
| `GET /api/worlds/:id/stream` | Server-sent events: new committed events and run status. Resumes from `Last-Event-ID`. |
| `GET /api/worlds/:id/agents/:character` | What that agent is sent. |
| `GET /api/worlds/:id/prompts` | The narrator's and referee's system prompts. |
| `GET /api/worlds/:id/memory/:character?search=TEXT` | Their goals, beliefs, discoveries, and search results. |
| `GET /api/worlds/:id/traces`, `GET /api/worlds/:id/report` | Model calls; session metrics. |
| `PUT /api/worlds/:id/setup` | Save personas and models. |
| `POST /api/worlds/:id/mute`, `steer`, `introduce`, `enter`, `exit`, `retcon`, `branch` | Director actions. `enter` takes `{characterId, locationId, text?}`, `exit` takes `{characterId, text?}`. |
| `POST /api/worlds/:id/step`, `run`, `rehearse`, `pause` | Start or pause a run in the background; its progress arrives on the stream. |
| `GET /api/adventures`, `GET /api/models?q=TEXT` | Built-in adventures; OpenRouter models, with whether each can call tools. |
| `GET /api/drafts`, `POST /api/drafts` | List drafts; create one, blank or from `{adventureId}`. |
| `GET /api/drafts/:id`, `PUT /api/drafts/:id`, `DELETE /api/drafts/:id` | A draft with its problems and chat; replace it from `{draft, expectedRevision}`, refused with `STALE_REVISION` if it changed since. |
| `POST /api/drafts/:id/publish` | Create the world from `{worldId, expectedRevision}`; a retry after a failure resumes. |
| `POST /api/drafts/:id/assistant` | Run the AI creator on `{message, model?, expectedRevision}`, streamed as one JSON event per line. Other writes to the draft get `DRAFT_BUSY` until it finishes. |
| `GET /api/creator` | The AI creator's default model, and whether a key is set. |

The server runs at most one run per world, and a CLI `step` or `run` on the same
world fails with `WORLD_BUSY` while it does, through the same scheduler lease.

## Director CLI

```sh
npm run director -- <command> [--world ID] [--schema NAME] [--model ID]
```

| Command | What it does |
|---|---|
| `init` | Create the starter adventure, *The Dry Aqueduct*, or resume it. |
| `step` | Run exactly one turn, plus any narration it needs. |
| `cue CHARACTER` | Run one turn by that character or NPC, instead of the scheduler's choice, even if muted. |
| `mute [CHARACTER...]` | Stop the scheduler choosing them, until unmuted. With no names, list who is muted. |
| `unmute CHARACTER...` | Let the scheduler choose them again; `unmute --all` for everyone. |
| `steer TEXT [--to CHARACTER]` | Ask everyone, or one character, to reconsider, outside the story. Each sees it in its next prompt only; it changes nothing in the world. |
| `enter CHARACTER --at PLACE [--text TEXT]` | Bring someone away from the scene into it, at a place; `--text` says how it looks. |
| `exit CHARACTER [--text TEXT]` | Send someone in the scene away from it. |
| `run --turns N` | Run up to N turns. `--max-calls N`, `--max-tokens N`, and `--max-cost CREDITS` cap spending. |
| `show` | Admin view of the world: ruling limits, places, exits, characters and NPCs, challenges with numbers and the threats they arm or disarm, and every threat's status and timing. |
| `transcript [--last N]` | Admin transcript, including dice rolls. |
| `view CHARACTER` | Exactly what that character's (or NPC's) agent is sent: system prompt and turn prompt. |
| `memory CHARACTER [--search TEXT]` | Their goals and commitments, beliefs with the earlier beliefs they superseded, and private discoveries. `--search` runs full-text search over only the events they perceived, with snippets. |
| `traces [--last N] [--full]` | Recent model calls with task, outcome, tokens, cost, and latency; `--full` adds prompts and replies. |
| `report` | Session metrics: turns per actor, turns to the first action, the longest run without an action, threats fired, steering requests, rulings, invalid-proposal rate, and cost and latency per turn. |
| `rehearse` | Play a scripted opening, with no model and every die showing 15, into its own world (`aqueduct-rehearsal`). |
| `models [TEXT]` | List OpenRouter models whose ID or name contains TEXT, with output support, prices, context, and reasoning efforts. Needs no key. |

Nothing runs on its own: turns happen only on `step` or `run`. A run stops at
its turn, model-call, token, or cost limit; after three consecutive failed
turns; or after eight consecutive character turns without an action (a stalled
debate that the nudge and the required action did not end; see *World
progression*), whichever comes first. Press Ctrl+C once to pause: no new call starts,
and a turn still being generated is cancelled before anything from it commits.
Press it again to quit at once. `show` and `transcript` reveal hidden numbers;
never paste them into an agent's context.

To direct the conversation yourself, mute characters and cue them as needed: a
muted character neither takes turns nor answers when spoken to, and `run` stops
with `all_muted` once every active character is muted. Mutes are kept in the
database and read before every turn, so they apply to a run already in
progress. They are director state, never events, so no agent sees them.

To push the group toward a different plan, `steer` it. Steering is recorded as
an event that nobody perceives: each character it names (or every main character,
without `--to`) sees it once, in a section of its next prompt marked as coming
from the director outside the story, and it drops out once that character has
taken a turn. It never reaches memory, search, the narrator, or the referee, and
it cannot make anything happen: the agent must still propose actions the engine
accepts.

Only one scheduler runs a world at a time. `step` and `run` hold a lease on the
world, renewed while they work and released when they stop; a second `step` or
`run` on the same world fails with `WORLD_BUSY`. If a scheduler crashes, its
lease expires after a minute.

`rehearse` exercises the whole pipeline without credentials: speaking to an NPC
who answers, a rumor noted as hearsay, a commitment, travel, speech-only turns,
a proposal the engine rejects and the agent revises, an open-ended attempt the
DM rules is an existing challenge, a check that unlocks a route, and narration
after each action. Follow it with `view mira --world aqueduct-rehearsal` to see
one character's context, `memory bram --world aqueduct-rehearsal` for one
character's memory, or `report --world aqueduct-rehearsal` for its metrics.

### Models

`step` and `run` call models through [OpenRouter](https://openrouter.ai). Set
`OPENROUTER_API_KEY` in `.env.local` or `.env`, or export it (see
[.env.example](./.env.example)). Characters and narrator default to
`~deepseek/deepseek-v4-flash-latest`, OpenRouter's alias for the latest DeepSeek V4 Flash.
Pick another model with `--model` for one command, or in the environment:

```sh
npm run director -- models deepseek
npm run director -- step --model ~deepseek/deepseek-flash-latest
```

| Variable | Default | Meaning |
|---|---|---|
| `DUNGEONS_MODEL` | `~deepseek/deepseek-v4-flash-latest` | Model for both roles. |
| `DUNGEONS_CHARACTER_MODEL`, `DUNGEONS_DM_MODEL` | `DUNGEONS_MODEL` | Model for one role. `--model` overrides both. |
| `DUNGEONS_REASONING_EFFORT` | `low` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `default` (the model's own). |
| `DUNGEONS_CHARACTER_EFFORT`, `DUNGEONS_DM_EFFORT` | `DUNGEONS_REASONING_EFFORT` | Effort for one role. |
| `DUNGEONS_MAX_OUTPUT_TOKENS` | `4096` | Output limit per call, reasoning included. |
| `DUNGEONS_CREATOR_MODEL` | `DUNGEONS_MODEL` | The AI creator's model in the web director. It must support tool calls. |
| `DUNGEONS_CREATOR_EFFORT` | `DUNGEONS_REASONING_EFFORT` | The AI creator's reasoning effort. |
| `DUNGEONS_CREATOR_MAX_TOKENS` | `16000` | The AI creator's output limit per call; writing a whole world needs more than a turn does. |

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
that serves a request may charge differently. OpenRouter reports what each call
actually cost, in credits, and traces record it; `--max-cost` stops a run once
its calls have cost that much. NPC turns and rulings use the DM's model.

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
2. The next actor is whoever the last turn's speech addressed, if they can
   answer and the speaker is still there to hear them, unless another
   character has already waited a full round. Otherwise
   an NPC whose agenda is due speaks up, and failing that the character who has
   waited longest acts, ties going to world order, which is round-robin when
   nobody is addressed. Incapacitated characters, those away from the scene,
   and those without a persona in the cast are skipped. The order comes from the event
   log, so it survives restarts.
3. The character's agent receives only its own perception (place, exits,
   people present and their visible condition, challenges with difficulty
   *bands*), its inventory, its memory (below), the 30 most recent events it
   perceived, numbered so it can cite them, and its legal actions with entity
   IDs.
4. It replies with optional speech (as long as the moment needs, up to about
   80 words), optionally addressed to one person present (`to`), an optional action, and optionally a belief to note and a goal to
   adopt or settle. These commit atomically under one request ID: speech, then
   the note and goal, then the action.
5. An invalid reply, or an action the engine rejects, goes back to the agent
   with the reason, up to two revisions. If the world changed meanwhile, the
   proposal is regenerated from fresh context. A turn that never validates is
   recorded as failed and commits nothing; the same character is asked again
   next time.
6. The DM narrates committed actions. Narration reaches exactly the characters
   who perceived those actions, and the narrator sees earlier events only if
   every one of those characters perceived them too. It covers only what the
   acting character perceived, so an arrival that a threat causes elsewhere
   during the turn is left to the threat's own text. A run that reaches an
   ending retries the ending's narration if the narrator fails, before it
   stops.

**NPCs** (characters with `npc: true`, such as Old Tamsin in the starter
adventure) are voiced by the DM model from a persona in the cast. An NPC acts
when the last turn's speech addressed it, or when its agenda comes due (below):
it must speak, and it may walk along an open exit or, instead, leave the scene
(`leave`) when it really would go, coming back only if something brings it.
NPC turns are never narrated, and an NPC without a persona never speaks. An NPC
is told about attempts that failed in front of it since it last spoke, so it
does not hand over in its own words what someone just failed to get from it.

**Entrances and exits.** Anyone, main characters included, can be away from
the scene: they keep their last place but take no turns, cannot be addressed,
handed anything, or hurt, and perceive nothing. A world may start someone
away. A threat can bring characters in, each at a place, and send characters
away when it fires. A referee's ruling on an open-ended attempt brings in
someone away (`bringsIn`, arriving where the actor is) or sends off a
supporting character there (`sendsOut`) if the attempt works: always for an
automatic ruling, and for a new check only on success. The director can do
either at any time. An entrance is seen by those at the place and the one
arriving; an exit by those at the place and the one leaving. Characters
remember where each went.

**Open-ended attempts.** In a world with ruling limits, a character may
`attempt` something no listed action covers, described in a short phrase. The
DM, as referee, rules that the attempt is an existing challenge here, a new
check (an allowed ability, a difficulty band, failure damage, and minutes, all
within the world's limits), automatic (it simply takes time), or impossible
(the character is told why and tries again). The engine validates the ruling
and commits it, with any new check's definition, before it rolls. A new check
only succeeds or fails: it cannot unlock routes or grant items. The referee
also sees the challenges in other places, by name and description only, so
that it can point the way: an attempt that belongs elsewhere is ruled
impossible here, with a reason that names the place.

**Memory.** Everything a character remembers derives from events delivered to
it, so its memory can hold only what it was permitted to perceive.

- *Private discoveries.* A challenge may reveal a fact on success
  (`onSuccess.reveals`). Everyone present sees the check succeed; only the
  character who made it perceives the discovery.
- *Beliefs.* A character may note a belief about one person, place, item, or
  challenge (`about`, `attribute`, `value`, `confidence`), citing up to five
  events it perceived as evidence. The engine checks every citation and derives
  the source from it: someone else's words, narration, or a referee's reason
  make it `reported` (hearsay), even beside firsthand evidence, so a rumor cannot
  be laundered; other perceived events make it `inferred`; no evidence makes it
  `speculation`. The engine also records observations from engine facts:
  where speakers and movers are, who holds an item, whether a challenge is done,
  and which ways opened.
- *Supersession.* A belief's current value is the one resting on the newest
  evidence, so a fresh observation replaces an older rumor, and a note citing
  stale evidence never overrides what was seen since. Superseded beliefs are
  kept as history.
- *Goals and commitments.* Adopting, fulfilling, and abandoning one are events
  only its holder perceives; open ones appear in its context with their IDs.
- *Recall.* Events older than the recent window come back when relevant:
  PostgreSQL full-text search over the character's own perceived events, for
  the people, place, challenges, and items in front of it and the words just
  said to it, ranked by relevance, salience (discoveries, questions put to it,
  failed attempts at open challenges), and recency. The search joins on the
  character's deliveries inside the query, so nothing it did not perceive can
  rank or reach a snippet.

Notes and goals are thoughts, so they never count as acting. NPCs get the same
scoped recall and beliefs. The narrator and the referee never see private
events, because what they write reaches everyone present.

**World progression.** The world moves whether or not the characters do.

- *Timed threats.* A world may define threats (`threats`): text, the places they
  strike (or everywhere), damage, and routes they block or open. An `armed`
  threat fires once the in-world clock reaches its `at`, earliest first. It
  strikes the conscious characters where it falls; only they perceive it, and
  everyone else learns of it only by being told. Waiting and travel stop at the
  first threat due before they would finish: a wait is shortened, and a journey
  halts partway, leaving the traveller where it set out. A threat that fires
  after a turn's speech ends the turn, so whatever the character meant to do
  next does not happen; a check already under way completes first. The starter
  adventure's sluice floods the channel at 0:50:00.
- *Consequences.* A challenge may arm `waiting` threats on failure or success
  (`onFailure.armThreats`, `onSuccess.armThreats`), firing `delaySeconds` later,
  and may disarm pending ones on success (`onSuccess.disarmThreats`). A failure
  may also block routes (`onFailure.lockRoutes`). Arming and disarming are
  hidden events that nobody perceives; a consequence is felt only when it
  fires. In the starter adventure, a botched pull at the rubble brings the
  ceiling down five minutes later unless someone clears the rubble properly
  first.
- *NPC agendas.* An NPC persona may have an `agenda`: aims to pursue and an
  interval in minutes. Once that much in-world time has passed since its last
  turn and a main character is there to hear, it speaks up unprompted, pursuing
  one of its aims. It never takes two turns running. Old Tamsin speaks up about
  every 15 minutes, warning of the sluice or trading for news.
- *Stalled debate.* After 3 character turns in a row with no action, prompts say
  the group is going in circles and ask for a materially different approach,
  with its cost or risk. After 5, the next turn must include an action: a reply
  with only speech is rejected and sent back. The run stops after 8. Any action,
  waiting included, resets the count; notes, goals, and NPC turns do not.

Replay checks all of it: a history in which a threat fires early, late, out of
order, or with the wrong damage, a wait or a journey runs past a threat, or a
consequence lacks the check that caused it, is rejected as corrupt.

Every model call is traced: role, task (character turn, NPC turn, ruling, or
narration), model, prompt version, the context sent, the raw reply, outcome,
tokens, cost, and latency. Turn request IDs derive from the world
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

A character command carries `speech`, `action`, or both, plus an optional
`addresseeId` for the speech, and optionally a `note` (a belief citing evidence)
and a `goal` (adopt one, or settle one by ID). An `attempt` action carries the
DM's `ruling`. An
NPC command (`role: "npc"`) carries `speech`, `destinationId`, or both, or
`speech` with `leave: true`. A DM
command narrates committed actions: `{ role: "dm", requestId, expectedRevision,
action: { type: "narrate", aboutSequences: [12], text } }`. A director command
steers: `{ role: "director", requestId, expectedRevision, action: { type:
"steer", text, targetId } }`, with `targetId` optional. Other director actions
are `introduce`, `retcon`, `enter` (`characterId`, `locationId`, optional
`text`), and `exit` (`characterId`, optional `text`).

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
| `getPerceivedEvents(worldId, characterId, limit, { types, exclude })` | The most recent events that character perceived, oldest first, optionally only or never of some event types. |
| `searchMemories(worldId, characterId, query, { before, limit })` | Full-text search over the events that character perceived (not its notes and goals), best first, with snippets. |
| `getPerceivers(worldId, sequence)` | Who perceived one event. |
| `replayWorld(worldId)` | State rebuilt from events, after checking it and every event's perceivers against storage. |
| `recordTrace`, `getTraces` | Model-call traces. |
| `acquireLease`, `releaseLease` | The world's scheduler lease. |
| `getMuted`, `setMuted` | Characters the director has muted. |

For what a character can currently perceive and do, use `perceive` and
`availableActions` from [src/perception.ts](./src/perception.ts).

### Actions and world rules

| Action | Rules |
|---|---|
| `move` | Follow an outgoing, unlocked route; its definition determines elapsed time. A threat due on the way halts the journey where it set out. |
| `transfer_item` | Positive integer quantity, owned items, a different recipient in the same location and in the scene. Takes no time. |
| `attempt_check` | An unresolved challenge in the actor's location, carrying any required item, with an optional `approach`. With dice, the engine rolls d20 and uses the world's difficulty, ability modifier, time, and failure damage. With judgment, the command carries the referee's `judgment` (`success` and a `reason`), and the engine applies the world's time and declared effects. |
| `attempt` | Free-text intent, resolved by the DM's ruling within the world's `rulings` limits. Only available when the world defines them. |
| `wait` | Advance in-world time by 1 to 3600 seconds, stopping early at a threat. |

Speech costs the world's `speechSeconds` (10 in the bundled adventures), so long
debates let time pass. Checks succeed when `d20 + modifier >= difficulty`, with
no natural-1/20 overrides. A successful check can unlock routes, grant items,
reveal a private fact, and arm or disarm threats, as its world definition says;
a failed one can block routes and arm threats. Failed checks stay available, with their normal
time and damage costs. Zero-HP characters cannot act and perceive nothing.
Routes are directional.

A world's optional `rules` choose `outcomes` (`dice` or `judgment`), `stats`
(display names for the three abilities, or `null` for none, which makes every
modifier 0), and `health` (a display name, or `null` for none, in which case
nothing deals damage and everyone stays at full health). A world without
`rules` plays as before: dice, Strength, Dexterity, Wisdom, and HP. In a
judgment world, an attempt at a listed challenge or a ruled open attempt must
carry the referee's judgment, and a dice world refuses one. The referee reads a
challenge's `criteria`, which never appear in a character's or the narrator's
prompt. It also hears what the character says in the same turn as the
attempt, and weighs those words with the approach. Replay checks the dice arithmetic in dice worlds, and a reason without
dice in judgment worlds.

A world's optional `endings` each wait on a challenge's success or failure, or
on a threat. When one is met, the engine appends `story_ended` after the
outcome, perceived by everyone conscious. A threat that came due while the
action took its time fires before that ending, since it happened first, and
its own ending wins if it has one. From then on only narration and retcons
commit, and threats still due never fire; replay accepts an ending only
directly after its cause (past any entrances and exits the same threat caused).

A character with `away: true` is away from the scene. `character_entered` and
`character_exited` events change that, at no cost in time. Their source says
who caused them, and replay checks the cause: the director's need none; the
engine's must follow the threat or ruling that names them (for a ruled check,
its success); the DM's are an NPC leaving, straight after its own words.

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
  history; migration 5 adds the full-text index used for recall. An app refuses
  a database migrated by a newer version.
- Database triggers reject ordinary SQL UPDATE, DELETE, and TRUNCATE on events,
  perceivers, and receipts. A database owner can still disable triggers or drop
  tables: this is not tamper-proof storage.
- `createWorld` resumes an existing world only if its original seed matches. The
  sample world matches upcast Phase 1 copies, so they keep resuming.
- Traces are diagnostic records, not canonical history.
- Migration 6 adds `adventure_setups`: each world's saved personas and models.
  It is director state beside the world, like mutes, never events.
- A retcon is a `retraction` event; the retracted event stays in the log, and
  queries for an agent's view leave it out. A branch copies a world's events up
  to the chosen point into a new world, replays and validates them, and copies
  their perceivers, the retry receipts of the turns it includes, and the saved
  setup.

Use a separate migration role and restricted runtime role before deploying a
shared production service.

## Tests

```sh
npm run typecheck
npm test
```

Pure tests always run: rules, rulings, NPC commands, perception, upcasting, the
agent protocol, speaker selection, metrics, memory (discoveries, belief sources,
supersession, goals, recall ranking), world progression (threat timing and
interruption, consequences, replay forgery, steering, agendas, the stall
ladder), director events (introduced events and their routes, retcons and their
replay), the OpenRouter adapter against a simulated API, prompt canaries (the
premise reaches every system prompt; a hidden fact never reaches the main
characters; a challenge's criteria reach only the referee; non-fantasy worlds
show no HP, party, or adventure), judged checks and their replay, worlds without
stats or health, endings and what may follow them (a threat due during the
action comes first), every bundled story's
validity,
and the world creator: its operations, cascading removal, refusals, draft
problems, that its code reaches nothing from Node (the browser runs it), its
tool schemas, and the AI creator's loop against a simulated OpenRouter, with
its limits and cancellation.
Integration tests require `TEST_DATABASE_URL` and are skipped
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
  append-only protection, pagination, corrupt snapshots, and scheduler leases.
- **Migrations:** Phase 1 databases upgrade in place and keep playing; a failed
  migration rolls back completely; reruns and concurrent runs are safe; newer
  databases are refused.
- **Turn runner:** the scripted rehearsal end to end; context isolation with
  canary phrases; rejected and invalid proposals with feedback; provider
  failures; turn, call, token, and stall limits; owed narration after an
  interruption; speaker rotation across restarts; stale proposals; duplicate
  turns; direct address and its fairness cap; NPC replies and moves; rulings
  that commit before the roll; pausing mid-generation; the scheduler lease;
  cost limits; and in judgment worlds, attempts sent to the referee with their
  approach and the words said with it, open attempts ruled and judged in one
  call, a supporting character told of an attempt that just failed to get
  something from it, conversation pace that never forces an action, a run
  that stops when the story ends (retrying the ending's narration if the
  narrator fails), and narration that leaves out an arrival elsewhere.
- **Memory:** a non-witness cannot retrieve a private discovery, by search or
  in a snippet; camp talk never reaches the cistern; notes may cite only events
  their writer perceived; recall brings back an early discovery after the
  transcript window drops it, for characters and NPCs alike; and save/resume
  preserves search results, beliefs, prompts, and perceivers.
- **Progression:** steering reaches only the characters it names, once, is never
  perceived or searchable, and cannot open a locked way; a stalled debate is
  nudged, then must act, and a run that still stalls stops; an NPC with an
  agenda speaks up once time has passed; and a threat that strikes mid-run
  reaches only those it hits, is never narrated, and replays exactly.
- **Entrances and exits:** the director, a threat, a working ruling, and an NPC
  leaving on its turn each stage someone, seen only where it happens; someone
  away cannot act, be addressed, receive items, or be hurt, and the scheduler
  and cues pass them over; replay refuses an entrance or exit without its
  cause; the referee sees who is away and the challenges elsewhere, never their
  criteria; and the creator's away toggle, threat entrances, and their checks.
- **Web director:** it refuses foreign host names and cross-site or non-JSON
  writes; creates worlds from adventures and seeds; validates and saves setups;
  streams committed events and resumes after the last one received; introduced
  events reach only the characters present, and steering stays out of memory;
  a retcon hides the original from those who heard it and corrects them; step,
  run, cue, pause, and `WORLD_BUSY`; the scripted opening, only on a new Dry
  Aqueduct world, which the world view reports as `rehearsable`; a step that
  ends the story, after which steering is refused; branching, only where a turn ends, with history and setup;
  and serving the built interface without exposing other files.
- **Google sign-in:** against a simulated Google, an allowed account signs in
  (PKCE, the right redirect URI) and can use the director; an account off the
  list or with an unverified email is turned away; removing an email takes
  effect at the next request; sign-in posts need Auth.js's CSRF token; a session
  sealed with another secret, or none, gets 401, the event stream included;
  signing out clears the cookie; and the server refuses to start with half the
  settings, beyond this machine without https, or on the wrong port.
- **Drafts:** saved only at the revision last seen; publishing creates a
  playable world with its cast, and resumes after failing partway; the AI
  creator streams its work, saves each round and its chat, keeps partial work
  when the browser leaves, blocks other writes while it works, and can be undone
  at the revision it produced, but not after a later change.
