import type { Cast } from "../agents/prompts.ts";
import type { WorldSeed } from "../model.ts";

// A country-house mystery. The engine holds the clues as private discoveries
// and the suspects' lies live in their personas; the referee judges each
// search and, at the end, whether the accusation is backed by what was found.
// Julian means to lock himself in with the last evidence unless someone gets
// to the library fire first.
export function ashcombeWorld(id = "ashcombe"): WorldSeed {
  return {
    id,
    name: "Dinner at Ashcombe House",
    speechSeconds: 10,
    rules: { outcomes: "judgment", stats: null, health: null },
    rulings: { abilities: ["wisdom"], maxDifficulty: "hard", maxFailureDamage: 0, maxSeconds: 600 },
    locations: [
      {
        id: "dining-room",
        name: "Dining room",
        description: "Candles, untouched soup, and the guests who are left, watching one another.",
        routes: [{ destinationId: "hall", seconds: 30 }],
      },
      {
        id: "hall",
        name: "Great hall",
        description: "A cold stone hall with a grandfather clock, doors on every side, and rain beating at the windows.",
        routes: [
          { destinationId: "dining-room", seconds: 30 },
          { destinationId: "study", seconds: 30 },
          { destinationId: "library", seconds: 30 },
          { destinationId: "kitchen", seconds: 60 },
        ],
      },
      {
        id: "study",
        name: "Sir Edmund's study",
        description: "The door hangs off its hinges where it was forced. Sir Edmund lies by the desk; the window is shut but unlatched.",
        routes: [{ destinationId: "hall", seconds: 30 }],
      },
      {
        id: "library",
        name: "Library",
        description: "Shelves to the ceiling, a fire burning low in the grate, and French windows onto the terrace.",
        routes: [{ destinationId: "hall", seconds: 30 }, { destinationId: "terrace", seconds: 60 }],
      },
      {
        id: "kitchen",
        name: "Kitchen",
        description: "Copper pans, a scrubbed table, and a back door onto the terrace with a wet coat hanging beside it.",
        routes: [{ destinationId: "hall", seconds: 60 }, { destinationId: "terrace", seconds: 60 }],
      },
      {
        id: "terrace",
        name: "Garden terrace",
        description: "Rain-soaked flagstones under the house's windows, flowerbeds turned to mud, and almost no light.",
        routes: [{ destinationId: "library", seconds: 60 }, { destinationId: "kitchen", seconds: 60 }],
      },
    ],
    items: [
      { id: "torch", name: "Electric torch", description: "A heavy brass torch from the hall table." },
    ],
    characters: [
      { id: "clara", name: "Clara", locationId: "dining-room", hp: 10, maxHp: 10, modifiers: { strength: 0, dexterity: 0, wisdom: 0 }, inventory: {} },
      { id: "arthur", name: "Arthur", locationId: "dining-room", hp: 10, maxHp: 10, modifiers: { strength: 0, dexterity: 0, wisdom: 0 }, inventory: { torch: 1 } },
      { id: "margaret", name: "Lady Margaret", locationId: "dining-room", hp: 10, maxHp: 10, npc: true, modifiers: { strength: 0, dexterity: 0, wisdom: 0 }, inventory: {} },
      { id: "julian", name: "Julian", locationId: "library", hp: 10, maxHp: 10, npc: true, modifiers: { strength: 0, dexterity: 0, wisdom: 0 }, inventory: {} },
      { id: "hale", name: "Mrs. Hale", locationId: "kitchen", hp: 10, maxHp: 10, npc: true, modifiers: { strength: 0, dexterity: 0, wisdom: 0 }, inventory: {} },
    ],
    challenges: [
      {
        id: "examine-body",
        name: "Examine the body",
        description: "Sir Edmund fell by his desk. The mantel clock above him reads twenty to nine.",
        locationId: "study",
        ability: "wisdom", difficulty: 8, seconds: 300, failureDamage: 0,
        criteria: "Succeeds if they look closely at the body, his pockets, and the desk around him. A glance from the doorway fails.",
        onSuccess: {
          reveals: "Sir Edmund's wristwatch smashed when he fell and stopped at 8:10. The mantel clock says 8:40, and its glass "
            + "carries fresh fingerprints: someone moved the clock on to fake the time of death.",
        },
        resolved: false,
      },
      {
        id: "search-terrace",
        name: "Search beneath the study window",
        description: "The study window looks over the terrace.",
        locationId: "terrace",
        ability: "wisdom", difficulty: 12, seconds: 300, failureDamage: 0,
        requiresItemId: "torch",
        criteria: "Succeeds if they search the flowerbed under the study window and follow what they find with the light. "
          + "Fails if they hurry, or only search near the doors.",
        onSuccess: {
          reveals: "In the mud below the study window: a pair of gentleman's gloves, caked in earth and monogrammed J.V., and "
            + "footprints in evening shoes leading to the library's French windows.",
        },
        resolved: false,
      },
      {
        id: "rescue-letter",
        name: "Pull the letter from the fire",
        description: "A folded paper is curling at the edge of the library grate.",
        locationId: "library",
        ability: "wisdom", difficulty: 12, seconds: 60, failureDamage: 0,
        criteria: "Succeeds if they act at once and pull the paper out by its unburnt edge. Fails if they hesitate, ask permission, "
          + "or let Julian distract them first.",
        onSuccess: {
          reveals: "A half-burnt letter from Sir Edmund's solicitor: \"...as instructed, Julian is removed from the will, effective "
            + "upon your signature tomorrow morning.\"",
          disarmThreats: ["library-locked"],
        },
        resolved: false,
      },
      {
        id: "win-hale",
        name: "Win Mrs. Hale's trust",
        description: "The housekeeper's coat is soaked through, and she says she has not left the kitchen all evening.",
        locationId: "kitchen",
        ability: "wisdom", difficulty: 12, seconds: 300, failureDamage: 0,
        criteria: "Succeeds if they show they know she was outside (the wet coat), promise to keep her secret, and do not accuse "
          + "her of the murder. Fails if they threaten her or call in the others.",
        onSuccess: {
          reveals: "Mrs. Hale admits she was on the terrace at eight, meeting her son, who deserted from the army. In the rain she "
            + "saw a tall, fair-haired man in evening dress climb out of the study window.",
        },
        resolved: false,
      },
      {
        id: "name-culprit",
        name: "Name the culprit",
        description: "Gather everyone in the dining room and say who did it.",
        locationId: "dining-room",
        ability: "wisdom", difficulty: 16, seconds: 300, failureDamage: 0,
        criteria: "Succeeds only if they name Julian Vane and support it with at least two things they actually found or were "
          + "told: the moved clock (death at 8:10), the J.V. gloves and the footprints to the library, the solicitor's letter "
          + "cutting Julian from the will, or Mrs. Hale's sighting of a fair-haired man at the window. Naming anyone else, or "
          + "naming Julian with fewer than two of these, fails.",
        resolved: false,
      },
    ],
    threats: [
      {
        id: "library-locked",
        name: "Julian locks the library",
        text: "A key turns in the library doors and the French windows bang shut. Smoke from a fresh blaze curls under the door.",
        lockRoutes: [{ fromId: "hall", destinationId: "library" }, { fromId: "terrace", destinationId: "library" }],
        status: "armed",
        at: 1800,
      },
      {
        id: "police-arrive",
        name: "The police arrive",
        text: "Headlamps sweep the drive: the road has cleared, and the police are at the door.",
        status: "armed",
        at: 5400,
      },
    ],
    endings: [
      {
        id: "solved",
        name: "Solved",
        text: "Julian's face goes white, then he bolts for the door; Lady Margaret does not try to stop the constable. The rain "
          + "eases, and Ashcombe House is quiet at last.",
        when: { challengeId: "name-culprit", outcome: "success" },
      },
      {
        id: "wrong-person",
        name: "The wrong person",
        text: "The accusation does not hold. By dawn the police have taken the easiest answer, and the real killer watches them "
          + "drive away.",
        when: { challengeId: "name-culprit", outcome: "failure" },
      },
      {
        id: "dawn",
        name: "Out of time",
        text: "The police take over, and with nothing solid to go on they arrest the housekeeper. The truth leaves with whoever "
          + "kept it.",
        when: { threatId: "police-arrive" },
      },
    ],
  };
}

