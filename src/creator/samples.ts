// Sample chats the director gives the AI creator for inspiration: real or
// invented conversations whose voices, relationships, and situations a world
// can borrow. They are kept beside a draft, never in it, so they reach neither
// the world nor its downloads. The browser shows their limits, so this module
// imports nothing.

export const MAX_SAMPLES = 5;
/** All of a draft's samples together: about 25,000 tokens, which a message may carry through every round. */
export const MAX_SAMPLE_CHARACTERS = 100_000;
/** The most one read of a sample returns. */
export const SAMPLE_PART_CHARACTERS = 25_000;
export const MAX_SAMPLE_NAME_LENGTH = 200;

export interface DraftSample {
  id: string;
  /** The file's name, as the director chose it. */
  name: string;
  text: string;
  /** The text's length in UTF-16 code units, as the browser counts it. */
  characters: number;
  addedAt: string;
}

/** A sample as the browser and the AI creator's instructions see it: without its text. */
export interface SampleInfo {
  id: string;
  name: string;
  characters: number;
  /** How many reads it takes to see all of it. */
  parts: number;
  addedAt: string;
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

export function sampleInfo(sample: DraftSample): SampleInfo {
  const { id, name, characters, addedAt } = sample;
  return { id, name, characters, parts: sampleParts(sample.text).length, addedAt };
}
