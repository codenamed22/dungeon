# Multi-agent adventure program

## Status

- **Phase 1 (persistent engine): complete.** Verified 2026-10-28: typecheck, unit
  tests, and PostgreSQL integration tests pass on local PostgreSQL 16.
- **Phase 2a (turn pipeline): complete.** Verified 2026-10-28: typecheck and all
  81 tests (unit and PostgreSQL integration) pass on local PostgreSQL 16, and a
  database written by the Phase 1 code upgrades in place. Agents call models
  through OpenRouter, tested against a simulated API; no live-model session has
  run yet.
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
threats, weather, and NPC activity will consume this clock in a later phase.

A proposal built on a stale revision is regenerated from fresh context, within
the same revision bound.

Detect repeated debate and invite a materially different approach with an
explicit tradeoff. Personal goals and risk tolerances support genuine
disagreement. Director steering can request radical alternatives but cannot
invent their success.

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

### Phase 4: world progression

Add timed threats as world-defined triggers evaluated when the clock advances
(travel and waiting stop at the first trigger), NPC agendas, consequences,
stagnation detection, and explicit alternative-plan steering. A stalled debate
must lead to a committed decision or a meaningful consequence within a bounded
number of turns: neither endless debate nor agreement without action.

### Phase 5: director UI

Add the React interface and live updates from committed events. Introduced
events are in-world, so perceivers observe them. Steering is out of fiction: it
is recorded but never stored as character memory. Retcons use compensating
events; timeline branching forks a world at a chosen revision. The interface
binds to localhost or requires authentication, because it exposes private
memories.

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

Knowledge checks use canary tokens: unique phrases planted in private content.
Deterministic tests assert that no non-witness context contains them; live-model
runs search all model output for them.

Live-model runs track invalid-proposal rate, leak rate, narration that
contradicts committed events, turns to decision, and cost and latency per turn.

## Out of scope for the initial slice

Full tabletop rules, voice, tactical maps, unrestricted browsing, large agent
populations, microservices, and dedicated planner/critic/historian agents.
