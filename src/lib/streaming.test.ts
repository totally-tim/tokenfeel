import { describe, expect, test } from "vitest";
import type { TimelineEvent } from "../types";
import { isGeneratedEvent, liveDepthForEvent, streamFrameForEvent } from "./streaming";

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

describe("liveDepthForEvent", () => {
  test("holds a generated event flat at contextBefore through tool latency, then curves during decode", () => {
    const event: TimelineEvent = {
      ...baseEvent,
      role: "assistant",
      tokens: 100,
      contextBefore: 1000,
      contextAfter: 1100,
      toolLatencyMs: 200,
      startMs: 0,
      toolDoneMs: 200,
      // Generated events never prefill their own output, so prefillMs is 0 and
      // prefillDoneMs === toolDoneMs -- decode begins the instant tool latency ends.
      prefillMs: 0,
      prefillDoneMs: 200,
      decodeMs: 400,
      endMs: 600,
      decodeCumulativeMs: linearCumulativeMs(100, 400)
    };

    // Flat at contextBefore through the whole tool-latency wait and up to the
    // decode boundary.
    expect(liveDepthForEvent(event, 0)).toBe(1000);
    expect(liveDepthForEvent(event, 100)).toBe(1000);
    expect(liveDepthForEvent(event, 200)).toBe(1000);

    // Mid-decode: halfway through the 400ms decode window is ~50 of 100 tokens.
    const mid = liveDepthForEvent(event, 400);
    expect(mid).toBeGreaterThan(1000);
    expect(mid).toBeLessThan(1100);
    expect(mid).toBeCloseTo(1050);

    expect(liveDepthForEvent(event, 600)).toBe(1100);
  });

  test("holds a prefill event flat through tool latency, then interpolates across [toolDoneMs, endMs] (A4)", () => {
    const event: TimelineEvent = {
      ...baseEvent,
      role: "tool_result",
      tokens: 500,
      contextBefore: 2000,
      contextAfter: 2500,
      toolLatencyMs: 300,
      startMs: 0,
      toolDoneMs: 300,
      prefillMs: 200,
      prefillDoneMs: 500,
      decodeMs: 0,
      endMs: 500
    };

    // Must NOT interpolate during the tool-latency wait: depth holds at
    // contextBefore until prefill actually starts at toolDoneMs. The old bug
    // smeared growth across the whole [startMs, endMs] span, returning 2150
    // here instead of 2000.
    expect(liveDepthForEvent(event, 0)).toBe(2000);
    expect(liveDepthForEvent(event, 150)).toBe(2000);
    expect(liveDepthForEvent(event, 300)).toBe(2000);

    // Interpolates over the real prefill span [300, 500]: halfway at 400ms.
    expect(liveDepthForEvent(event, 400)).toBeCloseTo(2250);
    expect(liveDepthForEvent(event, 500)).toBe(2500);
  });
});
