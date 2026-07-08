import type { TimelineEvent } from "../types";

export interface StreamFrame {
  text: string;
  tokens: number;
  progress: number;
}

export function isGeneratedEvent(event: TimelineEvent): boolean {
  return event.role === "assistant" || event.role === "thinking" || event.role === "tool_call";
}

/**
 * Fraction of decode "complete" at `elapsedDecodeMs` into the decode window,
 * following the event's real per-token cumulative timing curve
 * (`decodeCumulativeMs`, built in `buildTimeline` from the actual
 * depth-dependent rate curve) instead of a flat fraction of elapsed time.
 * Binary-searches for the bracketing token boundaries and interpolates
 * linearly within that single token's ms span, so pacing visibly
 * decelerates across a long generation exactly as the underlying data does
 * — no synthetic jitter, only the real integrated curve.
 */
function decodeCumulativeProgress(event: TimelineEvent, elapsedDecodeMs: number): number {
  const cumulative = event.decodeCumulativeMs;
  const totalTokens = cumulative.length - 1;
  if (totalTokens <= 0) return 1;

  const totalMs = cumulative[totalTokens];
  if (!(totalMs > 0)) return 1;
  if (elapsedDecodeMs <= 0) return 0;
  if (elapsedDecodeMs >= totalMs) return 1;

  let lo = 0;
  let hi = totalTokens;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cumulative[mid] <= elapsedDecodeMs) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  const lowIndex = lo;
  const highIndex = Math.min(totalTokens, lowIndex + 1);
  const lowMs = cumulative[lowIndex];
  const highMs = cumulative[highIndex];
  const span = highMs - lowMs;
  const withinTokenFraction = span > 0 ? (elapsedDecodeMs - lowMs) / span : 0;
  const fractionalTokens = lowIndex + withinTokenFraction;

  return fractionalTokens / totalTokens;
}

/**
 * Context depth "as of" `elapsedMs` within `event` — sweeps continuously
 * rather than jumping straight to `contextAfter` for the event's whole
 * duration. Generated events only gain depth via decode (their prefill
 * component is always zero — see `buildTimeline`), so before decode starts
 * (tool latency) depth holds flat at `contextBefore`; during decode it
 * tracks the real per-token cumulative timing curve via
 * `decodeCumulativeProgress` (the same curve driving the visible token
 * reveal), which continues from 0 exactly where the flat hold left off, so
 * there is no jump at the tool-latency/decode boundary. Non-generated
 * (prefill-only) events linearly interpolate from `contextBefore` toward
 * `contextAfter` over their whole span, since no comparable per-token
 * prefill curve is exposed here.
 */
export function liveDepthForEvent(event: TimelineEvent, elapsedMs: number): number {
  if (elapsedMs <= event.startMs) return event.contextBefore;
  if (elapsedMs >= event.endMs) return event.contextAfter;

  if (isGeneratedEvent(event)) {
    if (event.tokens > 0 && elapsedMs >= event.prefillDoneMs) {
      const decodeProgress = decodeCumulativeProgress(event, elapsedMs - event.prefillDoneMs);
      return event.contextBefore + decodeProgress * event.tokens;
    }
    return event.contextBefore;
  }

  const span = event.endMs - event.startMs;
  if (span <= 0) return event.contextAfter;
  const progress = (elapsedMs - event.startMs) / span;
  return event.contextBefore + progress * (event.contextAfter - event.contextBefore);
}

/**
 * Fraction of decode "complete" at `elapsedMs` within `event`, following the
 * same curve-aware cadence as `streamFrameForEvent`'s `progress` but without
 * the text-chunking cost — for callers (phase progress bars, race-lane
 * readouts) that only need the number, not the revealed text.
 */
export function decodeProgressForEvent(event: TimelineEvent, elapsedMs: number): number {
  if (!isGeneratedEvent(event)) return 1;
  if (elapsedMs < event.prefillDoneMs) return 0;
  if (elapsedMs >= event.endMs) return 1;

  const decodeMs = event.endMs - event.prefillDoneMs;
  if (decodeMs <= 0) return 1;
  const elapsedDecodeMs = elapsedMs - event.prefillDoneMs;
  return Math.max(0, Math.min(1, decodeCumulativeProgress(event, elapsedDecodeMs)));
}

function visibleTextForProgress(text: string, progress: number, generatedTokens: number): string {
  if (progress <= 0 || generatedTokens <= 0) return "";
  if (progress >= 1) return text;

  const chunks = streamTextChunks(text);
  const visibleChunkCount = Math.max(1, Math.floor(chunks.length * progress + 1e-9));
  return chunks.slice(0, visibleChunkCount).join("");
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

function isWordChar(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char);
}

function isInternalWordPunctuation(text: string, index: number): boolean {
  const char = text[index];
  if (char !== "'" && char !== "." && char !== "-" && char !== "’") return false;

  const previous = text[index - 1];
  const next = text[index + 1];
  return Boolean(previous && next && isWordChar(previous) && isWordChar(next));
}

export function streamTextChunks(text: string): string[] {
  const chunks: string[] = [];
  let index = 0;

  while (index < text.length) {
    const start = index;

    while (index < text.length && isWhitespace(text[index])) {
      index += 1;
    }

    if (index >= text.length) {
      chunks.push(text.slice(start));
      break;
    }

    if (isWordChar(text[index])) {
      index += 1;
      while (
        index < text.length &&
        (isWordChar(text[index]) || isInternalWordPunctuation(text, index))
      ) {
        index += 1;
      }
      chunks.push(text.slice(start, index));
      continue;
    }

    index += 1;
    while (index < text.length && !isWhitespace(text[index]) && !isWordChar(text[index])) {
      index += 1;
    }

    const punctuationEnd = index;
    while (index < text.length && text[index] === "\n") {
      index += 1;
    }

    chunks.push(text.slice(start, index > punctuationEnd ? index : punctuationEnd));
  }

  return chunks.length > 0 ? chunks : [text];
}

export function streamFrameForEvent(event: TimelineEvent, elapsedMs: number): StreamFrame {
  if (!isGeneratedEvent(event)) {
    return { text: event.text, tokens: event.tokens, progress: 1 };
  }

  const rawProgress = decodeProgressForEvent(event, elapsedMs);
  if (rawProgress <= 0) return { text: "", tokens: 0, progress: 0 };
  if (rawProgress >= 1) {
    return { text: event.text, tokens: event.tokens, progress: 1 };
  }

  const tokens = Math.min(event.tokens, Math.floor(event.tokens * rawProgress + 1e-9));
  const text = visibleTextForProgress(event.text, rawProgress, tokens);

  return {
    text,
    tokens,
    progress: rawProgress
  };
}
