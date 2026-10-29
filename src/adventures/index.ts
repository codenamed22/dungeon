import type { Cast } from "../agents/prompts.ts";
import type { WorldSeed, WorldState } from "../model.ts";
import { sampleWorld } from "../sample-world.ts";
import { ashcombeCast, ashcombeWorld } from "./ashcombe.ts";
import { nightMarketCast, nightMarketWorld } from "./night-market.ts";
import { outageCast, outageWorld } from "./outage.ts";
import { starterCast, starterWorld } from "./starter.ts";

/** A bundled adventure the director can start a world from. */
export interface Adventure {
  id: string;
  name: string;
  summary: string;
  world(id: string): WorldSeed;
  cast: Cast;
}

const ridgeCast: Cast = {
  premise: "A windswept frontier of old stone. Three companions reach the outer gate of an abandoned watch post, with a "
    + "bare ridge beyond, looking for the way into a buried aqueduct. A practical adventure of traps, weather, and the land itself.",
  narratorStyle: "Plain and brisk, present tense.",
  characters: {
    mira: { summary: "A quick scout.", knownAs: "the party's scout", voice: "Brief and wry.", goals: ["Find the way into the aqueduct"], riskTolerance: "bold" },
    bram: { summary: "A steady guard.", knownAs: "the party's guard", voice: "Slow and plain.", goals: ["Keep the others safe"], riskTolerance: "cautious" },
    elowen: { summary: "A scholar of old works.", knownAs: "a scholar traveling with the party", voice: "Precise.", goals: ["Learn what the ridge hides"], riskTolerance: "balanced" },
  },
};

export const ADVENTURES: readonly Adventure[] = [
  {
    id: "aqueduct",
    name: "The Dry Aqueduct",
    summary: "Three companions and a goatherd on a ridge above a silent city. Locked bars, a rubble fall, a cistern, and an evening sluice.",
    world: starterWorld,
    cast: starterCast,
  },
  {
    id: "ridge",
    name: "The Gate and the Ridge",
    summary: "The small Phase 1 world: a trapped gate and a windy ridge. No NPCs, no referee rulings.",
    world: sampleWorld,
    cast: ridgeCast,
  },
  {
    id: "night-market",
    name: "The Night Market",
    summary: "Two best friends at a riverside market, one with feelings to confess and one with news to share. No dice, no danger; the last ferry leaves at ten.",
    world: nightMarketWorld,
    cast: nightMarketCast,
  },
  {
    id: "outage",
    name: "The 3 A.M. Outage",
    summary: "Two on-call engineers, a checkout system that stopped at 02:58, and an incident commander sure it was the deploy. An hour until morning traffic.",
    world: outageWorld,
    cast: outageCast,
  },
  {
    id: "ashcombe",
    name: "Dinner at Ashcombe House",
    summary: "1926, a storm, and a host dead in his study. Two guests find the clues and name the culprit before the police arrive; everyone is lying about something.",
    world: ashcombeWorld,
    cast: ashcombeCast,
  },
];

export function findAdventure(id: string): Adventure | undefined {
  return ADVENTURES.find((adventure) => adventure.id === id);
}

/** The written cast for a world started from a bundled adventure, recognized by name and characters. */
export function castForWorld(state: WorldState): Cast | undefined {
  const adventure = ADVENTURES.find((entry) => (
    entry.world("probe").name === state.name
    && Object.keys(entry.cast.characters).every((id) => state.characters.some((character) => character.id === id))
  ));
  return adventure?.cast;
}
