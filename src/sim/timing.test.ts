import { describe, expect, it } from "vitest";
import {
  activeEventAt,
  buildTimeline,
  fitTimePerTokenLinear,
  integrateTimeRangeMs,
  msPerTokenRangeAt,
  rateConfidenceAt,
  summarizeTimeline
} from "./timing";
import type { BenchmarkMeasurement, BenchmarkResult, ScenarioScript } from "../types";

/**
 * Pre-Phase-1 baseline: point-samples the rate at a single depth instead of
 * integrating across the depth range traversed. Kept only as a comparison
 * fixture in these tests to demonstrate the new integral-based behavior
 * differs from (and improves on) it — not used anywhere in production code.
 */
function interpolateRate(measurements: BenchmarkMeasurement[], field: "pp" | "tg", depth: number): number {
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

describe("rateConfidenceAt", () => {
  it("is measured exactly at a submitted depth and interpolated strictly between two", () => {
    expect(rateConfidenceAt(result.measurements, 0)).toBe("measured");
    expect(rateConfidenceAt(result.measurements, 10_000)).toBe("measured");
    expect(rateConfidenceAt(result.measurements, 5000)).toBe("interpolated");
  });

  it("is extrapolated-fitted beyond the last measured depth when >= 2 measurements exist", () => {
    expect(rateConfidenceAt(result.measurements, 11_000)).toBe("extrapolated-fitted");
  });

  it("is extrapolated-unsupported below the first measured depth, even with >= 2 measurements (no backward fit)", () => {
    expect(rateConfidenceAt(result.measurements, -50)).toBe("extrapolated-unsupported");
  });

  it("is extrapolated-unsupported beyond a single submitted measurement, on either side", () => {
    const singlePoint: BenchmarkMeasurement[] = [{ depth: 1000, pp: 1000, tg: 20 }];
    expect(rateConfidenceAt(singlePoint, 1000)).toBe("measured");
    expect(rateConfidenceAt(singlePoint, 2000)).toBe("extrapolated-unsupported");
    expect(rateConfidenceAt(singlePoint, 0)).toBe("extrapolated-unsupported");
  });
});

describe("fitTimePerTokenLinear", () => {
  it("is undefined with fewer than two measurements", () => {
    expect(fitTimePerTokenLinear([{ depth: 0, pp: 1000, tg: 20 }], "tg")).toBeUndefined();
  });

  it("fits an exact line through perfectly monotonic degrading data", () => {
    // ms/token: 10 @ depth 0, 20 @ depth 1000, 30 @ depth 2000 -> exact line
    // msPerToken(d) = 10 + 0.01 * d (tg = 1000/msPerToken).
    const monotonic: BenchmarkMeasurement[] = [
      { depth: 0, pp: 1, tg: 100 },
      { depth: 1000, pp: 1, tg: 50 },
      { depth: 2000, pp: 1, tg: 1000 / 30 }
    ];

    const fit = fitTimePerTokenLinear(monotonic, "tg");
    expect(fit?.intercept).toBeCloseTo(10);
    expect(fit?.slope).toBeCloseTo(0.01);
  });

  it("clamps the slope to 0 (flat at the mean) for reversed/noisy data that would fit negative", () => {
    // ms/token: 30 @ depth 0, 10 @ depth 1000 -- msPerToken decreasing with
    // depth, which is physically implausible and must not extrapolate as such.
    const reversed: BenchmarkMeasurement[] = [
      { depth: 0, pp: 1, tg: 1000 / 30 },
      { depth: 1000, pp: 1, tg: 100 }
    ];

    const fit = fitTimePerTokenLinear(reversed, "tg");
    expect(fit?.slope).toBe(0);
    expect(fit?.intercept).toBeCloseTo(20);
  });
});

describe("msPerTokenRangeAt", () => {
  it("interpolates linearly in ms/token (not in rate) between measured depths, with canonical === optimistic", () => {
    // tg: depth 0 -> 20 tok/s (50 ms/token), depth 10000 -> 10 tok/s (100 ms/token).
    // Linear in ms/token gives 75 ms/token at the midpoint, NOT the
    // rate-domain harmonic-mean value that interpolateRate's naive
    // point-sample would otherwise imply.
    const tg = msPerTokenRangeAt(result.measurements, "tg", 5000);
    expect(tg.canonicalMs).toBeCloseTo(75);
    expect(tg.optimisticMs).toBeCloseTo(75);
    expect(tg.confidence).toBe("interpolated");

    const pp = msPerTokenRangeAt(result.measurements, "pp", 5000);
    expect(pp.canonicalMs).toBeCloseTo(1.5);
    expect(pp.optimisticMs).toBeCloseTo(1.5);
  });

  it("splits into a fitted canonical estimate and a flat-clamp optimistic bound beyond the last measured depth", () => {
    // Fitted line for tg ms/token: 50 @ depth 0, 100 @ depth 10000 -> slope 0.005, intercept 50.
    const beyond = msPerTokenRangeAt(result.measurements, "tg", 100_000);
    expect(beyond.confidence).toBe("extrapolated-fitted");
    expect(beyond.optimisticMs).toBeCloseTo(100); // old flat-clamp value, now the best case.
    expect(beyond.canonicalMs).toBeCloseTo(550); // 50 + 0.005 * 100000, realistic/slower.
    expect(beyond.canonicalMs).toBeGreaterThan(beyond.optimisticMs);
  });

  it("holds flat with no range for a single submitted measurement (extrapolated-unsupported)", () => {
    const singlePoint: BenchmarkMeasurement[] = [{ depth: 1000, pp: 1000, tg: 20 }];
    const range = msPerTokenRangeAt(singlePoint, "tg", 5000);
    expect(range.confidence).toBe("extrapolated-unsupported");
    expect(range.canonicalMs).toBeCloseTo(50);
    expect(range.optimisticMs).toBeCloseTo(50);
  });

  it("never lets the canonical estimate undershoot the last measured point for convex (accelerating-degradation) data", () => {
    // ms/token: 1 @ depth 0, 1 @ depth 1000, 10 @ depth 2000 (convex — most
    // degradation happens late). The unconstrained global least-squares line
    // dips to ~8.5 at depth 2000 (below the real 10), which would otherwise
    // invert the canonical (worse-case) vs. optimistic (flat-clamp) contract
    // just past the last measured point.
    const convex: BenchmarkMeasurement[] = [
      { depth: 0, pp: 1, tg: 1000 },
      { depth: 1000, pp: 1, tg: 1000 },
      { depth: 2000, pp: 1, tg: 100 }
    ];

    const atLast = msPerTokenRangeAt(convex, "tg", 2000);
    expect(atLast.canonicalMs).toBeCloseTo(10);

    const justBeyond = msPerTokenRangeAt(convex, "tg", 2001);
    expect(justBeyond.canonicalMs).toBeGreaterThanOrEqual(justBeyond.optimisticMs);
  });

  it("holds flat with no range before the first measured depth even with >= 2 measurements (no grounded backward trend)", () => {
    // A steep forward trend (10ms @ depth 9000 -> 1000ms @ depth 10000)
    // extrapolated backward across the large unmeasured gap to depth 0 would
    // go deeply negative and floor to 0 if naively applied in reverse.
    const steep: BenchmarkMeasurement[] = [
      { depth: 9000, pp: 100, tg: 100 },
      { depth: 10_000, pp: 1, tg: 100 }
    ];

    const range = msPerTokenRangeAt(steep, "pp", 0);
    expect(range.confidence).toBe("extrapolated-unsupported");
    expect(range.canonicalMs).toBeCloseTo(10);
    expect(range.optimisticMs).toBeCloseTo(10);
  });

  it("reports zero stddevMs by default and a nonzero one when a measurement supplies tgStddev", () => {
    expect(msPerTokenRangeAt(result.measurements, "tg", 5000).stddevMs).toBe(0);

    // tg: 20 +/- 2 @ depth 0 -> 50ms/token, stddev 5ms; 10 +/- 1 @ depth 10000
    // -> 100ms/token, stddev 10ms. Midpoint (depth 5000) interpolates to 7.5ms.
    const withStddev: BenchmarkMeasurement[] = [
      { depth: 0, pp: 1000, tg: 20, tgStddev: 2 },
      { depth: 10_000, pp: 500, tg: 10, tgStddev: 1 }
    ];
    expect(msPerTokenRangeAt(withStddev, "tg", 5000).stddevMs).toBeCloseTo(7.5);
  });
});

describe("integrateTimeRangeMs", () => {
  it("returns 0 for an empty or inverted range", () => {
    expect(integrateTimeRangeMs(result.measurements, "tg", 100, 100)).toMatchObject({
      canonicalMs: 0,
      optimisticMs: 0
    });
    expect(integrateTimeRangeMs(result.measurements, "tg", 200, 100)).toMatchObject({
      canonicalMs: 0,
      optimisticMs: 0
    });
  });

  it("computes the exact trapezoidal integral across a single interior segment, with canonical === optimistic", () => {
    // tg ms/token: 50 at depth 0, 100 at depth 10000, linear in between
    // (value(d) = 50 + 0.005 * d).
    // Over [2000, 9000]: value(2000) = 60, value(9000) = 95, avg 77.5 * width 7000 = 542500.
    const range = integrateTimeRangeMs(result.measurements, "tg", 2000, 9000);
    expect(range.canonicalMs).toBeCloseTo(542_500);
    expect(range.optimisticMs).toBeCloseTo(542_500);
    expect(range.confidence).toBe("interpolated");
  });

  it("splits beyond the last measured depth into a fitted canonical integral and a flat-clamp optimistic one", () => {
    // Optimistic: flat 100 ms/token * 1000 width = 100000 (unchanged from Phase 1).
    // Canonical: closed-form integral of the fitted line (intercept 50, slope 0.005)
    // over [10000, 11000] = 50*1000 + 0.005*(11000^2-10000^2)/2 = 102500.
    const range = integrateTimeRangeMs(result.measurements, "tg", 10_000, 11_000);
    expect(range.optimisticMs).toBeCloseTo(100_000);
    expect(range.canonicalMs).toBeCloseTo(102_500);
    expect(range.confidence).toBe("extrapolated-fitted");
  });

  it("splits a range that straddles the fitted-extrapolation boundary and the measured span, reporting the worst confidence", () => {
    // [8000, 12000]: interior [8000,10000] contributes 190000 to both bounds.
    // Beyond [10000,12000]: optimistic flat 100*2000=200000; canonical fitted
    // integral 50*2000 + 0.005*(12000^2-10000^2)/2 = 210000.
    const range = integrateTimeRangeMs(result.measurements, "tg", 8000, 12_000);
    expect(range.optimisticMs).toBeCloseTo(390_000);
    expect(range.canonicalMs).toBeCloseTo(400_000);
    expect(range.confidence).toBe("extrapolated-fitted");
  });

  it("reports extrapolated-unsupported and a flat integral on both bounds for a single measurement", () => {
    const singlePoint: BenchmarkMeasurement[] = [{ depth: 1000, pp: 1000, tg: 20 }];
    const range = integrateTimeRangeMs(singlePoint, "tg", 1000, 2000);
    expect(range.canonicalMs).toBeCloseTo(50_000);
    expect(range.optimisticMs).toBeCloseTo(50_000);
    expect(range.confidence).toBe("extrapolated-unsupported");
  });

  it("is zero when no measurement supplies a stddev (purely additive, no behavior change by default)", () => {
    const range = integrateTimeRangeMs(result.measurements, "tg", 2000, 9000);
    expect(range.stddevMs).toBe(0);
  });

  it("rejects non-finite bounds with a safe zero result and never tags it interpolated (A2)", () => {
    for (const [from, to] of [
      [Number.NaN, 5000],
      [0, Number.NaN],
      [0, Number.POSITIVE_INFINITY],
      [Number.NEGATIVE_INFINITY, 5000]
    ] as const) {
      const range = integrateTimeRangeMs(result.measurements, "tg", from, to);
      expect(range.canonicalMs).toBe(0);
      expect(range.optimisticMs).toBe(0);
      expect(range.stddevMs).toBe(0);
      expect(range.confidence).not.toBe("interpolated");
      expect(range.confidence).toBe("extrapolated-unsupported");
    }
  });

  it("clamps a negative lower bound to zero rather than inflating the integral with phantom width (A2)", () => {
    // [-5000, 5000] must integrate the same as [0, 5000]: negative depth is not
    // physical and must not add a pre-zero rectangle.
    const clamped = integrateTimeRangeMs(result.measurements, "tg", -5000, 5000);
    const fromZero = integrateTimeRangeMs(result.measurements, "tg", 0, 5000);
    expect(clamped.canonicalMs).toBeCloseTo(fromZero.canonicalMs);
    expect(clamped.optimisticMs).toBeCloseTo(fromZero.optimisticMs);
  });

  it("widens by the trapezoidal integral of the interpolated tgStddev when contributors supply it", () => {
    // tg: 20 tok/s +/- 2 @ depth 0 -> 50 ms/token, stddev = 1000*2/400 = 5ms.
    // tg: 10 tok/s +/- 1 @ depth 10000 -> 100 ms/token, stddev = 1000*1/100 = 10ms.
    // Over [0, 10000]: stddev interpolates linearly 5 -> 10, trapezoid avg 7.5 * 10000 = 75000.
    const withStddev: BenchmarkMeasurement[] = [
      { depth: 0, pp: 1000, tg: 20, tgStddev: 2 },
      { depth: 10_000, pp: 500, tg: 10, tgStddev: 1 }
    ];
    const range = integrateTimeRangeMs(withStddev, "tg", 0, 10_000);
    expect(range.stddevMs).toBeCloseTo(75_000);
  });
});

describe("buildTimeline", () => {
  it("uses measured upstream TTFT for prompt prefill when available", () => {
    const measuredResult: BenchmarkResult = {
      ...result,
      measurements: [
        { depth: 0, pp: 1000, tg: 20, source: { url: "https://example.com/depth-0", upstreamId: "0", ttftMs: 0 } },
        {
          depth: 1000,
          pp: 1000,
          tg: 20,
          source: { url: "https://example.com/depth-1000", upstreamId: "1000", ttftMs: 5000 }
        }
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
      cacheMode: "off"
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
      cacheMode: "runtime"
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
      cacheMode: "runtime"
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
      cacheMode: "runtime"
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
      cacheMode: "runtime"
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
      cacheMode: "runtime"
    });

    expect(summarizeTimeline(timeline).generatedTokens).toBe(20);
  });

  it("throws a clear error for a scenario with no events instead of building a timeline activeEventAt cannot consume (A2)", () => {
    const emptyScenario: ScenarioScript = { ...scenario, events: [] };
    expect(() => buildTimeline({ result, scenario: emptyScenario, cacheMode: "runtime" })).toThrow(/no events/);
  });

  it("moves to the next event at exact non-final boundaries", () => {
    const timeline = buildTimeline({
      result,
      scenario,
      cacheMode: "runtime"
    });

    expect(activeEventAt(timeline, timeline.events[0].endMs).id).toBe(timeline.events[1].id);
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
      cacheMode: "off"
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
      cacheMode: "runtime"
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
        {
          depth: 1000,
          pp: 1000,
          tg: 20,
          source: { url: "https://example.com/d1000", upstreamId: "1000", ttftMs: 4000 }
        }
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
      cacheMode: "off"
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
      cacheMode: "off"
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
      cacheMode: "off"
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

  it("grows a cold prefill beyond the last measured TTFT depth with prompt size instead of collapsing to the flat TTFT (A1)", () => {
    const measuredResult: BenchmarkResult = {
      ...result,
      measurements: [
        { depth: 0, pp: 1000, tg: 20, source: { url: "https://example.com/d0", upstreamId: "0", ttftMs: 0 } },
        {
          depth: 1000,
          pp: 1000,
          tg: 20,
          source: { url: "https://example.com/d1000", upstreamId: "1000", ttftMs: 1000 }
        }
      ],
      overheadMs: 100
    };
    const coldPrefill = (tokens: number): ScenarioScript => ({
      ...scenario,
      systemPromptTokens: 0,
      events: [{ id: "u1", role: "user", text: "hello", tokens }]
    });

    // Both prompts run well beyond the last TTFT-bearing depth (1000). The old
    // flat-clamp bug returned the depth-1000 TTFT (1000ms) for every prompt
    // size; the model integral must instead grow with the prompt.
    const small = buildTimeline({ result: measuredResult, scenario: coldPrefill(5000), cacheMode: "off" }).events[0];
    const large = buildTimeline({ result: measuredResult, scenario: coldPrefill(20_000), cacheMode: "off" }).events[0];

    expect(large.prefillMs).toBeGreaterThan(small.prefillMs);
    expect(small.prefillMs).toBeGreaterThan(1000);
    // pp is flat at 1ms/token and the depth-1000 TTFT (1000ms) exactly equals
    // the integral to 1000, so the implied launch overhead is 0. Beyond the
    // measured range prefill continues that anchor: overhead (0) + integral, so
    // exactly `tokens` ms -- continuous with the 1000ms measured TTFT.
    expect(small.prefillMs).toBeCloseTo(5000);
    expect(large.prefillMs).toBeCloseTo(20_000);
  });

  it("keeps a cold prefill continuous and monotonic across the last measured TTFT depth when the measured TTFT exceeds the integral (A1 review regression)", () => {
    // Here the depth-1000 TTFT is 3000ms while the pp integral to 1000 is only
    // 1000ms -- a real +2000ms launch overhead the integral doesn't capture.
    // The review found that returning the bare integral past the boundary made a
    // one-token-larger prompt predict a FASTER prefill (a downward cliff below
    // the measured TTFT). The anchor must carry that overhead forward instead.
    const withOverhead: BenchmarkResult = {
      ...result,
      measurements: [
        { depth: 0, pp: 1000, tg: 20, source: { url: "https://example.com/d0", upstreamId: "0", ttftMs: 0 } },
        {
          depth: 1000,
          pp: 1000,
          tg: 20,
          source: { url: "https://example.com/d1000", upstreamId: "1000", ttftMs: 3000 }
        }
      ],
      overheadMs: 100
    };
    const coldPrefill = (tokens: number): ScenarioScript => ({
      ...scenario,
      systemPromptTokens: 0,
      events: [{ id: "u1", role: "user", text: "hello", tokens }]
    });
    const at = buildTimeline({ result: withOverhead, scenario: coldPrefill(1000), cacheMode: "off" }).events[0];
    const justPast = buildTimeline({ result: withOverhead, scenario: coldPrefill(1001), cacheMode: "off" }).events[0];
    const wayPast = buildTimeline({ result: withOverhead, scenario: coldPrefill(5000), cacheMode: "off" }).events[0];

    expect(at.prefillMs).toBeCloseTo(3000); // exact measured TTFT at the boundary
    expect(justPast.prefillMs).toBeGreaterThanOrEqual(at.prefillMs); // no cliff
    expect(justPast.prefillMs).toBeCloseTo(3001); // overhead 2000 + integral 1001
    expect(wayPast.prefillMs).toBeCloseTo(7000); // overhead 2000 + integral 5000
    expect(wayPast.prefillMs).toBeGreaterThan(justPast.prefillMs); // monotonic
  });

  it("never lets a cache-shortened prefill collapse below its real integrated cost when the implied TTFT overhead is negative (A1)", () => {
    const measuredResult: BenchmarkResult = {
      ...result,
      measurements: [
        { depth: 0, pp: 1000, tg: 20, source: { url: "https://example.com/d0", upstreamId: "0", ttftMs: 0 } },
        { depth: 500, pp: 1000, tg: 20, source: { url: "https://example.com/d500", upstreamId: "500", ttftMs: 490 } }
      ],
      overheadMs: 100
    };
    // withoutCachePrefillTokens lands exactly on the last TTFT depth (500), so
    // measuredTtftMs is defined (490ms) and the implied overhead is negative
    // (490 - 500ms integral = -10ms). The cacheBust retains 200 prefix tokens,
    // so only the [200, 500] sub-range (300ms at flat 1ms/token) is reprocessed.
    const cacheShortenedScenario: ScenarioScript = {
      ...scenario,
      systemPromptTokens: 200,
      events: [
        { id: "u1", role: "user", text: "reprocess a sub-range", tokens: 300, cacheBust: { retainedPrefixTokens: 200 } }
      ]
    };

    const event = buildTimeline({ result: measuredResult, scenario: cacheShortenedScenario, cacheMode: "on" })
      .events[0];

    expect(event.cachedPrefixTokens).toBe(200);
    expect(event.prefillTokens).toBe(300);
    // The negative implied overhead must be clamped to >= 0 for the shortened
    // prefill, so prefillMs never dips below the real 300ms integrated cost.
    expect(event.prefillMs).toBeGreaterThanOrEqual(300);
    expect(event.prefillMs).toBeCloseTo(300);
  });

  it("never produces an infinite ppRate when prefilling well before the first measured depth over a steep trend", () => {
    // Measurements only cover [9000, 10000], with a steep pp degradation
    // (100 tok/s -> 1 tok/s). Prefilling 100 tokens starting at depth 0 is
    // entirely below the first measured depth: extrapolating the steep
    // forward trend backward across that gap used to floor the canonical
    // integral to 0, sending ppRate = tokens / (0 / 1000) to Infinity.
    const steepResult: BenchmarkResult = {
      ...result,
      measurements: [
        { depth: 9000, pp: 100, tg: 100 },
        { depth: 10_000, pp: 1, tg: 100 }
      ]
    };
    const coldStartScenario: ScenarioScript = {
      ...scenario,
      systemPromptTokens: 0,
      events: [{ id: "u1", role: "user", text: "hello", tokens: 100 }]
    };

    const timeline = buildTimeline({
      result: steepResult,
      scenario: coldStartScenario,
      cacheMode: "off"
    });

    const event = timeline.events[0];
    expect(event.prefillMs).toBeGreaterThan(0);
    expect(Number.isFinite(event.ppRate)).toBe(true);
    expect(event.ppRate).toBeGreaterThan(0);
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
      cacheMode: "off"
    });

    const event = timeline.events[0];
    expect(event.contextBefore).toBe(9000);
    expect(event.contextAfter).toBe(11_000);
    expect(event.contextAfter).toBeGreaterThan(result.measurements.at(-1)!.depth);
    expect(event.extrapolated).toBe(true);
  });
});

describe("buildTimeline confidence tiers and ranges (Phase 2)", () => {
  it("threads measured/interpolated confidence and a zero-width range for in-range events", () => {
    const timeline = buildTimeline({
      result,
      scenario,
      cacheMode: "runtime"
    });

    const firstEvent = timeline.events[0];
    expect(firstEvent.ppConfidence).toBe("interpolated");
    expect(firstEvent.extrapolated).toBe(false);
    expect(firstEvent.prefillRangeMs.min).toBeCloseTo(firstEvent.prefillRangeMs.max);
    expect(firstEvent.prefillRangeMs.max).toBeCloseTo(firstEvent.prefillMs);
  });

  it("drives prefillMs/decodeMs from the canonical (not optimistic) estimate and ranges from both bounds beyond the measured depth", () => {
    // tg: 50 ms/token @ depth 0, 100 ms/token @ depth 10000, linear between.
    const straddlingScenario: ScenarioScript = {
      ...scenario,
      systemPromptTokens: 9000,
      events: [{ id: "a1", role: "assistant", text: "runs past the last measured depth", tokens: 2000 }]
    };

    const timeline = buildTimeline({
      result,
      scenario: straddlingScenario,
      cacheMode: "off"
    });

    const event = timeline.events[0];
    expect(event.tgConfidence).toBe("extrapolated-fitted");
    expect(event.extrapolated).toBe(true);

    // Interior [9000,10000] contributes 97500 to both bounds (avg(95,100)*1000).
    // Beyond [10000,11000]: optimistic flat 100*1000=100000; canonical fitted
    // integral 50*1000 + 0.005*(11000^2-10000^2)/2 = 102500.
    expect(event.decodeRangeMs.min).toBeCloseTo(197_500);
    expect(event.decodeRangeMs.max).toBeCloseTo(200_000);
    // decodeMs (drives playback) uses the canonical, worse-case bound.
    expect(event.decodeMs).toBeCloseTo(200_000);
    expect(event.decodeMs).toBeCloseTo(event.decodeRangeMs.max);
  });

  it("reports extrapolated-unsupported confidence for a single-measurement benchmark result beyond its only point", () => {
    const singlePointResult: BenchmarkResult = {
      ...result,
      measurements: [{ depth: 0, pp: 1000, tg: 20 }]
    };
    const singleEventScenario: ScenarioScript = {
      ...scenario,
      systemPromptTokens: 0,
      events: [{ id: "a1", role: "assistant", text: "generate", tokens: 5000 }]
    };

    const timeline = buildTimeline({
      result: singlePointResult,
      scenario: singleEventScenario,
      cacheMode: "off"
    });

    const event = timeline.events[0];
    expect(event.tgConfidence).toBe("extrapolated-unsupported");
    expect(event.extrapolated).toBe(true);
    // No real basis for a range with only one submitted measurement: both
    // bounds hold flat at the same value.
    expect(event.decodeRangeMs.min).toBeCloseTo(event.decodeRangeMs.max);
    expect(event.decodeMs).toBeCloseTo(event.decodeRangeMs.max);
  });
});

describe("summarizeTimeline wall-time range and non-measured share (Phase 3)", () => {
  it("collapses wallTimeRangeMs to a single point equal to wallTimeMs when there is no uncertainty anywhere", () => {
    const timeline = buildTimeline({
      result,
      scenario,
      cacheMode: "runtime"
    });

    const summary = summarizeTimeline(timeline);
    // The fixture scenario stays entirely within [0, 10000] (the measured
    // range), so every event is measured/interpolated: no range width.
    expect(timeline.events.every((event) => event.contextAfter <= 10_000)).toBe(true);
    expect(summary.wallTimeRangeMs.min).toBeCloseTo(summary.wallTimeMs);
    expect(summary.wallTimeRangeMs.max).toBeCloseTo(summary.wallTimeMs);
    expect(summary.nonMeasuredTimeShare).toBe(0);
  });

  it("widens wallTimeRangeMs and reports a nonzero nonMeasuredTimeShare when part of the run runs past the measured depth", () => {
    // First event stays within the measured range (interpolated); second
    // event's decode straddles and runs well past the last measured depth
    // (10000), landing in extrapolated-fitted territory.
    const straddlingScenario: ScenarioScript = {
      ...scenario,
      systemPromptTokens: 8000,
      events: [
        { id: "u1", role: "user", text: "short prompt", tokens: 200 },
        { id: "a1", role: "assistant", text: "long generation past the measured depth", tokens: 4000 }
      ]
    };

    const timeline = buildTimeline({
      result,
      scenario: straddlingScenario,
      cacheMode: "off"
    });

    const summary = summarizeTimeline(timeline);

    // wallTimeMs is always the max (canonical/worse-case) bound.
    expect(summary.wallTimeRangeMs.max).toBeCloseTo(summary.wallTimeMs);
    // The extrapolated decode event widens the range: canonical (fitted,
    // slower) total exceeds the optimistic (flat-clamp) total.
    expect(summary.wallTimeRangeMs.min).toBeLessThan(summary.wallTimeRangeMs.max);

    // Only the second (decode) event is non-measured; its share of total
    // wall time, weighted by ms, should be strictly between 0 and 1 and
    // should match a direct recomputation from the event data.
    expect(summary.nonMeasuredTimeShare).toBeGreaterThan(0);
    expect(summary.nonMeasuredTimeShare).toBeLessThan(1);

    const decodeEvent = timeline.events[1];
    expect(decodeEvent.tgConfidence).toBe("extrapolated-fitted");
    const expectedShare = decodeEvent.decodeMs / summary.wallTimeMs;
    expect(summary.nonMeasuredTimeShare).toBeCloseTo(expectedShare);
  });

  it("widens wallTimeRangeMs beyond the canonical/optimistic split when measurements carry a stddev, even fully within the measured range", () => {
    const measurementsWithStddev: BenchmarkMeasurement[] = [
      { depth: 0, pp: 1000, tg: 20, tgStddev: 4, ppStddev: 40 },
      { depth: 10_000, pp: 500, tg: 10, tgStddev: 2, ppStddev: 20 }
    ];
    const resultWithStddev: BenchmarkResult = { ...result, measurements: measurementsWithStddev };

    const plainTimeline = buildTimeline({ result, scenario, cacheMode: "runtime" });
    const plainSummary = summarizeTimeline(plainTimeline);

    const stddevTimeline = buildTimeline({ result: resultWithStddev, scenario, cacheMode: "runtime" });
    const stddevSummary = summarizeTimeline(stddevTimeline);

    // Entirely within the measured range (as asserted by the no-uncertainty
    // test above), so without stddev the range collapses to a point.
    expect(plainSummary.wallTimeRangeMs.max - plainSummary.wallTimeRangeMs.min).toBeCloseTo(0);
    // With stddev supplied, the range widens on both ends around the same
    // point estimate, purely additively.
    expect(stddevSummary.wallTimeMs).toBeCloseTo(plainSummary.wallTimeMs);
    expect(stddevSummary.wallTimeRangeMs.min).toBeLessThan(stddevSummary.wallTimeMs);
    expect(stddevSummary.wallTimeRangeMs.max).toBeGreaterThan(stddevSummary.wallTimeMs);
  });
});

describe("buildTimeline cache_bust marker events (T1)", () => {
  it("treats a valid zero-token standalone cache_bust event as a pure no-op", () => {
    const withoutMarker: ScenarioScript = {
      ...scenario,
      systemPromptTokens: 1000,
      events: [
        { id: "u1", role: "user", text: "Start.", tokens: 200 },
        { id: "a1", role: "assistant", text: "Reply.", tokens: 60 }
      ]
    };
    const withMarker: ScenarioScript = {
      ...scenario,
      systemPromptTokens: 1000,
      events: [
        { id: "u1", role: "user", text: "Start.", tokens: 200 },
        { id: "marker", role: "cache_bust", text: "cache invalidated here", tokens: 0 },
        { id: "a1", role: "assistant", text: "Reply.", tokens: 60 }
      ]
    };

    const baseline = buildTimeline({ result, scenario: withoutMarker, cacheMode: "runtime" });
    const withMarkerTimeline = buildTimeline({ result, scenario: withMarker, cacheMode: "runtime" });

    const markerEvent = withMarkerTimeline.events[1];
    expect(markerEvent.role).toBe("cache_bust");
    expect(markerEvent.contextBefore).toBe(markerEvent.contextAfter);
    expect(markerEvent.prefillTokens).toBe(0);
    expect(markerEvent.prefillMs).toBe(0);
    expect(markerEvent.decodeMs).toBe(0);
    expect(markerEvent.phase).toBe("instant");

    // Inserting the marker changes nothing about the surrounding timeline:
    // the final assistant event's context/timing is identical either way.
    const baselineFinal = baseline.events.at(-1)!;
    const markedFinal = withMarkerTimeline.events.at(-1)!;
    expect(markedFinal.contextBefore).toBe(baselineFinal.contextBefore);
    expect(markedFinal.contextAfter).toBe(baselineFinal.contextAfter);
    expect(markedFinal.decodeMs).toBeCloseTo(baselineFinal.decodeMs);
    expect(withMarkerTimeline.totalMs).toBeCloseTo(baseline.totalMs);
  });

  it("never inflates contextDepth/cachedPrefixTokens even for a malformed cache_bust event that bypasses schema validation with nonzero tokens (old bug proof)", () => {
    // scenarioEventSchema now rejects this at the data layer (see the schema
    // test below); this proves buildTimeline itself no longer trusts a
    // standalone cache_bust event's token count even if one slips through.
    const malformedScenario: ScenarioScript = {
      ...scenario,
      systemPromptTokens: 1000,
      events: [
        { id: "u1", role: "user", text: "Start.", tokens: 200 },
        { id: "marker", role: "cache_bust", text: "should be a no-op", tokens: 5000 },
        { id: "a1", role: "assistant", text: "Reply.", tokens: 60 }
      ]
    };
    const noopEquivalentScenario: ScenarioScript = {
      ...scenario,
      systemPromptTokens: 1000,
      events: [
        { id: "u1", role: "user", text: "Start.", tokens: 200 },
        { id: "marker", role: "cache_bust", text: "should be a no-op", tokens: 0 },
        { id: "a1", role: "assistant", text: "Reply.", tokens: 60 }
      ]
    };

    const malformed = buildTimeline({ result, scenario: malformedScenario, cacheMode: "runtime" });
    const noopEquivalent = buildTimeline({ result, scenario: noopEquivalentScenario, cacheMode: "runtime" });

    const markerEvent = malformed.events[1];
    // The old bug: contextDepth += event.tokens unconditionally, so a
    // nonzero-token cache_bust event would inflate context depth by 5000
    // while contributing zero prefill/decode cost. Confirm that no longer
    // happens: the marker's own tokens never reach contextDepth.
    expect(markerEvent.contextAfter).toBe(markerEvent.contextBefore);
    expect(markerEvent.prefillMs).toBe(0);
    expect(markerEvent.decodeMs).toBe(0);

    // The malformed (nonzero-token) event produces the exact same
    // context-depth/timing effect as its zero-token no-op equivalent.
    expect(malformed.events.at(-1)!.contextAfter).toBe(noopEquivalent.events.at(-1)!.contextAfter);
    expect(malformed.totalMs).toBeCloseTo(noopEquivalent.totalMs);
  });

  it("never adds wall-clock time for a malformed cache_bust event that bypasses schema validation with nonzero toolLatencyMs", () => {
    const malformedScenario: ScenarioScript = {
      ...scenario,
      systemPromptTokens: 1000,
      events: [
        { id: "u1", role: "user", text: "Start.", tokens: 200 },
        { id: "marker", role: "cache_bust", text: "should be a no-op", tokens: 0, toolLatencyMs: 5000 },
        { id: "a1", role: "assistant", text: "Reply.", tokens: 60 }
      ]
    };
    const noopEquivalentScenario: ScenarioScript = {
      ...scenario,
      systemPromptTokens: 1000,
      events: [
        { id: "u1", role: "user", text: "Start.", tokens: 200 },
        { id: "marker", role: "cache_bust", text: "should be a no-op", tokens: 0 },
        { id: "a1", role: "assistant", text: "Reply.", tokens: 60 }
      ]
    };

    const malformed = buildTimeline({ result, scenario: malformedScenario, cacheMode: "runtime" });
    const noopEquivalent = buildTimeline({ result, scenario: noopEquivalentScenario, cacheMode: "runtime" });

    const markerEvent = malformed.events[1];
    expect(markerEvent.toolLatencyMs).toBe(0);
    expect(markerEvent.phase).toBe("instant");
    expect(malformed.totalMs).toBeCloseTo(noopEquivalent.totalMs);
  });

  it("never reports a bogus cachedPrefixTokens for a malformed cache_bust event that bypasses schema validation with a cacheBust property", () => {
    const malformedScenario: ScenarioScript = {
      ...scenario,
      systemPromptTokens: 1000,
      events: [
        { id: "u1", role: "user", text: "Start.", tokens: 200 },
        {
          id: "marker",
          role: "cache_bust",
          text: "should be a no-op",
          tokens: 0,
          cacheBust: { retainedPrefixTokens: 999999 }
        },
        { id: "a1", role: "assistant", text: "Reply.", tokens: 60 }
      ]
    };
    const noopEquivalentScenario: ScenarioScript = {
      ...scenario,
      systemPromptTokens: 1000,
      events: [
        { id: "u1", role: "user", text: "Start.", tokens: 200 },
        { id: "marker", role: "cache_bust", text: "should be a no-op", tokens: 0 },
        { id: "a1", role: "assistant", text: "Reply.", tokens: 60 }
      ]
    };

    const malformed = buildTimeline({ result, scenario: malformedScenario, cacheMode: "runtime" });
    const noopEquivalent = buildTimeline({ result, scenario: noopEquivalentScenario, cacheMode: "runtime" });

    const markerEvent = malformed.events[1];
    expect(markerEvent.cachedPrefixTokens).toBe(noopEquivalent.events[1].cachedPrefixTokens);
    expect(malformed.totalMs).toBeCloseTo(noopEquivalent.totalMs);
  });
});

describe("TTFT depth-convention normalization (T3)", () => {
  it("looks up TTFT directly by measurement.depth when benchmark.ppTokens is absent (oMLX convention)", () => {
    // oMLX imports never set benchmark.ppTokens: measurement.depth already
    // is the full prompt length the ttftMs reading was taken at, so the
    // lookup must use it unshifted.
    const omlxStyleResult: BenchmarkResult = {
      ...result,
      measurements: [
        { depth: 0, pp: 1000, tg: 20, source: { url: "https://example.com/d0", upstreamId: "0", ttftMs: 0 } },
        {
          depth: 2000,
          pp: 1000,
          tg: 20,
          source: { url: "https://example.com/d2000", upstreamId: "2000", ttftMs: 6000 }
        }
      ]
    };
    const scenarioAt800: ScenarioScript = {
      ...scenario,
      systemPromptTokens: 0,
      events: [{ id: "u1", role: "user", text: "hello", tokens: 800 }]
    };

    const timeline = buildTimeline({ result: omlxStyleResult, scenario: scenarioAt800, cacheMode: "off" });
    const event = timeline.events[0];

    // Linear interpolation between (0, 0ms) and (2000, 6000ms) at depth 800
    // is 2400ms. pp is flat 1ms/token across [0, 2000] so the full pp
    // integral over [0, 800] is exactly 800ms, making impliedOverheadMs
    // 1600ms and reproducing this interpolated value exactly.
    expect(event.prefillMs).toBeCloseTo(2400);
    expect(event.ttftMs).toBeCloseTo(2400);
  });

  it("shifts measurement.depth forward by benchmark.ppTokens before interpolating TTFT (llama-benchy convention)", () => {
    // llama-benchy-style sweeps report `depth` as the context ALREADY
    // present before the pp-test's own chunk, with ttftMs measured for
    // `depth + ppTokens` total tokens -- the same convention
    // ttftMismatchesPromptRate in catalogQuality.ts already checks for.
    const llamaBenchyStyleResult: BenchmarkResult = {
      ...result,
      benchmark: { ppTokens: 1000 },
      measurements: [
        { depth: 0, pp: 1000, tg: 20, source: { url: "https://example.com/d0", upstreamId: "0", ttftMs: 500 } },
        {
          depth: 1000,
          pp: 1000,
          tg: 20,
          source: { url: "https://example.com/d1000", upstreamId: "1000", ttftMs: 1500 }
        }
      ]
    };
    // Total prompt tokens actually processed: 1500, which sits at effective
    // depth 1500 on the (depth + ppTokens) axis -- halfway between the
    // shifted points at 1000 (ttft 500ms) and 2000 (ttft 1500ms).
    const scenarioAt1500: ScenarioScript = {
      ...scenario,
      systemPromptTokens: 0,
      events: [{ id: "u1", role: "user", text: "hello", tokens: 1500 }]
    };

    const timeline = buildTimeline({ result: llamaBenchyStyleResult, scenario: scenarioAt1500, cacheMode: "off" });
    const event = timeline.events[0];

    // Correctly normalized: interpolates to 1000ms (halfway between 500ms
    // and 1500ms on the shifted axis), reproduced exactly since the pp
    // curve is flat at 1ms/token across the whole span.
    expect(event.prefillMs).toBeCloseTo(1000);
    expect(event.ttftMs).toBeCloseTo(1000);

    // The old (unnormalized) behavior would have looked up depth 1500
    // directly against the raw (unshifted) measurement depths [0, 1000],
    // fallen past the last one, and flat-clamped to the last raw ttftMs
    // (1500ms) instead -- a materially different, wrong answer.
    expect(event.prefillMs).not.toBeCloseTo(1500);
  });
});

describe("buildTimeline additional coverage (audit item 4)", () => {
  it("asserts the extrapolated flag directly: false when both rates are measured/interpolated, true when only one is extrapolated", () => {
    const withinRange = buildTimeline({ result, scenario, cacheMode: "runtime" });
    expect(withinRange.events.every((event) => event.extrapolated === false)).toBe(true);

    // ppConfidence stays interpolated (contextBefore/withoutCachePrefillTokens
    // both within [0, 10000]) while tgConfidence for the same event is never
    // evaluated (it's a prefill-only user event), so use a mixed scenario:
    // a decode event whose start is within range but whose end straddles
    // past the last measured depth -- tgConfidence becomes extrapolated
    // while nothing else in the timeline is.
    const mixedScenario: ScenarioScript = {
      ...scenario,
      systemPromptTokens: 9500,
      events: [{ id: "a1", role: "assistant", text: "straddles the boundary", tokens: 1000 }]
    };
    const mixed = buildTimeline({ result, scenario: mixedScenario, cacheMode: "off" });
    const mixedEvent = mixed.events[0];
    expect(mixedEvent.ppConfidence).not.toBe("extrapolated-fitted");
    expect(mixedEvent.ppConfidence).not.toBe("extrapolated-unsupported");
    expect(mixedEvent.tgConfidence).toBe("extrapolated-fitted");
    expect(mixedEvent.extrapolated).toBe(true);
  });

  it("interpolates linearly between two measured TTFT points at a non-endpoint depth", () => {
    const measuredResult: BenchmarkResult = {
      ...result,
      measurements: [
        { depth: 0, pp: 1000, tg: 20, source: { url: "https://example.com/d0", upstreamId: "0", ttftMs: 0 } },
        {
          depth: 2000,
          pp: 1000,
          tg: 20,
          source: { url: "https://example.com/d2000", upstreamId: "2000", ttftMs: 6000 }
        }
      ]
    };
    const scenarioAt800: ScenarioScript = {
      ...scenario,
      systemPromptTokens: 0,
      events: [{ id: "u1", role: "user", text: "hello", tokens: 800 }]
    };

    const timeline = buildTimeline({ result: measuredResult, scenario: scenarioAt800, cacheMode: "off" });
    const event = timeline.events[0];

    // depth 800 is 40% of the way from 0 to 2000: 0 + (6000 - 0) * 0.4 = 2400ms.
    // Not the midpoint average (3000ms) of the two endpoints, proving the
    // lookup is a proper depth-proportional linear interpolation.
    expect(event.ttftMs).toBeCloseTo(2400);
    expect(event.ttftMs).not.toBeCloseTo(3000);
  });

  it("exercises cacheMode 'on', which forces caching even when the result's own runtime does not report a prefix cache", () => {
    const noCacheRuntimeResult: BenchmarkResult = {
      ...result,
      runtime: { ...result.runtime, cache: "none" }
    };

    const runtimeMode = buildTimeline({ result: noCacheRuntimeResult, scenario, cacheMode: "runtime" });
    const onMode = buildTimeline({ result: noCacheRuntimeResult, scenario, cacheMode: "on" });

    // cacheMode "runtime" respects the result's own (non-prefix) cache
    // setting, so every user/tool_result event repays the full prefix.
    expect(runtimeMode.events[1].role).toBe("assistant");
    const toolResultRuntime = runtimeMode.events[3];
    expect(toolResultRuntime.role).toBe("tool_result");
    expect(toolResultRuntime.prefillTokens).toBe(toolResultRuntime.withoutCachePrefillTokens);

    // cacheMode "on" overrides that and caches regardless, so the same
    // tool_result event only repays its cache-busted-and-beyond remainder.
    const toolResultOn = onMode.events[3];
    expect(toolResultOn.role).toBe("tool_result");
    expect(toolResultOn.prefillTokens).toBeLessThan(toolResultOn.withoutCachePrefillTokens);
    expect(toolResultOn.prefillTokens).toBe(1390);
  });

  it("runs a single-measurement result end-to-end through buildTimeline and summarizeTimeline without NaN, throw, or a broken pipeline", () => {
    const singlePointResult: BenchmarkResult = {
      ...result,
      measurements: [{ depth: 1000, pp: 800, tg: 25 }]
    };
    const smallScenario: ScenarioScript = {
      ...scenario,
      systemPromptTokens: 500,
      events: [
        { id: "u1", role: "user", text: "Hello there.", tokens: 300 },
        { id: "a1", role: "assistant", text: "Hi! How can I help?", tokens: 40 }
      ]
    };

    const timeline = buildTimeline({ result: singlePointResult, scenario: smallScenario, cacheMode: "runtime" });
    const summary = summarizeTimeline(timeline);

    expect(timeline.events).toHaveLength(2);
    for (const event of timeline.events) {
      expect(Number.isFinite(event.ppRate)).toBe(true);
      expect(Number.isFinite(event.tgRate)).toBe(true);
      expect(Number.isNaN(event.prefillMs)).toBe(false);
      expect(Number.isNaN(event.decodeMs)).toBe(false);
    }

    expect(timeline.events[0].ppConfidence).toBe("extrapolated-unsupported");
    expect(timeline.events[1].tgConfidence).toBe("extrapolated-unsupported");
    expect(summary.wallTimeMs).toBeGreaterThan(0);
    expect(Number.isFinite(summary.wallTimeMs)).toBe(true);
    expect(summary.extrapolatedEvents).toBe(2);
    expect(summary.totalTokens).toBe(840);
  });

  it("returns the final event when activeEventAt is called with elapsedMs past totalMs, instead of throwing or returning undefined", () => {
    const timeline = buildTimeline({ result, scenario, cacheMode: "runtime" });

    const farPastEnd = activeEventAt(timeline, timeline.totalMs + 1_000_000);
    expect(farPastEnd).toBeDefined();
    expect(farPastEnd.id).toBe(timeline.events.at(-1)!.id);

    // Also exactly at totalMs (the final event's own endMs boundary).
    expect(activeEventAt(timeline, timeline.totalMs).id).toBe(timeline.events.at(-1)!.id);
  });
});
