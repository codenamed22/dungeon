import type { Cast } from "../agents/prompts.ts";
import type { WorldSeed } from "../model.ts";

// The starter adventure exercises every world feature: descriptions, locked
// routes, item requirements, success effects, a private discovery, an NPC with
// an agenda, ruling limits, a timed threat (the sluice), and a delayed
// consequence (a botched rubble pull brings the ceiling down five minutes
// later, unless someone then clears the rubble properly). The lantern
// requirement is the evaluation check "a character cannot use an item they gave
// away"; Old Tamsin is the moving NPC.
export function starterWorld(id = "aqueduct-adventure"): WorldSeed {
  return {
    id,
    name: "The Dry Aqueduct",
    speechSeconds: 10,
    rulings: { abilities: ["strength", "dexterity", "wisdom"], maxDifficulty: "hard", maxFailureDamage: 3, maxSeconds: 600 },
    locations: [
      {
        id: "camp",
        name: "Ridge Camp",
        description: "A windbreak of piled stones on the ridge. Below, a dry aqueduct runs toward the walls of a silent city.",
        routes: [{ destinationId: "mouth", seconds: 300 }],
      },
      {
        id: "mouth",
        name: "Aqueduct Mouth",
        description: "A brick arch half-buried in scree. Rusted iron bars close the channel beyond it.",
        routes: [
          { destinationId: "camp", seconds: 300 },
          { destinationId: "channel", seconds: 120, locked: true },
        ],
      },
      {
        id: "channel",
        name: "Dry Channel",
        description: "A stone channel just tall enough to walk stooped. Old water lines stain the walls; a fall of rubble chokes the far end.",
        routes: [
          { destinationId: "mouth", seconds: 120 },
          { destinationId: "cistern", seconds: 240, locked: true },
        ],
      },
      {
        id: "cistern",
        name: "Cistern Vault",
        description: "A vaulted chamber beneath the city walls, smelling of old stone. A narrow ledge runs along one side.",
        routes: [{ destinationId: "channel", seconds: 240 }],
      },
    ],
    items: [
      { id: "rope", name: "Rope", description: "Thirty feet of hemp rope." },
      { id: "crowbar", name: "Crowbar", description: "A heavy iron bar, flattened at one end." },
      { id: "lantern", name: "Lantern", description: "A shuttered oil lantern, full." },
      { id: "seal", name: "Bronze seal", description: "A city magistrate's seal, green with age." },
    ],
    characters: [
      {
        id: "mira", name: "Mira", locationId: "camp", hp: 10, maxHp: 10,
        modifiers: { strength: 0, dexterity: 3, wisdom: 1 },
        inventory: { rope: 1 },
      },
      {
        id: "bram", name: "Bram", locationId: "camp", hp: 14, maxHp: 14,
        modifiers: { strength: 3, dexterity: 0, wisdom: 1 },
        inventory: { crowbar: 1 },
      },
      {
        id: "elowen", name: "Elowen", locationId: "mouth", hp: 8, maxHp: 8,
        modifiers: { strength: -1, dexterity: 1, wisdom: 3 },
        inventory: { lantern: 1 },
      },
      {
        id: "tamsin", name: "Old Tamsin", locationId: "camp", hp: 6, maxHp: 6, npc: true,
        modifiers: { strength: -1, dexterity: 0, wisdom: 2 },
        inventory: {},
      },
    ],
    challenges: [
      {
        id: "pry-bars",
        name: "Pry open the bars",
        description: "The bars are rusted into the brick, but a lever could shift them.",
        locationId: "mouth",
        ability: "strength", difficulty: 13, seconds: 120, failureDamage: 2,
        requiresItemId: "crowbar",
        onSuccess: { unlockRoutes: [{ fromId: "mouth", destinationId: "channel" }] },
        resolved: false,
      },
      {
        id: "clear-rubble",
        name: "Shift the rubble fall",
        description: "Loose blocks and grit; pulling the wrong one could bring more down.",
        locationId: "channel",
        ability: "strength", difficulty: 14, seconds: 240, failureDamage: 3,
        onSuccess: { unlockRoutes: [{ fromId: "channel", destinationId: "cistern" }], disarmThreats: ["ceiling-collapse"] },
        onFailure: { armThreats: ["ceiling-collapse"] },
        resolved: false,
      },
      {
        id: "search-ledge",
        name: "Search the cistern ledge",
        description: "Something glints in a niche above the waterline, too dark to make out.",
        locationId: "cistern",
        ability: "wisdom", difficulty: 12, seconds: 180, failureDamage: 0,
        requiresItemId: "lantern",
        onSuccess: {
          grantItems: [{ itemId: "seal", quantity: 1 }],
          reveals: "Scratched into the niche behind the seal: an arrow pointing up the north wall, and the words \"the hall drain is dry\".",
        },
        resolved: false,
      },
    ],
    threats: [
      {
        id: "sluice",
        name: "The evening sluice",
        text: "Iron groans somewhere inside the walls, and a surge of black water roars down the channel.",
        locationIds: ["channel"],
        damage: 2,
        status: "armed",
        at: 3000,
      },
      {
        id: "ceiling-collapse",
        name: "The channel ceiling gives way",
        text: "With a long grinding roar, part of the channel ceiling comes down around the rubble.",
        locationIds: ["channel"],
        damage: 2,
        status: "waiting",
        delaySeconds: 300,
      },
    ],
  };
}

export const starterCast: Cast = {
  premise: "Low fantasy, among dead cities and old engineering. Three companions camp on a ridge above a city emptied a "
    + "generation ago, its gates still shut. A dry aqueduct runs under the walls: the only way in anyone knows. They mean to "
    + "get inside before nightfall and learn why the city fell silent. The dangers are plain and physical: rust, rubble, "
    + "falls, and the dark.",
  narratorStyle: "Spare, concrete, and a little ominous. Present tense. No purple prose.",
  characters: {
    mira: {
      summary: "A quick, light-footed scout who hates wasting daylight.",
      voice: "Clipped and wry; short sentences.",
      goals: ["Get inside the city before nightfall", "Keep the rope for the climb out"],
      riskTolerance: "bold",
    },
    bram: {
      summary: "A former quarry worker, strong and steady, protective of the others.",
      voice: "Slow, plain, and warm; fond of quarry sayings.",
      goals: ["Keep everyone unhurt", "Take on the heavy work rather than let others get hurt"],
      riskTolerance: "cautious",
    },
    elowen: {
      summary: "A scholar of old waterworks who came for whatever the city buried.",
      voice: "Precise and curious, a little impatient with guesswork.",
      goals: ["Reach the cistern vault and see what lies there", "Understand the aqueduct before forcing it"],
      riskTolerance: "balanced",
    },
  },
  npcs: {
    tamsin: {
      summary: "A goatherd who has grazed this ridge for forty years and watched the city empty.",
      voice: "Dry, unhurried, and fond of answering a question with a question.",
      knowledge: [
        "The bars at the aqueduct mouth are rusted, and a strong lever could shift them",
        "The channel beyond runs under the walls to a great cistern",
        "Magistrates once kept their treasures in the cistern vault, or so her grandmother said",
        "Nobody who went into the channel last spring came back out (she is not sure this is true)",
        "The city's old sluice still opens some evenings and sends water down the channel; she does not know when",
      ],
      wants: ["To be left in peace with her goats", "News of the lowland towns", "To see someone finally bring something out of the city"],
      agenda: {
        everyMinutes: 15,
        aims: ["Warn anyone heading for the channel about the sluice", "Trade what she knows for news of the lowland towns"],
      },
    },
  },
};
