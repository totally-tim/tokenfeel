import { describe, expect, it } from "vitest";
import {
  activeEventAt,
  buildTimeline,
  integrateTimeMs,
  msPerTokenAt,
  summarizeTimeline
} from "./timing";
import type { BenchmarkMeasurement, BenchmarkResult, ScenarioScript } from "../types";

/**
 * Pre-Phase-1 baseline: point-samples the rate at a single depth instead of
 * integrating across the depth range traversed. Kept only as a comparison
 * fixture in these tests to demonstrate the new integral-based behavior
 * differs from (and improves on) it — not used anywhere in production code.
 */
function interpolateRate(
  measurements: BenchmarkMeasurement[],
  field: "pp" | "tg",
  depth: number
): number {
  const points = [...measurements].sort((a, b) => a.depth - b.depth);
  if (depth <= points[0].depth) {
    return points[0][field];
  }

  const last = points[points.length - 1];
  if (depth >= last.depth) {
    return last[field];
  }

  for (let index = 0; index < points.length - 1; index += 1) {
    const left = points[index];
    const right = points[index + 1];
    if (depth >= left.depth && depth <= right.depth) {
      const span = right.depth - left.depth;
      const progress = span === 0 ? 0 : (depth - left.depth) / span;
      return left[field] + (right[field] - left[field]) * progress;
    }
  }

  return last[field];
}

const result: BenchmarkResult = {
  id: "test__model__q4__runtime",
  hardware: "test-hardware",
  model: "test-model",
  quant: "Q4_K_M",
  runtime: {
    name: "llama.cpp",
    version: "b1",
    backend: "CUDA",
    flags: "-fa 1",
    cache: "prefix"
  },
  measurements: [
    { depth: 0, pp: 1000, tg: 20 },
    { depth: 10_000, pp: 500, tg: 10 }
  ],
  overheadMs: 100,
  source: {
    kind: "llama-bench",
    title: "Fixture",
    url: "https://example.com/raw",
    raw: "fixture"
  },
  submitter: "tests",
  date: "2026-07-04",
  status: "verified"
};

const scenario: ScenarioScript = {
  id: "fixture-agent",
  title: "Fixture agent",
  type: "agent",
  systemPromptTokens: 4000,
  events: [
    { id: "u1", role: "user", text: "Fix the failing timing test.", tokens: 50 },
    { id: "a1", role: "assistant", text: "I'll inspect the code.", tokens: 100 },
    { id: "tool1", role: "tool_call", text: "read_file('timing.ts')", tokens: 40 },
    {
      id: "result1",
      role: "tool_result",
      text: "The interpolation branch reads past the last point.",
      tokens: 1200,
      cacheBust: { retainedPrefixTokens: 4000 },
      toolLatencyMs: 250
    },
    { id: "a2", role: "assistant", text: "The test now passes.", tokens: 80 }
  ]
};

describe("interpolateRate", () => {
  it("interpolates between measured depths and clamps beyond the final point", () => {
    expect(interpolateRate(result.measurements, "pp", 5000)).toBe(750);
    expect(interpolateRate(result.measurements, "tg", 5000)).toBe(15);
    expect(interpolateRate(result.measurements, "tg", 100_000)).toBe(10);
  });
});

describe("msPerTokenAt", () => {
  it("interpolates linearly in ms/token (not in rate) between measured depths", () => {
    // tg: depth 0 -> 20 tok/s (50 ms/token), depth 10000 -> 10 tok/s (100 ms/token).
    // Linear in ms/token gives 75 ms/token at the midpoint, NOT the
    // rate-domain harmonic-mean value that interpolateRate's naive
    // point-sample would otherwise imply.
    expect(msPerTokenAt(result.measurements, "tg", 5000)).toBeCloseTo(75);
    expect(msPerTokenAt(result.measurements, "pp", 5000)).toBeCloseTo(1.5);
  });

  it("flat-clamps beyond the min/max measured depth, identical to interpolateRate today", () => {
    expect(msPerTokenAt(result.measurements, "tg", -50)).toBeCloseTo(50);
    expect(msPerTokenAt(result.measurements, "tg", 100_000)).toBeCloseTo(100);
  });
});

