# Multi-agent adventure program

## Status

- **Phase 1 (persistent engine): complete.** Verified 2026-10-28: typecheck, unit
  tests, and PostgreSQL integration tests pass on local PostgreSQL 16.
- **Phase 2a (turn pipeline): complete.** Verified 2026-10-28: typecheck and all
  81 tests (unit and PostgreSQL integration) pass on local PostgreSQL 16, and a
  database written by the Phase 1 code upgrades in place. Agents call models
  through OpenRouter, tested against a simulated API; no live-model session has
  run yet.
- **Phase 2b (ensemble): complete.** Verified 2026-10-28: typecheck and all 105
  tests (unit and PostgreSQL integration) pass on local PostgreSQL 16. Speaker
  selection by direct address with a fairness cap, NPCs voiced by the DM (Old
  Tamsin in the starter adventure), DM rulings committed before the roll within
  world limits, pause that cancels an uncommitted turn, a per-world scheduler
  lease, cost limits, director mutes and cues, and a `report` command. A
  12-turn live run on the starter adventure (`~deepseek/deepseek-pro-latest`,
  reasoning low) opened the bars and reached the channel with no failed turns:
  0% invalid proposals, an action on the first turn, 0.0019 credits and 16 s of
  model time per turn (0.0226 credits in all). Rulings were the slowest calls,
  averaging 17 s.
- **Phase 3 (personal memory): complete.** Verified 2026-10-28: typecheck and all
  116 tests (unit and PostgreSQL integration) pass on local PostgreSQL 16, and
  the scripted rehearsal replays with a hearsay note and a commitment. Private
  discoveries, evidence-checked beliefs whose source the engine derives
  (reported, inferred, speculation), observations that supersede stale beliefs
  with history kept, goals and commitments as events, scoped full-text recall
  for characters and NPCs, and a `memory` inspection command. No live-model run
  has used the memory features yet.
- **Phase 4 (world progression): complete.** Verified 2026-10-28: typecheck and
  all 133 tests (unit and PostgreSQL integration) pass on local PostgreSQL 16,
  and each new behavior was checked by breaking it and watching its test fail.
  Timed threats that stop travel and waiting, hidden delayed consequences of
  checks, NPC agendas, a stall ladder (nudge, then a required action, then a
  stop), and director steering that only its targets see, out of fiction. No
  live-model run has used the progression features yet.
- **Phase 5 (director UI): in progress.** The server side is complete. Verified
  2026-10-28: the server typechecks and all 145 tests (unit and PostgreSQL
  integration) pass on local PostgreSQL 16. That covers introduced events,
  retcons, branching, saved setups, the HTTP API with its live event stream and
  background runs, and the local-only guards. The React interface typechecks,
  builds, and was driven end to end in headless Chrome against local
  PostgreSQL, with no console errors. The run covered creating a world, the
  scripted opening streaming live, a character's filtered view, prompt and memory
  inspection, mute, steering, an introduced event, a retcon, a persona edit
  reaching the agent's prompt, model search, branching, and the phone layout.
  No live-model run has used the web director yet. Deployment with
  authentication comes after local testing.
- **UI overhaul (world creator, AI creator, premise, mobile): complete
  locally.** Verified 2026-10-29: both projects typecheck, the interface builds,
  and all 164 tests pass on local PostgreSQL 16. Worlds are made in a draft
  editor (story, places, characters, items, challenges, threats, review) whose
  operations are also the AI creator's tools; the AI creator is a panel dragged
  in from the side that edits the draft directly, with Undo per message. Every
  system prompt carries the world's premise. Headless Chrome drove it at
  1440 px and 390 px against local PostgreSQL and a simulated OpenRouter, with
  no console errors or sideways scrolling. That covered building a draft by
  asking, Undo, Stop keeping partial work, a refused tool call, the model
  picker, dragging the panel open and shut, hand editing, Undo after removing
  something, Review's Fix links, creating and opening the world, the premise and
  prompts in the Agents tab, dark mode, and the phone layouts with their sheets
  and Back closing them. No live-model session has used the AI creator yet.
