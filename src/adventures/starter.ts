import type { Cast } from "../agents/prompts.ts";
import type { WorldSeed } from "../model.ts";

// The starter adventure exercises every Phase 2a world feature: descriptions,
// locked routes, item requirements, and success effects. The lantern requirement
// is the evaluation check "a character cannot use an item they gave away".
export function starterWorld(id = "aqueduct-adventure"): WorldSeed {
  return {
    id,
    name: "The Dry Aqueduct",
    speechSeconds: 10,
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
        onSuccess: { unlockRoutes: [{ fromId: "channel", destinationId: "cistern" }] },
        resolved: false,
      },
      {
        id: "search-ledge",
        name: "Search the cistern ledge",
        description: "Something glints in a niche above the waterline, too dark to make out.",
        locationId: "cistern",
        ability: "wisdom", difficulty: 12, seconds: 180, failureDamage: 0,
        requiresItemId: "lantern",
        onSuccess: { grantItems: [{ itemId: "seal", quantity: 1 }] },
        resolved: false,
      },
    ],
  };
}

export const starterCast: Cast = {
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
};