describe("integrateTimeMs", () => {
  it("returns 0 for an empty or inverted range", () => {
    expect(integrateTimeMs(result.measurements, "tg", 100, 100)).toBe(0);
    expect(integrateTimeMs(result.measurements, "tg", 200, 100)).toBe(0);
  });

  it("computes the exact trapezoidal integral across a single interior segment", () => {
    // tg ms/token: 50 at depth 0, 100 at depth 10000, linear in between
    // (value(d) = 50 + 0.005 * d).
    // Over [2000, 9000]: value(2000) = 60, value(9000) = 95, avg 77.5 * width 7000 = 542500.
    expect(integrateTimeMs(result.measurements, "tg", 2000, 9000)).toBeCloseTo(542_500);
  });

  it("computes the flat-clamped integral beyond the last measured depth", () => {
    // Beyond depth 10000, tg is flat-clamped at 100 ms/token.
    expect(integrateTimeMs(result.measurements, "tg", 10_000, 11_000)).toBeCloseTo(100_000);
  });

  it("splits a range that straddles the flat-clamp boundary and the measured span", () => {
    // [8000, 12000]: [8000,10000] interior segment (value 90 -> 100, avg 95, width 2000 = 190000)
    // plus [10000,12000] flat at 100 ms/token (200000). Total 390000.
    expect(integrateTimeMs(result.measurements, "tg", 8000, 12_000)).toBeCloseTo(390_000);
  });
});

