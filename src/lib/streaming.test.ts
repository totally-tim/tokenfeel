import { describe, expect, test } from "vitest";
import type { TimelineEvent } from "../types";
import { isGeneratedEvent, streamFrameForEvent } from "./streaming";

/**
 * Flat/uniform per-token cumulative timing — every token costs the same
 * `decodeMs / tokens`, which reduces `decodeCumulativeProgress` to the same
 * continuous fraction the old flat-elapsed-time formula produced. Used for
 * every fixture below that isn't specifically testing real depth-dependent
 * deceleration, so those tests keep asserting the same reveal pacing they
 * always have.
 */
function linearCumulativeMs(tokens: number, decodeMs: number): number[] {
  const cumulative: number[] = [0];
  for (let index = 1; index <= tokens; index += 1) {
    cumulative.push(tokens === 0 ? 0 : (decodeMs * index) / tokens);
  }
  return cumulative;
}

const baseEvent: TimelineEvent = {
  id: "e1",
  role: "assistant",
  text: "streaming output",
  tokens: 100,
  index: 0,
  phase: "decode",
  toolLatencyMs: 0,
  startMs: 0,
  toolDoneMs: 0,
  prefillMs: 100,
  prefillDoneMs: 100,
  decodeMs: 400,
  endMs: 500,
  ttftMs: 100,
  contextBefore: 1000,
  contextAfter: 1100,
  cachedPrefixTokens: 0,
  prefillTokens: 1000,
  withoutCachePrefillTokens: 1100,
  ppRate: 1000,
  tgRate: 50,
  ppConfidence: "measured",
  tgConfidence: "measured",
  prefillRangeMs: { min: 100, max: 100 },
  decodeRangeMs: { min: 400, max: 400 },
  decodeCumulativeMs: linearCumulativeMs(100, 400),
  extrapolated: false
};

