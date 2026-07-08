import type {
  BenchmarkMeasurement,
  Timeline,
  TimelineEvent,
  TimelineInput,
  TimelineSummary
} from "../types";

const DEFAULT_OVERHEAD_MS = 80;
const generatedRoles = new Set(["assistant", "thinking", "tool_call"]);

/**
 * Milliseconds-per-token at `depth`, interpolated LINEARLY IN TIME (ms/token)
 * between bracketing measured depths — the physically appropriate quantity
 * to interpolate, since it's what actually integrates to wall-clock time.
 *
 * Beyond the min/max measured depth this stays flat-clamped to the nearest
 * measured point, identical to the old point-sample-in-rate-space approach's
 * extrapolation behavior. Honest extrapolation (trend-fitted beyond the last
 * point) is a later phase — kept separate for isolated review.
 */
function sortMeasurementsByDepth(measurements: BenchmarkMeasurement[]): BenchmarkMeasurement[] {
  const points = [...measurements].sort((a, b) => a.depth - b.depth);
  for (let index = 1; index < points.length; index += 1) {
    if (points[index].depth === points[index - 1].depth) {
      throw new Error(`Duplicate measurement depth ${points[index].depth}`);
    }
  }
  return points;
}

function rateToMsPerToken(rate: number): number {
  if (!(rate > 0)) {
    throw new Error(`Measurement rate must be positive, got ${rate}`);
  }
  return 1000 / rate;
}

export function msPerTokenAt(
  measurements: BenchmarkMeasurement[],
  field: "pp" | "tg",
  depth: number
): number {
  if (measurements.length === 0) {
    throw new Error("Cannot interpolate an empty measurement set");
  }

  const points = sortMeasurementsByDepth(measurements);
  const first = points[0];
  if (depth <= first.depth) {
    return rateToMsPerToken(first[field]);
  }

  const last = points[points.length - 1];
  if (depth >= last.depth) {
    return rateToMsPerToken(last[field]);
  }

  for (let index = 0; index < points.length - 1; index += 1) {
    const left = points[index];
    const right = points[index + 1];
    if (depth >= left.depth && depth <= right.depth) {
      const span = right.depth - left.depth;
      const progress = span === 0 ? 0 : (depth - left.depth) / span;
      const leftMs = rateToMsPerToken(left[field]);
      const rightMs = rateToMsPerToken(right[field]);
      return leftMs + (rightMs - leftMs) * progress;
    }
  }

  return rateToMsPerToken(last[field]);
}

/**
 * Exact trapezoidal integral of `msPerTokenAt` over [fromDepth, toDepth]
 * (fromDepth <= toDepth). `msPerTokenAt` is piecewise-linear with breakpoints
 * at each measured depth plus flat clamps before the first / after the last
 * point, so this is computed as an exact analytic sum over each linear
 * segment intersected with the requested range (average height * width per
 * segment) rather than fine-grained numerical stepping.
 */
export function integrateTimeMs(
  measurements: BenchmarkMeasurement[],
  field: "pp" | "tg",
  fromDepth: number,
  toDepth: number
): number {
  if (measurements.length === 0) {
    throw new Error("Cannot integrate an empty measurement set");
  }
  if (toDepth <= fromDepth) {
    return 0;
  }

  const points = sortMeasurementsByDepth(measurements);
  const first = points[0];
  const last = points[points.length - 1];
  const firstMs = rateToMsPerToken(first[field]);
  const lastMs = rateToMsPerToken(last[field]);

  let total = 0;

  // Flat segment before the first measured depth.
  const preEnd = Math.min(toDepth, first.depth);
  if (fromDepth < preEnd) {
    total += (preEnd - fromDepth) * firstMs;
  }

  // Linear segments between consecutive measured depths.
  for (let index = 0; index < points.length - 1; index += 1) {
    const left = points[index];
    const right = points[index + 1];
    const span = right.depth - left.depth;

    const segStart = Math.max(fromDepth, left.depth);
    const segEnd = Math.min(toDepth, right.depth);
    if (segStart >= segEnd) continue;

    const leftMs = rateToMsPerToken(left[field]);
    const rightMs = rateToMsPerToken(right[field]);
    const valueAt = (depth: number) => leftMs + (rightMs - leftMs) * ((depth - left.depth) / span);

    const startValue = valueAt(segStart);
    const endValue = valueAt(segEnd);
    total += ((startValue + endValue) / 2) * (segEnd - segStart);
  }

  // Flat segment after the last measured depth.
  const postStart = Math.max(fromDepth, last.depth);
  if (postStart < toDepth) {
    total += (toDepth - postStart) * lastMs;
  }

  return total;
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

    let prefillMs = 0;
    let prefillIntegralMs = 0;
    if (prefillTokens > 0) {
      prefillIntegralMs = integrateTimeMs(
        result.measurements,
        "pp",
        effectiveCachedPrefix,
        withoutCachePrefillTokens
      );
      const measuredTtftMs = interpolateTtftMs(result.measurements, withoutCachePrefillTokens);
      if (measuredTtftMs !== undefined) {
        const fullPrefillIntegralMs = integrateTimeMs(
          result.measurements,
          "pp",
          0,
          withoutCachePrefillTokens
        );
        // impliedOverheadMs is the fixed launch cost the model's integral doesn't
        // capture; adding it back to the (possibly cache-shortened) integral
        // reproduces measuredTtftMs exactly for a fully cold prefill, since
        // prefillIntegralMs === fullPrefillIntegralMs in that case.
        const impliedOverheadMs = measuredTtftMs - fullPrefillIntegralMs;
        const rawPrefillMs = impliedOverheadMs + prefillIntegralMs;
        prefillMs = Number.isFinite(rawPrefillMs)
          ? Math.max(0, rawPrefillMs)
          : prefillIntegralMs + overheadMs;
      } else {
        prefillMs = prefillIntegralMs + overheadMs;
      }
    }

    const decodeMs =
      shouldDecode && event.tokens > 0
        ? integrateTimeMs(result.measurements, "tg", contextBefore, contextBefore + event.tokens)
        : 0;

    const ppRate =
      prefillTokens > 0
        ? prefillTokens / (prefillIntegralMs / 1000)
        : 1000 / msPerTokenAt(result.measurements, "pp", ppDepth);
    const tgRate =
      shouldDecode && event.tokens > 0
        ? event.tokens / (decodeMs / 1000)
        : 1000 / msPerTokenAt(result.measurements, "tg", contextBefore);

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
      extrapolated: isExtrapolated(result.measurements, contextDepth)
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