describe("buildTimeline", () => {
  it("uses measured upstream TTFT for prompt prefill when available", () => {
    const measuredResult: BenchmarkResult = {
      ...result,
      measurements: [
        { depth: 0, pp: 1000, tg: 20, source: { url: "https://example.com/depth-0", upstreamId: "0", ttftMs: 0 } },
        { depth: 1000, pp: 1000, tg: 20, source: { url: "https://example.com/depth-1000", upstreamId: "1000", ttftMs: 5000 } }
      ],
      overheadMs: 100
    };
    const measuredScenario: ScenarioScript = {
      ...scenario,
      systemPromptTokens: 900,
      events: [{ id: "u1", role: "user", text: "Hello", tokens: 100 }]
    };

    const timeline = buildTimeline({
      result: measuredResult,
      scenario: measuredScenario,
      cacheMode: "off",
      speed: 1
    });

    expect(timeline.events[0].prefillTokens).toBe(1000);
    expect(timeline.events[0].prefillMs).toBeCloseTo(5000);
    expect(timeline.events[0].ttftMs).toBeCloseTo(5000);
  });

  it("decodes assistant, thinking, and tool call tokens without prefilling their own output", () => {
    const generatedScenario: ScenarioScript = {
      ...scenario,
      systemPromptTokens: 1000,
      events: [
        { id: "u1", role: "user", text: "Start.", tokens: 25 },
        { id: "a1", role: "assistant", text: "I will think.", tokens: 50 },
        { id: "t1", role: "thinking", text: "Need a file read.", tokens: 30 },
        { id: "call1", role: "tool_call", text: "read_file('src/sim/timing.ts')", tokens: 20 }
      ]
    };

    const timeline = buildTimeline({
      result,
      scenario: generatedScenario,
      cacheMode: "runtime",
      speed: 1
    });

    expect(timeline.events[0]).toMatchObject({
      role: "user",
      prefillTokens: 1025,
      decodeMs: 0
    });

    for (const event of timeline.events.slice(1)) {
      expect(event.prefillTokens).toBe(0);
      expect(event.prefillMs).toBe(0);
      expect(event.decodeMs).toBeGreaterThan(0);
      expect(event.prefillDoneMs).toBe(event.startMs);
    }
  });

  it("waits for a tool result before prefilling the result into context", () => {
    const timeline = buildTimeline({
      result,
      scenario,
      cacheMode: "runtime",
      speed: 1
    });

    const toolCall = timeline.events[2];
    const toolResult = timeline.events[3];

    expect(toolCall.role).toBe("tool_call");
    expect(toolCall.prefillTokens).toBe(0);
    expect(toolCall.decodeMs).toBeGreaterThan(0);

    expect(toolResult.role).toBe("tool_result");
    expect(toolResult.toolLatencyMs).toBe(250);
    expect(toolResult.prefillTokens).toBe(1390);
    expect(toolResult.decodeMs).toBe(0);
    expect(toolResult.toolDoneMs).toBe(toolResult.startMs + 250);
    expect(toolResult.prefillDoneMs).toBe(toolResult.toolDoneMs + toolResult.prefillMs);
    expect(toolResult.ttftMs).toBe(toolResult.toolLatencyMs + toolResult.prefillMs);
  });

  it("models prefix cache hits, cache busts, tool latency, and cumulative context growth", () => {
    const timeline = buildTimeline({
      result,
      scenario,
      cacheMode: "runtime",
      speed: 1
    });

    expect(timeline.events).toHaveLength(5);
    expect(timeline.events[0].prefillTokens).toBe(4050);
    expect(timeline.events[1].prefillTokens).toBe(0);
    expect(timeline.events[3].prefillTokens).toBe(1390);
    expect(timeline.events[3].toolLatencyMs).toBe(250);
    expect(timeline.events.at(-1)?.contextAfter).toBe(5470);

    const summary = summarizeTimeline(timeline);
    expect(summary.totalTokens).toBe(5470);
    expect(summary.prefilledWithCache).toBe(5440);
    expect(summary.prefilledWithoutCache).toBeGreaterThan(summary.prefilledWithCache);
    expect(summary.cacheSavedRatio).toBeGreaterThan(0);
    expect(summary.wallTimeMs).toBeGreaterThan(0);
  });

  it("saves the full rebuilt context after a cache-bust prefill", () => {
    const cacheBustScenario: ScenarioScript = {
      ...scenario,
      systemPromptTokens: 1000,
      events: [
        { id: "u1", role: "user", text: "Start.", tokens: 100 },
        { id: "a1", role: "assistant", text: "Need a tool.", tokens: 100 },
        {
          id: "result1",
          role: "tool_result",
          text: "Large result.",
          tokens: 900,
          cacheBust: { retainedPrefixTokens: 1000 }
        },
        { id: "u2", role: "user", text: "Continue.", tokens: 50 }
      ]
    };

    const timeline = buildTimeline({
      result,
      scenario: cacheBustScenario,
      cacheMode: "runtime",
      speed: 1
    });

    expect(timeline.events[2]).toMatchObject({
      role: "tool_result",
      contextBefore: 1200,
      contextAfter: 2100,
      prefillTokens: 1100
    });
    expect(timeline.events[3]).toMatchObject({
      role: "user",
      cachedPrefixTokens: 2100,
      prefillTokens: 50
    });
  });

  it("counts tool-call decode tokens in generated summary throughput", () => {
    const toolCallScenario: ScenarioScript = {
      ...scenario,
      systemPromptTokens: 1000,
      events: [
        { id: "u1", role: "user", text: "Start.", tokens: 25 },
        { id: "call1", role: "tool_call", text: "read_file('src/sim/timing.ts')", tokens: 20 }
      ]
    };

    const timeline = buildTimeline({
      result,
      scenario: toolCallScenario,
      cacheMode: "runtime",
      speed: 1
    });

    expect(summarizeTimeline(timeline).generatedTokens).toBe(20);
  });

  it("moves to the next event at exact non-final boundaries", () => {
    const timeline = buildTimeline({
      result,
      scenario,
      cacheMode: "runtime",
      speed: 1
    });

    expect(activeEventAt(timeline, timeline.events[0].endMs).id).toBe(timeline.events[1].id);
  });

  it("keeps timeline timestamps canonical regardless of playback speed", () => {
    const normal = buildTimeline({ result, scenario, cacheMode: "runtime", speed: 1 });
    const fast = buildTimeline({ result, scenario, cacheMode: "runtime", speed: 8 });

    expect(fast.totalMs).toBeCloseTo(normal.totalMs);
    expect(fast.events.map((event) => event.endMs)).toEqual(normal.events.map((event) => event.endMs));
  });
});

