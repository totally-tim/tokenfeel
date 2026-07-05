import type { TimelineEvent } from "../types";

export interface StreamFrame {
  text: string;
  tokens: number;
  progress: number;
}

export function isGeneratedEvent(event: TimelineEvent): boolean {
  return event.role === "assistant" || event.role === "thinking" || event.role === "tool_call";
}

function rawDecodeProgressForEvent(event: TimelineEvent, elapsedMs: number): number {
  if (!isGeneratedEvent(event)) return 1;
  if (elapsedMs < event.prefillDoneMs) return 0;
  if (elapsedMs >= event.endMs) return 1;

  const decodeMs = event.endMs - event.prefillDoneMs;
  if (decodeMs <= 0) return 1;
  return Math.max(0, Math.min(1, (elapsedMs - event.prefillDoneMs) / decodeMs));
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

  const rawProgress = rawDecodeProgressForEvent(event, elapsedMs);
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
