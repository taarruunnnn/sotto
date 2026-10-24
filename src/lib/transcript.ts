export type Speaker = "me" | "them";

export interface Line {
  id: number;
  source: Speaker;
  text: string;
  /** Left out of AI prompts (toggled by clicking the line). */
  excluded?: boolean;
}

/** Payload of the `transcript` event emitted by `src-tauri/src/deepgram.rs`. */
export interface TranscriptEvent {
  source: Speaker;
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
}

export function formatTranscript(lines: Line[], maxChars: number): string {
  const text = lines
    .filter((l) => !l.excluded)
    .map((l) => `${l.source === "me" ? "Me" : "Them"}: ${l.text}`)
    .join("\n");
  return text.length > maxChars ? "…" + text.slice(-maxChars) : text;
}

const QUESTION_STARTERS =
  /^(who|what|when|where|why|how|which|can|could|would|will|do|does|did|is|are|was|were|have|has|should|tell me|walk me|explain|describe|talk me|give me|share|let's say|imagine|suppose|design|implement|write)\b/i;

/**
 * Cheap heuristic for "the other person just asked something". It runs on every
 * finished utterance, so it has to be instant; false positives only cost one
 * extra (cancellable) answer.
 */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  if (t.split(/\s+/).length < 3) return false;
  if (t.endsWith("?")) return true;
  // Check each sentence, since questions often follow a lead-in.
  return t.split(/(?<=[.!?])\s+/).some((s) => QUESTION_STARTERS.test(s));
}
