import { describe, expect, test } from "vitest";
import type { TimelineEvent } from "../types";
import { phaseCopyForEvent, statFootItems, turnMetricForEvent } from "./phaseCopy";

const baseEvent: TimelineEvent = {
  id: "e1",
  role: "assistant",
  text: "hello",
  tokens: 100,
  index: 0,
  phase: "decode",
  toolLatencyMs: 0,
  startMs: 0,
  toolDoneMs: 0,
  prefillMs: 100,
  prefillDoneMs: 100,
  decodeMs: 1000,
  endMs: 1100,
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
  decodeRangeMs: { min: 1000, max: 1000 },
  decodeCumulativeMs: [],
  extrapolated: false
};

describe("phase copy", () => {
  test("uses role-aware wording for generated decode phases", () => {
    expect(phaseCopyForEvent({ ...baseEvent, role: "thinking" }, "decode")).toMatchObject({
      label: "Streaming thinking",
      tokenLabel: "thinking tok",
      detail: "Reasoning tokens are streaming before the visible answer"
    });

    expect(phaseCopyForEvent({ ...baseEvent, role: "assistant" }, "decode")).toMatchObject({
      label: "Streaming answer",
      tokenLabel: "visible tok"
    });

    expect(phaseCopyForEvent({ ...baseEvent, role: "tool_call" }, "decode")).toMatchObject({
      label: "Streaming tool call",
      tokenLabel: "tool-call tok"
    });
  });

  test("does not label projected total as elapsed", () => {
    const keys = statFootItems({
      wallTimeMs: 10_000,
      wallTimeRangeMs: { min: 10_000, max: 10_000 },
      totalTokens: 2000,
      generatedTokens: 500,
      prefilledWithCache: 1500,
      prefilledWithoutCache: 3000,
      cacheSavedRatio: 0.5,
      prefillMs: 7000,
      decodeMs: 3000,
      toolLatencyMs: 0,
      extrapolatedEvents: 0,
      nonMeasuredTimeShare: 0,
      avgDecodeTps: 20
    }).map((item) => item.label);

    expect(keys).toContain("TOTAL SIM");
    expect(keys).not.toContain("ELAPSED");
    expect(keys).not.toContain("TTFT");
  });

  test("does not label non-generating prefill turns as TTFT", () => {
    expect(turnMetricForEvent({ ...baseEvent, role: "user", prefillMs: 1200, decodeMs: 0, ttftMs: 1200 })).toBe(
      "prompt ingest 1.2s"
    );
    expect(turnMetricForEvent({ ...baseEvent, role: "tool_result", prefillMs: 5200, decodeMs: 0, ttftMs: 5200 })).toBe(
      "tool-result ingest 5.2s"
    );
    expect(
      turnMetricForEvent({
        ...baseEvent,
        role: "tool_result",
        toolLatencyMs: 800,
        prefillMs: 5200,
        decodeMs: 0,
        ttftMs: 6000
      })
    ).toBe("tool-result ingest 5.2s");
  });
});