describe("buildTimeline rate integration (Phase 1)", () => {
  it("integrates a long decode event's rate across the depth it traverses, not just its start depth", () => {
    // tg: 50 ms/token at depth 0, 100 ms/token at depth 10000, linear between.
    const longDecodeScenario: ScenarioScript = {
      ...scenario,
      systemPromptTokens: 0,
      events: [{ id: "a1", role: "assistant", text: "a very long generation", tokens: 10_000 }]
    };

    const timeline = buildTimeline({
      result,
      scenario: longDecodeScenario,
      cacheMode: "off",
      speed: 1
    });

    const event = timeline.events[0];
    // Exact trapezoidal integral over [0, 10000]: avg(50, 100) * 10000 = 750000ms.
    expect(event.decodeMs).toBeCloseTo(750_000);
    // Effective average rate = 10000 tokens / 750s = 13.33 tok/s.
    expect(event.tgRate).toBeCloseTo(10_000 / 750);

    // The naive point-sample-at-start-depth model (the old behavior) would
    // have priced the whole generation at the depth-0 rate (20 tok/s) and
    // never reflected that context grew across a decelerating curve.
    const naiveStartRate = interpolateRate(result.measurements, "tg", event.contextBefore);
    expect(naiveStartRate).toBe(20);
    expect(event.tgRate).toBeLessThan(naiveStartRate);
  });

  it("integrates a cache-bust partial reprefill over its true sub-range instead of the full end-depth rate", () => {
    // pp: 1.0 ms/token at depth 0, 2.0 ms/token at depth 10000, linear between.
    const cacheBustScenario: ScenarioScript = {
      ...scenario,
      systemPromptTokens: 0,
      events: [
        { id: "u1", role: "user", text: "fill context", tokens: 8000 },
        {
          id: "r1",
          role: "tool_result",
          text: "large tool result forcing a partial cache bust",
          tokens: 1000,
          cacheBust: { retainedPrefixTokens: 2000 }
        }
      ]
    };

    const timeline = buildTimeline({
      result,
      scenario: cacheBustScenario,
      cacheMode: "runtime",
      speed: 1
    });

    const bustEvent = timeline.events[1];
    expect(bustEvent.cachedPrefixTokens).toBe(2000);
    expect(bustEvent.prefillTokens).toBe(7000);

    // Exact integral over the reprocessed sub-range [2000, 9000]:
    // value(2000) = 1.2, value(9000) = 1.9, avg 1.55 * width 7000 = 10850ms,
    // plus the fixed overhead (100ms, no measured TTFT in this fixture).
    expect(bustEvent.prefillMs).toBeCloseTo(10_950);

    // The old point-sampled model priced the whole 7000-token sub-range at
    // the single end-depth (9000) rate — strictly slower/pricier than
    // correctly integrating the cheaper early portion of that sub-range.
    const naiveEndRate = interpolateRate(result.measurements, "pp", bustEvent.withoutCachePrefillTokens);
    const naivePrefillMs = (bustEvent.prefillTokens / naiveEndRate) * 1000 + (result.overheadMs ?? 0);
    expect(bustEvent.prefillMs).toBeLessThan(naivePrefillMs);
  });

  it("recalibrates the measured-TTFT path to exactly reproduce a cold (no-cache) prefill's measured TTFT", () => {
    const measuredResult: BenchmarkResult = {
      ...result,
      measurements: [
        { depth: 0, pp: 1000, tg: 20, source: { url: "https://example.com/d0", upstreamId: "0", ttftMs: 0 } },
        { depth: 1000, pp: 1000, tg: 20, source: { url: "https://example.com/d1000", upstreamId: "1000", ttftMs: 4000 } }
      ],
      overheadMs: 100
    };
    const coldScenario: ScenarioScript = {
      ...scenario,
      systemPromptTokens: 500,
      events: [{ id: "u1", role: "user", text: "hello", tokens: 300 }]
    };

    const timeline = buildTimeline({
      result: measuredResult,
      scenario: coldScenario,
      cacheMode: "off",
      speed: 1
    });

    const event = timeline.events[0];
    expect(event.cachedPrefixTokens).toBe(0);
    expect(event.prefillTokens).toBe(800);
    // Interpolated measured TTFT at depth 800 (between 0ms@0 and 4000ms@1000) is 3200ms.
    // With effectiveCachedPrefix === 0 the recalibrated overhead plus the
    // partial integral must reproduce that measured TTFT exactly.
    expect(event.prefillMs).toBeCloseTo(3200);
    expect(event.ttftMs).toBeCloseTo(3200);
  });

  it("still exactly reproduces measured TTFT when the implied overhead is negative", () => {
    const measuredResult: BenchmarkResult = {
      ...result,
      measurements: [
        { depth: 0, pp: 1000, tg: 20, source: { url: "https://example.com/d0", upstreamId: "0", ttftMs: 0 } },
        { depth: 500, pp: 1000, tg: 20, source: { url: "https://example.com/d500", upstreamId: "500", ttftMs: 490 } }
      ],
      overheadMs: 100
    };
    const coldScenario: ScenarioScript = {
      ...scenario,
      systemPromptTokens: 0,
      events: [{ id: "u1", role: "user", text: "hello", tokens: 500 }]
    };

    const timeline = buildTimeline({
      result: measuredResult,
      scenario: coldScenario,
      cacheMode: "off",
      speed: 1
    });

    const event = timeline.events[0];
    // Measured TTFT at depth 500 is 490ms, but the computed pp integral over
    // [0, 500] at a flat 1ms/token is 500ms — implying a negative (-10ms)
    // overhead for this entirely ordinary data point. Because this is a fully
    // cold prefill (effectiveCachedPrefix === 0), the recalibrated path must
    // still reproduce the exact measured TTFT rather than surface the higher
    // model-derived integral or fall back to the 100ms default overhead.
    expect(event.prefillMs).toBeCloseTo(490);
    expect(event.prefillMs).not.toBeCloseTo(500);
    expect(event.prefillMs).not.toBeCloseTo(600);
  });

  it("never produces NaN or a divide-by-zero for zero-token/instant events", () => {
    const instantScenario: ScenarioScript = {
      ...scenario,
      systemPromptTokens: 0,
      events: [
        { id: "u0", role: "user", text: "", tokens: 0 },
        { id: "a0", role: "assistant", text: "", tokens: 0 }
      ]
    };

    const timeline = buildTimeline({
      result,
      scenario: instantScenario,
      cacheMode: "off",
      speed: 1
    });

    for (const event of timeline.events) {
      expect(Number.isNaN(event.ppRate)).toBe(false);
      expect(Number.isNaN(event.tgRate)).toBe(false);
      expect(Number.isFinite(event.ppRate)).toBe(true);
      expect(Number.isFinite(event.tgRate)).toBe(true);
      expect(event.prefillMs).toBe(0);
      expect(event.decodeMs).toBe(0);
    }

    // Fallback rates still reflect the measured curve at the relevant depth.
    expect(timeline.events[0].ppRate).toBeCloseTo(1000);
    expect(timeline.events[0].tgRate).toBeCloseTo(20);
    expect(timeline.events[1].tgRate).toBeCloseTo(20);
  });

  it("flags a decode event as extrapolated when it ends past the last measured depth, even if it starts before it", () => {
    const straddlingScenario: ScenarioScript = {
      ...scenario,
      systemPromptTokens: 9000,
      events: [{ id: "a1", role: "assistant", text: "runs past the last measured depth", tokens: 2000 }]
    };

    const timeline = buildTimeline({
      result,
      scenario: straddlingScenario,
      cacheMode: "off",
      speed: 1
    });

    const event = timeline.events[0];
    expect(event.contextBefore).toBe(9000);
    expect(event.contextAfter).toBe(11_000);
    expect(event.contextAfter).toBeGreaterThan(result.measurements.at(-1)!.depth);
    expect(event.extrapolated).toBe(true);
  });
});