export const ashcombeCast: Cast = {
  premise: "England, 1926. A storm has closed the only road to Ashcombe House. Before the soup was served, the host, Sir Edmund "
    + "Vane, was found dead in his study. Two guests with a taste for puzzles set out to name the culprit before the police "
    + "arrive. Everyone in the house is hiding something, and not everyone is telling the truth.",
  narratorStyle: "A classic detective novel: precise, wry, and atmospheric, with every detail placed as if it might matter. Past tense.",
  pace: "conversation",
  characters: {
    clara: {
      summary: "Clara Finch, a crime novelist who has written eleven murders and solved none. Sharp, bold, and nosy.",
      voice: "Quick, curious, and fond of a theatrical question.",
      goals: ["Find out who killed Sir Edmund", "Catch someone in a lie"],
      riskTolerance: "bold",
    },
    arthur: {
      summary: "Arthur Pell, a retired army doctor. Methodical, kind, and hard to fool about a body.",
      voice: "Measured and courteous, with the occasional dry aside.",
      goals: ["Establish how and when Sir Edmund died", "Make sure no innocent person is blamed"],
      riskTolerance: "cautious",
    },
  },
  npcs: {
    margaret: {
      summary: "Lady Margaret Vane, Sir Edmund's wife: composed, cold, and protective of the family name.",
      voice: "Clipped and aristocratic; never raises her voice.",
      knowledge: [
        "Say you spent the evening in the drawing room. In truth you argued with Edmund about money in his study at 7:50 and left him alive and furious",
        "Say Julian was with you before dinner. In truth you did not see him between seven and half past eight",
        "Edmund meant to change his will tomorrow; you do not know how",
      ],
      wants: ["Keep the family's name out of the newspapers", "Not be suspected yourself"],
    },
    julian: {
      summary: "Julian Vane, Sir Edmund's nephew: tall, fair-haired, charming, and deep in gambling debts. He killed his uncle.",
      voice: "Easy charm, quick jokes, and a temper when cornered.",
      knowledge: [
        "Say you were reading in the library from seven until dinner. In truth you climbed into the study by the window at eight, struck your uncle, and moved the mantel clock on to 8:40",
        "Your gloves are missing; you dropped them somewhere outside in the dark",
        "The solicitor's letter cutting you from the will is burning in the library grate; you hope it is gone",
      ],
      wants: ["Not be caught", "Point suspicion at Mrs. Hale, who was out in the rain"],
      agenda: { everyMinutes: 15, aims: ["Hint that Mrs. Hale was outside when it happened", "Offer everyone a drink and a theory"] },
    },
    hale: {
      summary: "Mrs. Hale, the housekeeper for twenty years: loyal, frightened, and hiding her son.",
      voice: "Plain, polite, and evasive when pressed.",
      knowledge: [
        "Say you never left the kitchen. In truth you met your son on the terrace at eight; he deserted from the army and is hiding nearby",
        "You saw a tall, fair-haired man in evening dress climb out of the study window, but saying so would mean admitting you were outside",
      ],
      wants: ["Protect your son", "Not be blamed for the master's death"],
    },
  },
};