- **Any genre (engine state, AI judgment, endings): complete locally.** Verified
  2026-10-29: both projects typecheck, the interface builds, and all 184 tests
  pass on local PostgreSQL 16. These include the 164 earlier tests, unchanged,
  so worlds without rules, the fantasy adventures, and the scripted opening play
  and replay as before. Each world now chooses how attempts are decided (dice,
  or a referee AI judging against each challenge's hidden "what it takes"),
  whether it has stats (three, under its own names) and health (under its own
  name), and its pace (action or conversation). A world may also have endings,
  set off by a challenge's success or failure, or by a threat. Judged outcomes
  are recorded with the referee's reason and replay without asking the model.
  An ended story takes only narration and retcons, and can be branched from
  before the end. Prompts no longer assume a fantasy party. Three new stories
  show the range: *The Night Market* (friendship and maybe more), *The 3 A.M.
  Outage* (two engineers and a failing system), and *Dinner at Ashcombe House*
  (a mystery with lying suspects). Headless Chrome drove the rules card, the
  hidden criteria, the Endings tab, Undo after turning stats off, and a
  scripted judged turn to an ending, at 1440 px and 390 px, with no console
  errors or sideways scrolling. No live-model run has used judgment yet.
- **Google sign-in: complete locally.** Verified 2026-10-29: both projects
  typecheck, the interface builds, and all 192 tests pass on local PostgreSQL
  16. Sign-in uses Auth.js (`@auth/core` 0.41.3, the version under Traveller's
  next-auth) with Traveller's variables, Google provider, JWT session cookie,
  and `ALLOWED_EMAILS`. Only allowed accounts can sign in, and each request
  checks the list again. With none of the variables set, the no-login,
  this-machine-only mode is unchanged. Tests sign in end to end against a
  simulated Google. Headless Chrome drove sign-in, use, sign-out, and a refused
  account choosing another, at 1440 px and 390 px, with no console errors; the
  earlier genre checks still pass without a login. Signing in with a real
  Google account is still to do.
- Development and tests use local PostgreSQL or a Neon development branch, not the
  `production` branch.

## Product direction

Build a director-mode adventure engine with AI characters, not an unrestricted
group chat. Agents control dialogue and intentions; the engine controls outcomes.
The director can pause, step, steer, or introduce explicit world events.

Start with three character agents, one DM agent, and a deterministic software
controller. Keep dialogue short, usually one to three sentences.

## Architecture and authority

- **Character agents:** dialogue, beliefs, goals, and typed action proposals.
  They cannot declare success or rewrite inventory and history.
- **DM agent:** narration of committed outcomes, NPC roleplay, encounters, and
  rulings on open-ended intentions, all through a typed vocabulary (below).
  Established facts cannot be silently overridden.
- **Rules engine:** prerequisites, dice, time, resources, validated outcomes, and
  atomic state changes.
- **Perception:** a pure function from canonical state to what one character can
  currently perceive and do. The admin snapshot is never sent to agents.
- **Memory service:** evidence-linked, character-scoped retrieval.
- **Director interface:** conversation, sheets, world state, private-memory
  inspection, timeline, and Run/Pause/Step/Steer/Introduce event controls.

Every event records its source: engine, character, DM, or director.

Use one TypeScript application initially, with React added when the UI phase
begins. Use an adapter for model providers and server-sent events for live updates.

### DM vocabulary and open-ended intentions

The DM acts only through typed proposals that the engine validates:

- `narrate`: describe committed events after they commit. Narration cannot
  create entities, items, exits, or consequences.
- `npc_say`, `npc_move`: speech and route-bound movement for NPCs (Phase 2b).
- `ruling`: adjudicate a character's open-ended intention (Phase 2b).

The action vocabulary is closed, so open-ended intentions ("persuade the guard",
"search the rubble") go through a ruling:

1. The character proposes an `attempt` with a short free-text intent.
2. The DM maps it to an existing challenge, or defines a new one from an ability,
   a difficulty band, and consequences within limits set by the world definition.
   It may also rule the intent impossible or automatic.
3. The engine validates the ruling against those limits and commits the challenge
   definition **before** rolling.
4. The engine rolls and applies the outcome.

No agent sees the roll before the ruling commits, and no agent can change
difficulty afterwards.

### Storage decision

Phase 1 uses **Neon-compatible PostgreSQL**, selected after considering SQLite.
PostgreSQL provides transactional DDL, row locks that serialize actions across
processes, append-only triggers, full-text search, and pgvector in one store.
Neon adds managed hosting and cheap branches for development. SQLite would be
simpler for a single-user tool and would make save files portable; portability
can come later from world export and import.

Read the connection string from `DATABASE_URL`; never commit credentials.
Local PostgreSQL is also supported for development and integration tests.
Use Neon-provided TLS connection settings without disabling certificate
verification. Full-text search and pgvector can be added in the memory phase.
Phase 1 does not require embeddings, an LLM, or model-provider API credentials.

### Persistence formats

Events are immutable, so formats evolve through versions, not edits:

- Each event carries a format version. Readers upcast older events to the current
  format before validating them.
- Schema changes run as numbered migrations, recorded in a migrations table,
  serialized by an advisory lock, and applied through the direct (unpooled) URL.
- Snapshots are derived data. A migration that changes the state format rebuilds
  them by replaying events.
- Retry receipts reference the events they produced. The original result is
  reconstructed by replay, not stored as a full snapshot per action.

## Memory model

1. **Canonical state:** current locations, health, resources, inventory, quest
   progress, NPC status, environmental changes, and active threats. Use exact
   queries, not similarity search, for current facts.
2. **Append-only events:** committed speech, actions, and outcomes; in-world time,
   actors, affected entities, perceivers, disclosures, and causal links.
3. **Personal recollections:** evidence-linked firsthand experiences or reports.
   Hearing about an event records the telling as the source, not direct access
   to the original event.
4. **Beliefs:** guesses and interpretations, separate from canonical truth. Key
   beliefs are structured (entity, attribute, value, confidence), so a newer
   observation supersedes them deterministically. Every belief cites evidence the
   character was permitted to perceive, or is marked as speculation.
5. **Goals and commitments:** what a character or the party intends or has agreed
   to, with status changes (adopted, abandoned, fulfilled) recorded as events.

Retrieve current observations, recent permitted dialogue, goals, commitments,
and a bounded set of relevant memories. Start with exact lookup, recency, and
PostgreSQL full-text search; add semantic retrieval only if the
transcript-truncation check shows recall gaps. Rank by relevance, recency,
salience, and unresolved consequences.

Knowledge permissions:

- Enforce permissions inside the query (character-scoped joins or row-level
  security), before ranking and before snippets. Never filter afterwards.
- Summaries are per character, built only from that character's permitted
  inputs. They keep source links and never replace the event record.
- NPCs voiced by the DM get the same scoped context as characters; the DM's
  omniscience must not leak into what an NPC knows.
- Context separates engine facts from quoted speech and narration, which may be
  mistaken or false.

## Turn loop and progression

1. If committed actions are awaiting narration, the DM narrates them first.
2. Select the next speaker using direct address, initiative, relevance, and
   participation balance. Phase 2a uses round-robin over conscious characters.
3. Build the character's authorized context: current perception, available
   actions with entity IDs, recent perceived events, persona, and goals.
4. Generate one short utterance and an optional typed action proposal, as
   separate fields. Speech is only words spoken aloud; it never narrates outcomes.
5. Validate and resolve the action. A rejected proposal goes back to the agent
   with the engine's reason, for a bounded number of revisions. Nothing commits
   until the turn is valid; a turn that stays invalid is recorded as failed.
6. Atomically commit the turn's events and state changes, together with the
   characters who perceived each event.
7. Check for scene progression or a stalled discussion.

Resolve actions serially in the MVP. In-world time advances through speech,
actions, travel, and explicit waiting, not through model latency. Each utterance
costs a world-defined number of seconds, so long debates let time pass. Timed
threats fire when the clock reaches them, and NPCs with agendas speak up as it
passes; weather is out of scope for now.

A proposal built on a stale revision is regenerated from fresh context, within
the same revision bound.

Detect repeated debate and invite a materially different approach with an
explicit tradeoff. Personal goals and risk tolerances support genuine
disagreement. Director steering can request radical alternatives but cannot
invent their success.

Phase 4 bounds a stall with a ladder over consecutive character turns that only
spoke: after 3, prompts ask for a materially different approach; after 5, the
next turn must include an action, and a speech-only reply is rejected and sent
back; the run stops after 8 as a backstop. An action of any kind, including
waiting, resets the count, and NPC turns neither add to it nor reset it.

## Reliability safeguards

Engine:

- Typed tool requests with stable entity IDs.
- Runtime validation of external input and persisted data.
- Deterministic prerequisites and state transitions; engine-owned dice behind an
  injectable source, so tests and scripted evaluations can fix outcomes.
- Atomic persistence of events, perceivers, state, and idempotency receipts.
- Expected revisions reject stale proposals; identical retries return the
  original result even after later turns.
- Narration uses committed outcomes.
- Explicit failures and uncertainty; no success-shaped fallbacks.
- Durable events reconstruct state and perceivers after restart.
- Memory permissions prevent private-scene leakage.

Model calls:

- Every call records a trace: role, model, prompt version, context sent, raw
  output, outcome, tokens, and latency.
- Timeouts, provider errors, refusals, truncated output, and invalid output each
  produce an explicit failed attempt. A run stops after a configurable number of
  consecutive failed turns.
- Each run has limits on turns, model calls, and tokens, and stops at the first
  one reached.
- Request IDs derive from the turn's revision and speaker, so a duplicated or
  resumed turn cannot commit twice.
- A per-world lease keeps two schedulers from running the same world (Phase 2b).
- Model and effort are configured per role.
- A scripted provider makes every scheduler test deterministic, with no network.

## Milestones

### Phase 1: persistent engine (complete)

Deliver canonical state, an append-only event log, action validation, dice
resolution, in-world time, and durable save/resume.

The initial rules-light action vocabulary is movement along defined routes,
co-located item transfer, attempts against predefined scene challenges, and
bounded waiting. This is a vertical slice, not a complete tabletop ruleset.
Challenge difficulty and consequences belong to world definitions, not agent
requests. A shared world snapshot is an internal engine/admin API, not a
character observation API.

Acceptance (met):
- Restart reconstructs identical state from events.
- Events and snapshots stay consistent across failed writes.
- Retried commands do not duplicate actions or reroll checks.
- Reusing a request ID for different input is rejected.
- Stale and invalid proposals leave no events or state changes.
- Persisted history rejects modification and deletion through ordinary SQL.
- Invalid/corrupt state fails explicitly.

### Phase 2a: turn pipeline

The full turn loop with the DM, deterministic under test.

- Versioned events and numbered migrations; Phase 1 data upgrades in place.
- Clock in seconds; speech as events with a world-defined time cost.
- Multi-event turns: speech and action commit atomically.
- World additions: descriptions, locked routes, challenge item requirements, and
  success effects (unlock a route, grant items).
- Perceivers recorded per event: conscious characters at the event's location.
- Pure perception and context building, with available actions and entity IDs.
- Provider adapter with a scripted provider and an OpenRouter provider: any
  OpenRouter model per role, defaulting to `~deepseek/deepseek-pro-latest`.
- Turn runner: round-robin speakers, DM narration, validation feedback with
  bounded revisions, stale-revision handling, failure and stall limits, budgets,
  and traces.
- Command-line director: create, step, run N turns, show state, transcript,
  per-character view, and traces.

Acceptance:
- A scripted session runs end to end, and replay reproduces its state and
  perceivers.
- Phase 1 databases migrate in place, and their events upcast.
- A character's context contains only what it perceives: no speech from other
  locations, no other characters' inventories, and no difficulty numbers
  (canary test).
- Speech and action commit together or not at all.
- A rejected action returns the engine's reason to the agent. After the revision
  limit the turn is recorded as failed and nothing commits.
- Provider errors, refusals, and invalid output are traced and counted; a run
  stops after the configured number of consecutive failed turns.
- A run stops at its turn, call, or token budget, and after the configured
  number of consecutive turns without an action.
- Narration reaches only characters who perceived the narrated events.
- Step runs exactly one turn; nothing runs without an explicit Step or Run.

### Phase 2b: ensemble

Three distinct characters with speaker selection by direct address and balance;
Run/Pause with in-flight semantics (pause prevents new turns; an in-flight turn
finishes its atomic commit or is cancelled before committing); a per-world
scheduler lease; NPC entities with `npc_say` and `npc_move`; and open-ended
intentions resolved through DM rulings.

Acceptance:
- No self-triggering loops; every turn traces back to a director Step or Run.
- Pausing during generation commits nothing from the cancelled turn.
- A second scheduler on the same world is refused.
- A ruling commits its challenge definition before the roll, with difficulty and
  consequences inside world-defined limits.
- A live-model run on the starter adventure reports invalid-proposal rate,
  turns to first decision, and cost and latency per turn.

### Phase 3: personal memory

Add witness/disclosure delivery, firsthand versus reported knowledge, evidence
links, recollections, structured beliefs, goals and commitments, scoped
retrieval, private discoveries (facts revealed only to their perceivers), and an
inspection view. Verify recall after transcript truncation and exclusion of
private information, including search snippets.

Acceptance:
- A non-witness cannot retrieve a private discovery, by search or snippet, and
  the narrator and referee never see one.
- A belief's source derives from its cited evidence; hearsay stays hearsay even
  beside firsthand evidence, and a citation of an unperceived event is refused.
- A newer observation supersedes a belief; older beliefs remain as history.
- An early discovery is recalled after it leaves the recent-event window.
- Replay and save/resume reproduce perceivers, beliefs, and search results.

### Phase 4: world progression

Add timed threats as world-defined triggers evaluated when the clock advances
(travel and waiting stop at the first trigger), NPC agendas, consequences,
stagnation detection, and explicit alternative-plan steering. A stalled debate
must lead to a committed decision or a meaningful consequence within a bounded
number of turns: neither endless debate nor agreement without action.

Acceptance:
- A threat fires once the clock reaches it, earliest first, striking only those
  where it falls; waiting and travel stop at it, and a threat that fires after a
  turn's speech ends that turn. Replay rejects any history that skips, moves,
  or alters a threat.
- A check's outcome can arm a waiting threat for later or disarm a pending one;
  the consequence is hidden, follows its check in the same turn, and is felt
  only when it fires.
- An NPC with an agenda speaks up when its interval has passed and a party
  member is present, never twice running.
- A stalled debate is nudged, then must act, and the run stops if it still
  stalls.
- Director steering reaches only its targets, once, in their next prompt; it is
  never perceived or searchable, and it cannot make an action succeed.

### Phase 5: director UI

Add the React interface and live updates from committed events. Introduced
events are in-world, so perceivers observe them. Steering is out of fiction: it
is recorded but never stored as character memory. Retcons use compensating
events; timeline branching forks a world at a chosen revision. The interface
binds to localhost or requires authentication, because it exposes private
memories.

Acceptance:
- The director can create a world from an adventure or a seed, write each
  agent's persona, choose models per role, and have the setup used by the next
  turn, in the web director and the CLI alike.
- The director can build a world in a draft editor, by hand or by asking the AI
  creator, whose tool calls are the editor's own operations; review what stops
  it being played; and create it. Each AI creator message can be undone unless
  the draft changed since, and stopping keeps what it did.
- Every AI call's system prompt carries the world's premise, and no secret
  reaches the main characters through it.
- A world chooses dice or AI judgment, stats and health (or none) under its own
  names, its pace, and optional endings. A judged outcome is recorded with its
  reason, applies only the effects the world declared, and replays without the
  model. A challenge's hidden criteria reach only the referee. After an ending,
  only narration and retcons commit.
- The interface works at phone width without sideways scrolling.
- Committed events reach every open browser within a second, in order, without
  gaps after a reconnect; the director sees everything, and a character's view
  shows only what that character perceived.
- An introduced event is perceived by the conscious characters where it
  happens, recalled like any other event, and may block or open a way; replay
  rejects one that names an unknown place or route.
- A retcon withdraws narration, speech, or an introduced event without route
  changes from the agents who perceived it, in transcripts and search, and
  tells them it is withdrawn; the admin log keeps the original. A retcon cannot
  undo state changes, nor apply twice.
- A branch at the end of any turn creates a new world with that history, its
  perceivers, its setup, and its retry receipts, which replays and plays on
  independently of the original.
- With no login, the server listens only on a loopback address and answers only
  local host names and same-site JSON writes; a deployed version requires
  authentication. With Google sign-in (Auth.js, as in Traveller), only accounts
  in `ALLOWED_EMAILS` can sign in, every API route but health and the session
  check requires one, and the server listens beyond this machine only with an
  https `AUTH_URL`.

## Evaluation adventure

Use a small scripted adventure with a private discovery, injury, transferred
item, false rumor, moving NPC, abandoned plan, and delayed consequence. Build it
incrementally; each check becomes testable in the phase shown.

| Check | Testable from |
|---|---|
| A character cannot use an item they gave away. | Phase 2a (item requirements) |
| A non-witness cannot retrieve a private discovery. | Phase 3 |
| A rumor remains hearsay. | Phase 3 |
| New observations supersede stale beliefs without erasing history. | Phase 3 |
| Save/resume preserves knowledge boundaries. | Phase 2a (perceivers); Phase 3 (memories) |
| Radical alternatives change the approach without inventing success. | Phase 2b (rulings); Phase 4 (steering) |
| A delayed consequence strikes later, unless averted. | Phase 4 |
| A stalled debate ends in an action or a stop, within bounded turns. | Phase 4 |

Knowledge checks use canary tokens: unique phrases planted in private content.
Deterministic tests assert that no non-witness context contains them; live-model
runs search all model output for them.

Live-model runs track invalid-proposal rate, leak rate, narration that
contradicts committed events, turns to decision, and cost and latency per turn.

## Out of scope for the initial slice

Full tabletop rules, voice, tactical maps, unrestricted browsing, large agent
populations, microservices, and dedicated planner/critic/historian agents.
