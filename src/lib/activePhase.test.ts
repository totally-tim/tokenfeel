import { describe, expect, test } from "vitest";
import type { TimelineEvent } from "../types";
import { activePhaseForEvent, phaseProgress } from "./activePhase";

// Flat per-token cumulative timing so decodeProgressForEvent (delegated to
// ./streaming, already covered by streaming.test.ts) reduces to a simple
// linear fraction -- these tests are about the phase state machine, not
// decode pacing itself.
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
  toolLatencyMs: 200,
  startMs: 1000,
  toolDoneMs: 1200,
  prefillMs: 100,
  prefillDoneMs: 1300,
  decodeMs: 400,
  endMs: 1700,
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

describe("phaseProgress", () => {
  test("is 0 at the start of the window and 1 at the end", () => {
    expect(phaseProgress(100, 100, 200)).toBe(0);
    expect(phaseProgress(200, 100, 200)).toBe(1);
  });

  test("interpolates linearly between start and end", () => {
    expect(phaseProgress(150, 100, 200)).toBeCloseTo(0.5);
  });

  test("clamps outside the window instead of returning out-of-range values", () => {
    expect(phaseProgress(50, 100, 200)).toBe(0);
    expect(phaseProgress(300, 100, 200)).toBe(1);
  });

  test("guards against a zero-width window (start === end) instead of dividing by zero", () => {
    expect(Number.isFinite(phaseProgress(100, 100, 100))).toBe(true);
  });
});

describe("activePhaseForEvent", () => {
  test("reports idle before playback has started, regardless of elapsedMs", () => {
    const phase = activePhaseForEvent(baseEvent, baseEvent.startMs + 50, false, false);

    expect(phase).toEqual({
      kind: "idle",
      elapsedMs: 0,
      totalMs: baseEvent.endMs - baseEvent.startMs,
      progress: 0
    });
  });

  test("reports complete once the caller marks the event complete", () => {
    const phase = activePhaseForEvent(baseEvent, baseEvent.startMs + 50, true, true);

    expect(phase.kind).toBe("complete");
    expect(phase.progress).toBe(1);
    expect(phase.elapsedMs).toBe(baseEvent.endMs - baseEvent.startMs);
  });

  test("reports complete once elapsed time reaches endMs, even without the caller's complete flag", () => {
    const phase = activePhaseForEvent(baseEvent, baseEvent.endMs, true, false);

    expect(phase.kind).toBe("complete");
    expect(phase.progress).toBe(1);
  });

  test("reports the tool-wait phase while inside the tool latency window", () => {
    const phase = activePhaseForEvent(baseEvent, baseEvent.startMs + 100, true, false);

    expect(phase.kind).toBe("tool");
    expect(phase.totalMs).toBe(baseEvent.toolLatencyMs);
    expect(phase.elapsedMs).toBe(100);
    expect(phase.progress).toBeCloseTo(100 / baseEvent.toolLatencyMs);
  });

  test("reports the prefill phase once tool wait is done but prefill is not", () => {
    const phase = activePhaseForEvent(baseEvent, baseEvent.toolDoneMs + 50, true, false);

    expect(phase.kind).toBe("prefill");
    expect(phase.totalMs).toBe(baseEvent.prefillMs);
    expect(phase.elapsedMs).toBe(50);
    expect(phase.progress).toBeCloseTo(50 / baseEvent.prefillMs);
  });

  test("reports the decode phase once prefill is done but the event has not ended", () => {
    const phase = activePhaseForEvent(baseEvent, baseEvent.prefillDoneMs + 200, true, false);

    expect(phase.kind).toBe("decode");
    expect(phase.totalMs).toBe(baseEvent.decodeMs);
    expect(phase.elapsedMs).toBe(200);
    // decodeProgressForEvent's own curve behavior is streaming.test.ts's job;
    // here we only need it to land strictly between not-started and done.
    expect(phase.progress).toBeGreaterThan(0);
    expect(phase.progress).toBeLessThan(1);
  });

  test("falls back to an instant phase when a started event has no tool/prefill/decode duration left to attribute", () => {
    // Synthetic: a zero-duration marker-like event (e.g. what a cache_bust
    // event's timeline entry would look like) that still has a nonzero
    // start/end span. No branch above claims it, so it must resolve to
    // "instant" rather than throwing or silently returning idle/complete.
    const instantEvent: TimelineEvent = {
      ...baseEvent,
      toolLatencyMs: 0,
      prefillMs: 0,
      decodeMs: 0,
      toolDoneMs: baseEvent.startMs,
      prefillDoneMs: baseEvent.startMs,
      endMs: baseEvent.startMs + 10
    };

    const phase = activePhaseForEvent(instantEvent, instantEvent.startMs + 5, true, false);

    expect(phase.kind).toBe("instant");
    expect(phase.progress).toBe(1);
    expect(phase.elapsedMs).toBe(5);
  });
});
