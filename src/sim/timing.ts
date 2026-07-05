import type {
  BenchmarkMeasurement,
  Timeline,
  TimelineEvent,
  TimelineInput,
  TimelineSummary
} from "../types";

const DEFAULT_OVERHEAD_MS = 80;
const generatedRoles = new Set(["assistant", "thinking", "tool_call"]);

export function interpolateRate(
  measurements: BenchmarkMeasurement[],
  field: "pp" | "tg",
  depth: number
): number {
  if (measurements.length === 0) {
    throw new Error("Cannot interpolate an empty measurement set");
  }

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

export function isExtrapolated(measurements: BenchmarkMeasurement[], depth: number): boolean {
  const last = measurements[measurements.length - 1];
  return Boolean(last && depth > last.depth);
}

function interpolateTtftMs(measurements: BenchmarkMeasurement[], depth: number): number | undefined {
  const points = measurements
    .filter((measurement) => typeof measurement.source?.ttftMs === "number")
    .sort((a, b) => a.depth - b.depth);

  if (points.length === 0) return undefined;
  if (depth <= points[0].depth) return points[0].source?.ttftMs;

  const last = points[points.length - 1];
  if (depth >= last.depth) return last.source?.ttftMs;

  for (let index = 0; index < points.length - 1; index += 1) {
    const left = points[index];
    const right = points[index + 1];
    if (depth >= left.depth && depth <= right.depth) {
      const leftTtft = left.source?.ttftMs;
      const rightTtft = right.source?.ttftMs;
      if (leftTtft === undefined || rightTtft === undefined) return undefined;
      const span = right.depth - left.depth;
      const progress = span === 0 ? 0 : (depth - left.depth) / span;
      return leftTtft + (rightTtft - leftTtft) * progress;
    }
  }

  return last.source?.ttftMs;
}

export function buildTimeline(input: TimelineInput): Timeline {
  const { result, scenario, speed } = input;
  const cacheEnabled =
    input.cacheMode === "on" || (input.cacheMode === "runtime" && result.runtime.cache === "prefix");
  const overheadMs = result.overheadMs ?? DEFAULT_OVERHEAD_MS;
  let cursorMs = 0;
  let contextDepth = scenario.systemPromptTokens;
  let cachedPrefixTokens = 0;

  const events: TimelineEvent[] = scenario.events.map((event, index) => {
    const contextBefore = contextDepth;
    const shouldPrefill =
      event.role === "user" || event.role === "tool_result";
    const shouldDecode =
      event.role === "assistant" || event.role === "thinking" || event.role === "tool_call";
    const withoutCachePrefillTokens = shouldPrefill ? contextBefore + event.tokens : 0;
    const cacheBustPrefix = event.cacheBust?.retainedPrefixTokens;
    const effectiveCachedPrefix = cacheEnabled
      ? Math.min(cacheBustPrefix ?? cachedPrefixTokens, contextBefore)
      : 0;
    const prefillTokens =
      !shouldPrefill
        ? 0
        : Math.max(0, withoutCachePrefillTokens - effectiveCachedPrefix);
    const ppDepth = shouldPrefill ? withoutCachePrefillTokens : contextBefore;
    const ppRate = interpolateRate(result.measurements, "pp", ppDepth);
    const tgRate = interpolateRate(result.measurements, "tg", contextBefore);
    const measuredTtftMs = interpolateTtftMs(result.measurements, withoutCachePrefillTokens);
    const measuredPrefillMs =
      measuredTtftMs === undefined || withoutCachePrefillTokens === 0
        ? undefined
        : measuredTtftMs * (prefillTokens / withoutCachePrefillTokens);
    const prefillMs =
      prefillTokens === 0 ? 0 : measuredPrefillMs ?? (prefillTokens / ppRate) * 1000 + overheadMs;
    const decodeMs = shouldDecode && event.tokens > 0 ? (event.tokens / tgRate) * 1000 : 0;
    const toolLatencyMs = event.toolLatencyMs ?? 0;
    const startMs = cursorMs;
    const toolDoneMs = startMs + toolLatencyMs;
    const prefillDoneMs = toolDoneMs + prefillMs;
    const endMs = prefillDoneMs + decodeMs;
    const ttftMs = toolLatencyMs + prefillMs;

    contextDepth += event.tokens;
    cachedPrefixTokens = cacheEnabled ? contextDepth : 0;

    cursorMs = endMs;

    return {
      ...event,
      index,
      phase:
        toolLatencyMs > 0
          ? "tool_latency"
          : prefillMs > 0
            ? "prefill"
            : decodeMs > 0
              ? "decode"
              : "instant",
      startMs,
      toolDoneMs,
      prefillMs,
      prefillDoneMs,
      decodeMs,
      endMs,
      ttftMs,
      contextBefore,
      contextAfter: contextDepth,
      cachedPrefixTokens: effectiveCachedPrefix,
      prefillTokens,
      withoutCachePrefillTokens,
      ppRate,
      tgRate,
      toolLatencyMs,
      extrapolated: isExtrapolated(result.measurements, Math.max(contextBefore, withoutCachePrefillTokens))
    };
  });

  return {
    result,
    scenario,
    cacheMode: input.cacheMode,
    speed,
    events,
    totalMs: cursorMs
  };
}

export function summarizeTimeline(timeline: Timeline): TimelineSummary {
  const generatedTokens = timeline.events
    .filter((event) => generatedRoles.has(event.role))
    .reduce((sum, event) => sum + event.tokens, 0);
  const totalDecodeMs = timeline.events.reduce((sum, event) => sum + event.decodeMs, 0);
  const prefilledWithCache = timeline.events.reduce((sum, event) => sum + event.prefillTokens, 0);
  const prefilledWithoutCache = timeline.events.reduce(
    (sum, event) => sum + event.withoutCachePrefillTokens,
    0
  );
  const cacheSavedRatio =
    prefilledWithoutCache === 0
      ? 0
      : Math.max(0, 1 - prefilledWithCache / prefilledWithoutCache);

  return {
    wallTimeMs: timeline.totalMs,
    totalTokens: timeline.events.at(-1)?.contextAfter ?? timeline.scenario.systemPromptTokens,
    generatedTokens,
    prefilledWithCache,
    prefilledWithoutCache,
    cacheSavedRatio,
    prefillMs: timeline.events.reduce((sum, event) => sum + event.prefillMs, 0),
    decodeMs: totalDecodeMs,
    toolLatencyMs: timeline.events.reduce((sum, event) => sum + event.toolLatencyMs, 0),
    extrapolatedEvents: timeline.events.filter((event) => event.extrapolated).length,
    avgDecodeTps: totalDecodeMs === 0 ? 0 : generatedTokens / (totalDecodeMs / 1000)
  };
}

export function activeEventAt(timeline: Timeline, elapsedMs: number): TimelineEvent {
  return (
    timeline.events.find((event, index) => {
      const isFinal = index === timeline.events.length - 1;
      return elapsedMs >= event.startMs && (isFinal ? elapsedMs <= event.endMs : elapsedMs < event.endMs);
    }) ??
    timeline.events.at(-1) ??
    (() => {
      throw new Error("Timeline has no events");
    })()
  );
}
