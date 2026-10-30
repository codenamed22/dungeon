// Sample chats the director gives the AI creator for inspiration: real or
// invented conversations whose voices, relationships, and situations a world
// can borrow. They are kept beside a draft, never in it, so they reach neither
// the world nor its downloads. The browser shows their limits, so this module
// imports nothing.

export const MAX_SAMPLES = 5;
/**
 * All of a draft's samples together: about 270,000 tokens of chat, which a
 * message carries through every model call once read, so only a model with a
 * large context can read them all.
 */
export const MAX_SAMPLE_CHARACTERS = 800_000;
/** The most one read of a sample returns. */
export const SAMPLE_PART_CHARACTERS = 100_000;
export const MAX_SAMPLE_NAME_LENGTH = 200;
/** Chats tokenize worse than prose, with their names, times, and emoji: about three characters a token. */
const CHARACTERS_PER_TOKEN = 3;
/** Room a message needs beside the samples: instructions, the draft, tool results, and the reply. */
export const SAMPLE_CONTEXT_RESERVE = 60_000;

export interface DraftSample {
  id: string;
  /** The file's name, as the director chose it. */
  name: string;
  text: string;
  /** The text's length in UTF-16 code units, as the browser counts it. */
  characters: number;
  addedAt: string;
}

/** A sample as the browser sees it: without its text. */
export type SampleInfo = Omit<DraftSample, "text">;

/** A sample as the AI creator's instructions list it. */
export interface SampleListing {
  name: string;
  characters: number;
  /** How many reads it takes to see all of it. */
  parts: number;
}

/** A chat file's text with its line breaks made plain and its ends trimmed. */
export function normalizeSample(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").trim();
}

/** Why some text can't be a sample, or null if it can. */
export function sampleTextProblem(text: string): string | null {
  if (text === "") return "The file is empty.";
  if (text.includes("\u0000")) return "This doesn't look like a text file. Export the chat as text (.txt) and try again.";
  return null;
}

/**
 * A sample's text in parts of at most SAMPLE_PART_CHARACTERS, each ending at a
 * line break when one falls in the part's second half, and never inside an
 * emoji or other character outside the Basic Multilingual Plane.
 */
export function sampleParts(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + SAMPLE_PART_CHARACTERS);
    if (end < text.length) {
      const lineBreak = text.lastIndexOf("\n", end - 1);
      if (lineBreak >= start + SAMPLE_PART_CHARACTERS / 2) end = lineBreak + 1;
      else if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end -= 1;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

export function sampleInfo(sample: SampleInfo): SampleInfo {
  const { id, name, characters, addedAt } = sample;
  return { id, name, characters, addedAt };
}

export function sampleListing(sample: DraftSample): SampleListing {
  return { name: sample.name, characters: sample.characters, parts: sampleParts(sample.text).length };
}

/** Roughly how many tokens samples of this many characters take. */
export function sampleTokens(characters: number): number {
  return Math.ceil(characters / CHARACTERS_PER_TOKEN);
}
