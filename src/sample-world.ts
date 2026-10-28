import type { WorldSeed } from "./model.ts";

// Phase 1's sample world, converted to seconds. Existing Phase 1 copies upcast to
// exactly this seed, so `createWorld` keeps resuming them.
export function sampleWorld(id = "ridge-adventure"): WorldSeed {
  return {
    id,
    name: "The Gate and the Ridge",
    speechSeconds: 10,
    locations: [
      { id: "gate", name: "Outer Gate", routes: [{ destinationId: "ridge", seconds: 300 }] },
      { id: "ridge", name: "Windy Ridge", routes: [{ destinationId: "gate", seconds: 300 }] },
    ],
    items: [{ id: "rope", name: "Rope" }, { id: "torch", name: "Torch" }],
    characters: [
      {
        id: "mira", name: "Mira", locationId: "gate", hp: 10, maxHp: 10,
        modifiers: { strength: 0, dexterity: 3, wisdom: 1 },
        inventory: { rope: 1 },
      },
      {
        id: "bram", name: "Bram", locationId: "gate", hp: 14, maxHp: 14,
        modifiers: { strength: 3, dexterity: 0, wisdom: 1 },
        inventory: { torch: 2 },
      },
      {
        id: "elowen", name: "Elowen", locationId: "ridge", hp: 8, maxHp: 8,
        modifiers: { strength: -1, dexterity: 1, wisdom: 3 },
        inventory: {},
      },
    ],
    challenges: [
      {
        id: "gate-trap", name: "Disarm the gate trap", locationId: "gate",
        ability: "dexterity", difficulty: 13, seconds: 120, failureDamage: 3, resolved: false,
      },
      {
        id: "scout-aqueduct", name: "Locate the aqueduct entrance", locationId: "ridge",
        ability: "wisdom", difficulty: 12, seconds: 180, failureDamage: 0, resolved: false,
      },
    ],
  };
}
