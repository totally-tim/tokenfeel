import { describe, expect, it } from "vitest";
import { activeEventAt, buildTimeline, interpolateRate, summarizeTimeline } from "./timing";
import type { BenchmarkResult, ScenarioScript } from "../types";

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
