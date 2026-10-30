# Using Dungeons

This guide covers building a world, running it, and steering the story without
breaking it. For setup, the HTTP API, the CLI, and how the engine works inside,
see the [README](./README.md).

- [How it works](#how-it-works)
- [Your first story](#your-first-story)
- [Designing a world](#designing-a-world)
- [Running a story](#running-a-story)
- [Watching](#watching)
- [Directing](#directing)
- [The story editor](#the-story-editor)
- [Saving, sharing, and moving worlds](#saving-sharing-and-moving-worlds)
- [Recipes](#recipes)
- [When something goes wrong](#when-something-goes-wrong)

## How it works

Three kinds of AI take part, and none of them can change the world directly:

- **Characters** each have their own agent. A character sees only what it
  perceived, and on its turn it says something, proposes an action, or both. It
  can also note a belief or set itself a goal.
- **The game master** voices the supporting characters, rules on anything
  unusual a character tries, and narrates what happened. As **referee** it
  decides how an attempt turns out, in worlds that use AI judgment instead of
  dice.
- **The engine** is plain code. It checks every proposal against the world's
  rules and either commits it or sends it back with the reason. Moves, checks,
  items changing hands, threats, and endings happen only when the engine
  commits them.

**Only what the engine commits happened.** If the narrator writes that a door
opened but no check opened it, the door is still locked. Design with this in
mind: anything that matters to the plot should be a place, a way between places,
a challenge, an item, a threat, a track, or an ending. Prose alone doesn't
change the world.

Everything is kept as a numbered list of events. The engine never rewrites one:
an edit, a deletion, or a wipe is a new event, and the original stays in the
log. That is why you can always see, and undo, what the director did.

## Your first story

1. Open **Your worlds** and play a bundled story as it is. *The Dry Aqueduct*
   is the one to start with.
2. On a new Dry Aqueduct world, press **Scripted opening (free)**. It plays
   eight turns with no model, and every die shows 15. It shows the whole loop
   without spending credit.
3. To play with real models, set `OPENROUTER_API_KEY` (see the README), then
   press **Step** for one turn, or **Run** for several.
4. Open the **Characters** tab and press **Inspect** on someone. It shows
   exactly what that character's agent is sent, and what it remembers.

The bundled stories show different settings:

| Story | Outcomes | Stats and health | Pace |
|---|---|---|---|
| *The Dry Aqueduct*, *The Gate and the Ridge* | Dice | Strength, Dexterity, Wisdom; HP | Action |
| *The Night Market* | AI judgment | Charm, Wit, Empathy; no health | Conversation |
| *The 3 A.M. Outage* | AI judgment | None | Action |
| *Dinner at Ashcombe House* | AI judgment | None | Conversation |

Copy the closest one and change it. That is usually faster than starting blank.

## Designing a world

**Create** edits a draft, one section at a time. It saves as you type. You can
fill in the forms yourself, or ask the AI creator (drag in the **Creator** tab
from the right edge) for a whole world or one piece of one. It uses the same
operations as the forms, so you see each change, and you can undo each
message's changes.

In an empty draft, **Step by step** has the AI creator build the world in five
steps: story, places, characters, challenges (with threats and hidden tracks),
and endings. It stops after each one for your approval.

**Sample chats** give the AI creator real voices to work from. Under its
message box, add text exports of conversations, such as a group chat, a
Discord channel, or a script: up to 5 files and 800,000 characters in all,
which is months of a busy group chat. The default model can read all of that;
a model with a smaller context is refused with a message saying so. Then ask, for
example *"Base the friends on my group chat"* or *"Use how these two argue
for the couple"*. It takes how people talk, what they care about, and how they
get on. It bases characters on the real people only if you ask, and leaves out
phone numbers and addresses.

The files stay with the draft. They never go into the world or a download, but
they are sent to the creator's model whenever it reads them, so add only chats
you are happy to share with it. A long file is refused: trim it to the
conversations that show these people best.

### Story

- **Premise.** Every AI reads it, the characters included: the setting, genre,
  tone, and stakes. **Keep secrets and solutions out of it.** If the butler did
  it, the premise must not say so.
- **How the narrator writes.** Voice, tense, and length, for example *"Clipped
  and cold, present tense, two or three sentences."* A short, firm style keeps
  narration from retelling the whole scene.
- **Outcomes.** With **Dice**, the engine rolls a d20, adds the stat's
  modifier, and needs the challenge's difficulty or more to succeed. With **AI
  judgment**, the referee reads what the character does and says, and what the
  challenge takes, and decides. Use dice for games of chance and danger. Use
  judgment for anything won by persuasion, insight, or tact.
- **Stats and health.** Name them for the world (*Charm, Wit, Empathy*;
  *Composure*), or turn them off. Without health, nothing deals damage and
  nobody is taken out. At 0 health, a character can't act and perceives
  nothing.
- **Pace.** In **action** pace, after 3 turns of talk with no action, the group
  is told it is going in circles. After 5, the next turn must include an
  action. After 8, the run stops. In **conversation** pace, talk can carry the
  scene: the group is nudged after 6 turns and is never forced to act. Use
  conversation pace for dates, interviews, and mysteries.
- **In-world seconds one spoken line takes.** Long debates use up time, which
  matters once threats are on a clock.
- **Characters may try things no challenge covers.** Turn this on to let
  characters attempt anything. The referee rules each attempt within your
  limits: which stats it may test, the hardest check, the most damage a failure
  costs, and the longest an attempt takes. A ruled check only succeeds or
  fails; it can't open ways or give items. Only your challenges can, so keep
  everything the plot depends on in challenges.

### Places

Each place has a description and ways out, each taking a set number of minutes.
**Ways go one direction only**: a way from the Hall to the Cellar doesn't let
anyone come back unless you add the way back too. A way can start blocked; a
challenge, a threat, a track threshold, or the director opens it.

### Characters

- **Main characters** are each played by their own agent. **Supporting
  characters** are voiced by the game master, and speak when spoken to or when
  their agenda comes due.
- **Persona.** Write who they are, who they are to the others, how they speak,
  what they want, and how much risk they take (cautious, balanced, or bold).
  Concrete wants make better scenes than adjectives do: *"wants the money back
  before her sister finds out"* beats *"secretive"*.
- **Who they are to the others** goes into every AI's prompt as a who's-who
  list, so the characters know who they're talking to. Keep secrets out of it.
- **Supporting characters** also have what they know (which may be wrong) and
  what they want. An **agenda** (aims, and an interval in in-world minutes)
  makes them speak up unprompted, as Old Tamsin warns about the sluice.
- **At the start: Away** keeps someone out of the scene until a threat, the
  referee, or you bring them in.
- A character with no persona never takes a turn. Review warns you.

### Items

Items are things characters carry and hand to each other. An item matters only
if a challenge needs it. A key no lock needs is a prop, and Review says so.

### Challenges

Challenges are how anything gets done. Each sits at a place and has:

- **How hard it is**, as a difficulty band (Easy, Moderate, Hard, Very hard)
  and, with dice, the number to beat.
- **What it takes.** Only the referee reads it. Make it concrete: *"Succeeds
  if they mention the ledger and don't accuse her outright"* gives consistent
  rulings, while *"Hard to persuade"* leaves the referee guessing.
- **The stat it leans on**, the time it takes, any item it needs, and damage
  on failure.
- **On success**, it can open ways, give items, reveal a fact to whoever
  succeeded (a private discovery, which only they perceive), set off threats,
  stop threats, and move tracks.
- **On failure**, it can block ways, set off threats, and move tracks.
- **Locked**: nobody sees or can attempt it until a track threshold unlocks
  it.

A failed challenge stays open, so characters can try again and pay its time
and damage again. A challenge that succeeds is done.

### Threats

A threat is something that happens whether or not the characters act:

- **At a set time**: it fires when the in-world clock reaches it, like the
  sluice flooding the channel at 0:50:00.
- **After a challenge sets it off**: it fires a set delay after a challenge's
  outcome, or a track threshold, arms it. A challenge's success can also stop
  it first. For example, a botched pull brings the ceiling down five minutes
  later, unless someone clears the rubble properly first.

A threat strikes in the places you choose (or everywhere) and only the
conscious characters there perceive it. It can deal damage, block or open ways,
bring characters in, and send them away. Waiting and travel stop at the first
threat due, so a character can't sleep through one.

### Tracks

A track is a hidden number per character, such as trust, suspicion, or
courage. It runs from 0 to its maximum. Characters never see a track. The
narrator, the referee, and you do.

- Give each character who takes part a **starting value, below every
  threshold**. Characters without one are never affected.
- Challenges **move** tracks on success or failure. Moves add up across turns
  and stay within 0 and the maximum. In the forms, a challenge moves the track
  of whoever attempts it. To move someone else's, such as a suspect's nerve
  when a detective questions them, ask the AI creator, which can name whose
  value moves.
- Each **threshold** happens once per character, the first time their value
  reaches it. It can open or block ways, unlock a locked challenge, reveal a
  fact to that character alone (an insight), set off or stop threats, change
  their stats, and give the narrator and referee guidance from then on, such
  as *"Mira trusts Bram now; she tells him the truth when asked"*. An ending
  can wait on a threshold too.

Tracks suit slow changes: a confession that comes only after enough trust is
earned, or a suspect who cracks once suspicion is high enough. Review warns about
a track nobody has, a track nothing moves, and a threshold that does nothing.

### Endings

An ending has closing text, one to three sentences, and waits on a challenge's
success or failure, a threat, or anyone reaching a track threshold. When it is
met, the story ends: a banner shows the text, and nothing more happens. Worlds
don't need endings, but a story with one knows where it is going.

### Review

**Review** lists what stops the world being played (errors) and what would
improve it (warnings), each with a link to where you fix it. The usual
warnings:

| Warning | What it means |
|---|---|
| No agent plays a character | No persona, so they never take a turn. |
| A character starts away and nothing brings them in | Only the referee or the director can. |
| A challenge doesn't say what it takes | The referee will guess. |
| Nothing sets off a threat | It never happens. Give it a time, or choose it under a challenge or threshold. |
| A locked challenge that no threshold unlocks | Nobody can ever attempt it. |
| A challenge gives an item no challenge needs | Having it changes nothing. |
| A track nobody has, or nothing moves | It never changes. |
| A threshold does nothing | Give it guidance or an effect, or end the story there. |

**Create world** makes the draft playable. A draft that became a world no
longer changes; copy it to make another version. Removing something removes
every reference to it, with Undo.

## Running a story

Nothing runs on its own. Turns happen only when you ask:

| Control | What it does |
|---|---|
| **Step** | One turn by whoever the scheduler picks, plus its narration. |
| **Run** | Several turns, stopping at the first of your limits: turns, model calls, or credits. |
| **Cue** (Characters tab) | Give one character the next turn, even if muted. |
| **Mute** / **Unmute** | Stop the scheduler choosing someone until unmuted. A muted character doesn't answer when spoken to. |
| **Pause** | Stop a run. A turn still being written is dropped, and nothing from it commits. |

**Who speaks next.** The person just spoken to answers, if they can, unless
someone else has waited a full round. Otherwise a supporting character whose
agenda is due speaks up, and failing that whoever has waited longest. Characters
who are away, out of health, muted, or without a persona are skipped.

A run also stops after three failed turns in a row, when everyone is muted,
when nobody can act, after 8 turns of talk without action (action pace only), or
at an ending.

**Cost.** Every turn makes model calls, and each one costs OpenRouter credits.
Set a credit limit on Run while you are trying a world out. The **Report** tab
shows turns, actions, rulings, and cost per turn, and **Model calls** shows
every prompt and reply with its cost. Pick the models, and each role's
reasoning effort, under **Agents**.

## Watching

The feed shows committed events as they happen, each with its number, its time
in the story, and who perceived it. Tags mark what is special:

| Tag | Meaning |
|---|---|
| private | Only one character perceived it: a discovery, an insight, a note, or a goal. |
| hidden | Nobody perceived it: a threat set in motion or stopped, or a track moving. |
| out of story | Your steering. |
| edited, deleted, retconned, wiped | What you did to the line since. |

**Show hidden.** Characters' notes and goals, and the hidden lines, are left
out of the feed until you tick **Show hidden** above it; the count beside it
says how many there are. Turn it on to see what each character is thinking, or
why a threat fired. The choice is remembered in this browser.

**Show: what a character perceived** switches the feed to one character's
point of view: only what they perceived, as they remember it, with your edits.
Use it to check that a secret stayed secret.

The side panel has:

- **Characters**: sheets, with Inspect, Cue, Mute, and Bring in or Send away.
  Inspect shows the agent's system prompt, its turn prompt, its goals, beliefs,
  and discoveries, and a search over everything it perceived.
- **World**: the true state, including blocked ways, challenges with what they
  take, threats and when they fire, tracks and who stands where, and endings.
  It also has the downloads.
- **Agents**: personas, premise, pace, models, and the narrator's and referee's
  prompts. Changes apply from the next turn.
- **Report** and **Model calls**: metrics and every model call.

## Directing

Use the lightest touch that works. The director's tools, from lightest to
heaviest:

| Tool | Where | What happens | Use it when |
|---|---|---|---|
| **Steer** | Box under the feed | Everyone, or one character, reads your note once in their next prompt, marked as coming from outside the story. Nothing in the world changes, and nobody remembers it. | The group is stuck on a plan, or someone is out of character. |
| **Introduce an event** | Box under the feed | Something happens in the story, where you say or everywhere, perceived and remembered by those there. It can block or open a way. | The scene needs a push: a phone rings, a storm starts, a door slams shut. |
| **Bring in** / **Send away** | Characters tab | Someone enters at a place you choose, or leaves the scene, with optional words for how it looks. | A character's entrance is due, or someone is crowding the scene. |
| **Edit** a line | Pencil on the line | Those who heard it remember your words instead. Nobody is told. | A line is nearly right: a wrong name, a tone slip. Narration, speech, and introduced events only. |
| **Delete** a line | Bin on the line | Those who heard it forget it, and notes resting only on it go too. Optionally, tell them what really happened, which reaches them as a correction. | A line shouldn't have happened, and nothing depends on it. |
| **Wipe from here** | Eraser on the line | The world goes back to before that line's turn, and everything after it leaves every agent's memory. Your edits of earlier lines stay. | The story went wrong and later events depend on the mistake. |
| **Branch** | Branch icon on the last line of a turn | A new world with the history up to there. This world stays as it is. | You want to try another course and keep this one. |

On a phone, a line's actions are in its **…** menu. Some things to know:

- **Edits and deletions can't undo a change in the world.** Deleting the line
  where someone walked into the cellar doesn't bring them back upstairs. Wipe
  from before it instead.
- **You can delete a character's note, or the latest change to one of their
  goals.** They forget it: an adopted goal is dropped, and a fulfilled or
  abandoned one is pursued again.
- **A wipe starts at the first line of a turn.** Wiping from any line wipes
  from the start of its turn, and the confirmation says how many lines go. The
  wiped lines stay in the feed, faded. Branch from one to get that timeline
  back as a new world.
- **After an ending**, only narration, edits, deletions, and wipes are allowed.
  Wipe back to before the ending, or branch from an earlier turn, to play on.
- **Steering can't make anything happen.** A character told to open the door
  still has to succeed at the challenge.
- **Wipes, and the story editor's changes, wait for the world to be idle.**
  Pause a run first.

## The story editor

The **Editor** button in a world's header opens an AI that reads the story so
far and says what's working and what isn't, citing lines by number. It
proposes changes as a checklist and changes nothing until you approve: untick
what you don't want, add a note, and press **Make N changes**.

It can rewrite personas, the premise, the narrator's style, and the pace;
steer; introduce events; bring characters in or send them away; and edit or
delete lines. Places, challenges, items, and endings are fixed once a world is
playing, so for those it tells you what to change in the design instead. It
works only on a world that isn't running.

## Saving, sharing, and moving worlds

The **World** tab downloads a world as a file:

- **Design**: the world as written, with its cast and models, and no play
  history. Use it to share a world, or to edit it as a new draft.
- **Full save**: every event, the setup, and mutes, including the characters'
  private memories. Use it to move a world, for example from your machine to
  the deployed site.

**Import** on Your worlds opens either kind: a design becomes a new draft, and
a full save becomes a new world. A full save is replayed and checked first, so
an edited or damaged history is refused. Downloads leave out model-call traces
and the AI chats.

## Recipes

**A locked door and a key.** Block the way from the Hall to the Study. Make an
item, the Brass Key, that a challenge in the Garden gives on success. Make a
challenge at the Hall door that needs the key and opens the way on success.

**A ticking clock.** Give a threat a set time, such as 0:40:00, with text and
damage, in the places it strikes. Characters learn of it only when it fires,
unless someone warns them. Give a supporting character an agenda to hint at it.

**A hidden consequence.** On a challenge's failure, set off a threat that
waits a few minutes and then strikes. On another challenge's success, stop it.
Clever players fix the mistake before it bites.

**A secret only one character learns.** Put the fact in a challenge's
*reveals*. Only whoever succeeds perceives it, and the others must be told, so
it surfaces as a conversation.

**Trust earned slowly.** Add a track, Trust (how far the host trusts each
guest), from 0 to 10, and give each main character a starting value of 0. Make
challenges, such as asking the right question or keeping a confidence, that
raise Trust on success and lower it on failure; each moves the Trust of whoever
attempts it. At 4, give the narrator and referee guidance (*"the host answers
this guest honestly now"*). At 8, unlock a locked challenge, *Ask for the
truth*, whose success ends the story.

**A pure conversation.** Use AI judgment, no stats, no health, and
conversation pace. Put what each person wants and hides in their persona, and
what would make them open up in the challenges' *what it takes*.

## When something goes wrong

| Problem | Try |
|---|---|
| They talk and never act | Use action pace. Steer toward a concrete step. Introduce an event that forces a choice. Make sure there is a challenge where they are. |
| Someone never takes a turn | Check for a persona, a mute, 0 health, or being away (the Characters tab tags each). |
| The referee rules inconsistently | Write what each challenge takes, concretely. Turn on open attempts only with tight limits. |
| A character knows something they shouldn't | Check the premise and the who's-who line: every AI reads both. Then switch the feed to that character to see what they perceived. |
| The narrator says too much | Tighten **How the narrator writes**, or ask the story editor. |
| A threat never fires | Nothing sets it off: give it a time, or choose it under a challenge or threshold. Check it isn't already stopped (World tab). |
| The story ended too soon | Wipe from the line before the ending, or branch from an earlier turn. |
| Step and Run are disabled | No OpenRouter key is set on the server. |
| `WORLD_BUSY` | A run, here or in the CLI, or the story editor, is working on the world. Pause it, or wait. |
| A turn keeps failing | Open **Model calls** to see the reply and why it was refused. Try another model under **Agents**. |
| The feed seems to be missing lines | Tick **Show hidden** to see notes, goals, and hidden lines. |