describe("streaming output", () => {
  test("identifies model-generated event roles", () => {
    expect(isGeneratedEvent(baseEvent)).toBe(true);
    expect(isGeneratedEvent({ ...baseEvent, role: "thinking" })).toBe(true);
    expect(isGeneratedEvent({ ...baseEvent, role: "tool_call" })).toBe(true);
    expect(isGeneratedEvent({ ...baseEvent, role: "user" })).toBe(false);
    expect(isGeneratedEvent({ ...baseEvent, role: "tool_result" })).toBe(false);
  });

  test("holds generated text until TTFT completes", () => {
    expect(streamFrameForEvent(baseEvent, 99).text).toBe("");
  });

  test("streams generated text through the decode window", () => {
    const text = streamFrameForEvent(baseEvent, 300).text;

    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThan(baseEvent.text.length);
  });

  test("streams generated text as print-ready token deltas instead of proportional characters", () => {
    const event: TimelineEvent = {
      ...baseEvent,
      text: "The failing case sits exactly at the final measured depth.",
      tokens: 18,
      endMs: 1100,
      decodeCumulativeMs: linearCumulativeMs(18, 1000)
    };
    const text = streamFrameForEvent(event, 350).text;

    expect(text).toBe("The failing");
  });

  test("does not reveal partial latin words while a token-like chunk is still forming", () => {
    const event: TimelineEvent = {
      ...baseEvent,
      text: "The failing case sits exactly at the final measured depth.",
      tokens: 100,
      prefillDoneMs: 0,
      decodeMs: 1000,
      endMs: 1000,
      ttftMs: 0,
      decodeCumulativeMs: linearCumulativeMs(100, 1000)
    };

    const text = streamFrameForEvent(event, 250).text;

    expect(text).toBe("The failing");
  });

  test("preserves punctuation and leading whitespace inside streamed token-like deltas", () => {
    const event: TimelineEvent = {
      ...baseEvent,
      text: "Why don't scientists trust atoms?\n\nBecause they make up everything!",
      tokens: 12,
      prefillDoneMs: 0,
      decodeMs: 1200,
      endMs: 1200,
      ttftMs: 0,
      decodeCumulativeMs: linearCumulativeMs(12, 1200)
    };

    expect(streamFrameForEvent(event, 100).text).toBe("Why");
    expect(streamFrameForEvent(event, 200).text).toBe("Why don't");
    expect(streamFrameForEvent(event, 600).text).toBe("Why don't scientists trust atoms?\n\n");
  });

  test("reports token progress while visible output advances", () => {
    const event: TimelineEvent = {
      ...baseEvent,
      text: "The model emits grouped deltas with small pauses.",
      tokens: 24,
      endMs: 1100,
      decodeCumulativeMs: linearCumulativeMs(24, 1000)
    };
    const early = streamFrameForEvent(event, 160);
    const later = streamFrameForEvent(event, 650);

    expect(early.tokens).toBeGreaterThanOrEqual(0);
    expect(later.tokens).toBeGreaterThan(early.tokens);
    expect(later.text.length).toBeGreaterThan(early.text.length);
    expect(later.tokens).toBeLessThan(event.tokens);
  });

  test("does not show text before the first generated token is available", () => {
    const event: TimelineEvent = {
      ...baseEvent,
      text: "search",
      tokens: 100,
      prefillMs: 0,
      prefillDoneMs: 0,
      decodeMs: 1000,
      endMs: 1000,
      ttftMs: 0,
      decodeCumulativeMs: linearCumulativeMs(100, 1000)
    };

    expect(streamFrameForEvent(event, 1)).toEqual({
      text: "",
      tokens: 0,
      progress: 0.001
    });
    expect(streamFrameForEvent(event, 10).text).toBe("search");
  });

  test("reports generated token progress at the configured decode rate", () => {
    const event: TimelineEvent = {
      ...baseEvent,
      role: "thinking",
      text: "The model should reveal this reasoning stream with steady motion instead of waiting several seconds and then jumping by a phrase.",
      tokens: 100,
      prefillMs: 0,
      prefillDoneMs: 0,
      decodeMs: 2500,
      endMs: 2500,
      ttftMs: 0,
      tgRate: 40,
      decodeCumulativeMs: linearCumulativeMs(100, 2500)
    };

    expect(streamFrameForEvent(event, 250).tokens).toBe(10);
    expect(streamFrameForEvent(event, 500).tokens).toBe(20);
    expect(streamFrameForEvent(event, 1250).tokens).toBe(50);
    expect(streamFrameForEvent(event, 2000).tokens).toBe(80);
  });

  test("keeps visible generated text moving during a long decode", () => {
    const event: TimelineEvent = {
      ...baseEvent,
      role: "thinking",
      text: "The model should reveal this reasoning stream with steady motion instead of waiting several seconds and then jumping by a phrase.",
      tokens: 100,
      prefillMs: 0,
      prefillDoneMs: 0,
      decodeMs: 2500,
      endMs: 2500,
      ttftMs: 0,
      tgRate: 40,
      decodeCumulativeMs: linearCumulativeMs(100, 2500)
    };

    const before = streamFrameForEvent(event, 1750);
    const after = streamFrameForEvent(event, 2000);

    expect(after.text.length).toBeGreaterThan(before.text.length);
  });

  test("does not stall visible thinking text while token progress advances", () => {
    const event: TimelineEvent = {
      ...baseEvent,
      id: "math-thinking",
      role: "thinking",
      text: "Compare the expected loss of preventive replacement against failure repair time, normalize by production value and search the weekly schedule space.",
      tokens: 2400,
      prefillMs: 0,
      prefillDoneMs: 0,
      decodeMs: 34500,
      endMs: 34500,
      ttftMs: 0,
      tgRate: 69.5,
      decodeCumulativeMs: linearCumulativeMs(2400, 34500)
    };

    const before = streamFrameForEvent(event, 7100);
    const after = streamFrameForEvent(event, 9100);

    expect(after.tokens).toBeGreaterThan(before.tokens);
    expect(after.text.length).toBeGreaterThan(before.text.length);
  });

  test("shows complete generated text after decode finishes", () => {
    expect(streamFrameForEvent(baseEvent, 500).text).toBe("streaming output");
  });

  test("shows non-generated text immediately when its event is visible", () => {
    expect(streamFrameForEvent({ ...baseEvent, role: "user" }, 0).text).toBe("streaming output");
  });

  test("reveals tokens progressively slower as decode proceeds over a depth-degrading rate curve", () => {
    // Fixture models context growing through the decode window: each
    // successive token costs more ms than the last (the real behavior of a
    // degrading-with-depth measurement set), unlike the flat per-token cost
    // every other fixture in this file uses.
    const tokens = 100;
    const perTokenMsStart = 5;
    const perTokenMsEnd = 15;
    const decodeCumulativeMs: number[] = [0];
    for (let index = 1; index <= tokens; index += 1) {
      const perTokenMs = perTokenMsStart + ((perTokenMsEnd - perTokenMsStart) * (index - 1)) / (tokens - 1);
      decodeCumulativeMs.push(decodeCumulativeMs[index - 1] + perTokenMs);
    }
    const totalMs = decodeCumulativeMs[tokens];

    const event: TimelineEvent = {
      ...baseEvent,
      text: "x".repeat(tokens),
      tokens,
      prefillDoneMs: 0,
      decodeMs: totalMs,
      endMs: totalMs,
      ttftMs: 0,
      decodeCumulativeMs
    };

    const windowMs = totalMs / 5;
    const tokensAt = (elapsedMs: number) => streamFrameForEvent(event, elapsedMs).tokens;

    const earlyWindowTokens = tokensAt(windowMs) - tokensAt(0);
    const lateWindowTokens = tokensAt(totalMs) - tokensAt(totalMs - windowMs);

    // Equal-length time windows reveal fewer tokens later in decode, since
    // later tokens individually cost more ms — pacing decelerates.
    expect(earlyWindowTokens).toBeGreaterThan(lateWindowTokens);
  });
});
