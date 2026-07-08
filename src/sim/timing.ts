import type {
  BenchmarkMeasurement,
  RateConfidence,
  Timeline,
  TimelineEvent,
  TimelineInput,
  TimelineSummary
} from "../types";

const DEFAULT_OVERHEAD_MS = 80;
const generatedRoles = new Set(["assistant", "thinking", "tool_call"]);

const CONFIDENCE_RANK: Record<RateConfidence, number> = {
  measured: 0,
  interpolated: 1,
  "extrapolated-fitted": 2,
  "extrapolated-unsupported": 3
};

function worseConfidence(a: RateConfidence, b: RateConfidence): RateConfidence {
  return CONFIDENCE_RANK[b] > CONFIDENCE_RANK[a] ? b : a;
}

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

/**
 * Milliseconds-per-token at `depth`, interpolated LINEARLY IN TIME (ms/token)
 * between bracketing measured depths — the physically appropriate quantity
 * to interpolate, since it's what actually integrates to wall-clock time.
 *
 * Beyond the min/max measured depth this stays flat-clamped to the nearest
 * measured point. This is a private building block: on its own it is only
 * the *optimistic* bound beyond the measured range — `msPerTokenRangeAt`
 * pairs it with a fitted-trend canonical estimate for that region.
 */
function msPerTokenClampedAt(
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
 * Confidence tier for a rate estimate at `depth`, from the four-tier model:
 * exact submitted depths are "measured", points strictly between two
 * measured depths are "interpolated". Past the last measured depth, a trend
 * can actually be fit and extrapolated forward when >= 2 measurements exist
 * ("extrapolated-fitted"), otherwise it's "extrapolated-unsupported". Before
 * the first measured depth is NOT symmetric with that: no fit is ever run
 * backward across a wholly unmeasured gap (see `msPerTokenRangeAt` /
 * `integrateTimeRangeMs`), so it is always "extrapolated-unsupported"
 * regardless of how many measurements exist elsewhere in the set.
 */
export function rateConfidenceAt(
  measurements: BenchmarkMeasurement[],
  depth: number
): RateConfidence {
  if (measurements.length === 0) {
    throw new Error("Cannot assess confidence for an empty measurement set");
  }

  const points = sortMeasurementsByDepth(measurements);
  const first = points[0];
  const last = points[points.length - 1];

  if (points.some((point) => point.depth === depth)) {
    return "measured";
  }
  if (depth > first.depth && depth < last.depth) {
    return "interpolated";
  }
  if (depth < first.depth) {
    return "extrapolated-unsupported";
  }
  return points.length >= 2 ? "extrapolated-fitted" : "extrapolated-unsupported";
}

/**
 * Least-squares linear fit of msPerToken (1000 / rate) against depth across
 * ALL measurements for `field`. Returns undefined when fewer than two
 * measurements are available (no trend is derivable).
 *
 * The fitted slope is constrained to be non-negative: msPerToken must not
 * decrease with depth beyond the measured data. If the unconstrained
 * least-squares slope comes out negative (e.g. noisy or reversed data), this
 * refits as a proper constrained fit with the slope pinned to 0 — i.e. flat
 * at the mean msPerToken — rather than naively clamping the unconstrained
 * intercept.
 */
export function fitTimePerTokenLinear(
  measurements: BenchmarkMeasurement[],
  field: "pp" | "tg"
): { intercept: number; slope: number } | undefined {
  if (measurements.length < 2) {
    return undefined;
  }

  const points = sortMeasurementsByDepth(measurements);
  const n = points.length;
  const xs = points.map((point) => point.depth);
  const ys = points.map((point) => rateToMsPerToken(point[field]));

  const meanX = xs.reduce((sum, x) => sum + x, 0) / n;
  const meanY = ys.reduce((sum, y) => sum + y, 0) / n;

  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index += 1) {
    numerator += (xs[index] - meanX) * (ys[index] - meanY);
    denominator += (xs[index] - meanX) ** 2;
  }

  const unconstrainedSlope = denominator === 0 ? 0 : numerator / denominator;
  if (unconstrainedSlope < 0) {
    // Constrained fit: slope pinned to 0, flat at the mean msPerToken.
    return { intercept: meanY, slope: 0 };
  }

  const intercept = meanY - unconstrainedSlope * meanX;
  return { intercept, slope: unconstrainedSlope };
}

/**
 * Milliseconds-per-token at `depth` as a range: within the measured or
 * interpolated span, `canonicalMs === optimisticMs` (unchanged Phase 1
 * behavior). Beyond the measured range:
 * - "extrapolated-fitted" (only possible past the last measured depth, per
 *   `rateConfidenceAt`): `canonicalMs` follows the least-squares fitted
 *   trend line, anchored to the last measured point so it can never
 *   undershoot it (realistic — slower for degrading curves); `optimisticMs`
 *   is the old flat-clamp value (now understood as merely the best-case
 *   bound).
 * - "extrapolated-unsupported": both hold flat — either at the single
 *   submitted point, or (before the first measured depth, even with >= 2
 *   measurements elsewhere) at the first measured point, since running a
 *   trend backward across a potentially large, wholly unmeasured gap isn't
 *   grounded data. There is no basis for a range in either case.
 */
export function msPerTokenRangeAt(
  measurements: BenchmarkMeasurement[],
  field: "pp" | "tg",
  depth: number
): { canonicalMs: number; optimisticMs: number; confidence: RateConfidence } {
  const confidence = rateConfidenceAt(measurements, depth);
  const clampedMs = msPerTokenClampedAt(measurements, field, depth);

  if (confidence !== "extrapolated-fitted") {
    return { canonicalMs: clampedMs, optimisticMs: clampedMs, confidence };
  }

  const points = sortMeasurementsByDepth(measurements);
  const fit = fitTimePerTokenLinear(measurements, field);
  if (!fit) {
    // Unreachable given rateConfidenceAt's guarantees, but keeps this total.
    return { canonicalMs: clampedMs, optimisticMs: clampedMs, confidence };
  }

  const last = points[points.length - 1];
  const anchorMs = rateToMsPerToken(last[field]);
  const fittedMs = Math.max(0, anchorMs + fit.slope * (depth - last.depth));
  return { canonicalMs: fittedMs, optimisticMs: clampedMs, confidence };
}

/**
 * Range-returning integral of msPerToken over [fromDepth, toDepth]
 * (fromDepth <= toDepth). Mirrors `msPerTokenRangeAt`'s tiers per segment:
 * measured/interpolated interior segments contribute the same value to both
 * bounds. The segment past the last measured depth contributes the
 * closed-form integral of the fitted line — anchored to the last measured
 * point, so it can never dip below the flat-clamp rectangle — to
 * `canonicalMs`, and the flat-clamp rectangle to `optimisticMs`. The segment
 * before the first measured depth has no grounded trend to extrapolate
 * backward across a potentially large unmeasured gap (never fitted,
 * regardless of how many measurements exist elsewhere), so both bounds hold
 * flat at the first measured value and it is always tagged
 * "extrapolated-unsupported" (same treatment as a single measurement).
 * `confidence` is the LOWEST-confidence tier encountered anywhere in the span.
 */
export function integrateTimeRangeMs(
  measurements: BenchmarkMeasurement[],
  field: "pp" | "tg",
  fromDepth: number,
  toDepth: number
): { canonicalMs: number; optimisticMs: number; confidence: RateConfidence } {
  if (measurements.length === 0) {
    throw new Error("Cannot integrate an empty measurement set");
  }
  if (toDepth <= fromDepth) {
    return { canonicalMs: 0, optimisticMs: 0, confidence: rateConfidenceAt(measurements, fromDepth) };
  }

  const points = sortMeasurementsByDepth(measurements);
  const first = points[0];
  const last = points[points.length - 1];
  const firstMs = rateToMsPerToken(first[field]);
  const lastMs = rateToMsPerToken(last[field]);
  const fit = fitTimePerTokenLinear(points, field);

  function integrateFittedMs(from: number, to: number): number {
    if (!fit) return 0;
    // Closed-form integral of (lastMs + slope * (x - last.depth)) over
    // [from, to] — anchored at the last measured point so the fitted line
    // is continuous with it rather than the unconstrained global intercept.
    return (
      lastMs * (to - from) +
      (fit.slope * ((to - last.depth) ** 2 - (from - last.depth) ** 2)) / 2
    );
  }

  let canonicalTotal = 0;
  let optimisticTotal = 0;
  let confidence: RateConfidence = "measured";

  // Segment before the first measured depth: no basis to extrapolate the
  // fitted trend backward, so both bounds hold flat and it is always
  // extrapolated-unsupported, never fitted.
  const preEnd = Math.min(toDepth, first.depth);
  if (fromDepth < preEnd) {
    const width = preEnd - fromDepth;
    optimisticTotal += width * firstMs;
    canonicalTotal += width * firstMs;
    confidence = worseConfidence(confidence, "extrapolated-unsupported");
  }

  // Linear segments between consecutive measured depths (measured/interpolated).
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
    const segmentMs = ((startValue + endValue) / 2) * (segEnd - segStart);
    canonicalTotal += segmentMs;
    optimisticTotal += segmentMs;
    confidence = worseConfidence(confidence, "interpolated");
  }

  // Segment after the last measured depth (extrapolated).
  const postStart = Math.max(fromDepth, last.depth);
  if (postStart < toDepth) {
    const width = toDepth - postStart;
    optimisticTotal += width * lastMs;
    if (points.length >= 2) {
      canonicalTotal += Math.max(0, integrateFittedMs(postStart, toDepth));
      confidence = worseConfidence(confidence, "extrapolated-fitted");
    } else {
      canonicalTotal += width * lastMs;
      confidence = worseConfidence(confidence, "extrapolated-unsupported");
    }
  }

  return { canonicalMs: canonicalTotal, optimisticMs: optimisticTotal, confidence };
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
    let prefillOptimisticMs = 0;
    let prefillIntegralMs = 0;
    let ppConfidence: RateConfidence = "measured";
    if (prefillTokens > 0) {
      const prefillRange = integrateTimeRangeMs(
        result.measurements,
        "pp",
        effectiveCachedPrefix,
        withoutCachePrefillTokens
      );
      prefillIntegralMs = prefillRange.canonicalMs;
      ppConfidence = prefillRange.confidence;

      const measuredTtftMs = interpolateTtftMs(result.measurements, withoutCachePrefillTokens);
      if (measuredTtftMs !== undefined) {
        const fullPrefillRange = integrateTimeRangeMs(
          result.measurements,
          "pp",
          0,
          withoutCachePrefillTokens
        );
        // impliedOverheadMs is the fixed launch cost the model's integral doesn't
        // capture; adding it back to the (possibly cache-shortened) integral
        // reproduces measuredTtftMs exactly for a fully cold prefill, since
        // prefillIntegralMs === fullPrefillRange.canonicalMs in that case.
        const impliedOverheadMs = measuredTtftMs - fullPrefillRange.canonicalMs;
        const rawPrefillMs = impliedOverheadMs + prefillRange.canonicalMs;
        const rawOptimisticMs = impliedOverheadMs + prefillRange.optimisticMs;
        prefillMs = Number.isFinite(rawPrefillMs)
          ? Math.max(0, rawPrefillMs)
          : prefillRange.canonicalMs + overheadMs;
        prefillOptimisticMs = Number.isFinite(rawOptimisticMs)
          ? Math.max(0, rawOptimisticMs)
          : prefillRange.optimisticMs + overheadMs;
      } else {
        prefillMs = prefillRange.canonicalMs + overheadMs;
        prefillOptimisticMs = prefillRange.optimisticMs + overheadMs;
      }
    }

    let decodeMs = 0;
    let decodeOptimisticMs = 0;
    let tgConfidence: RateConfidence = "measured";
    if (shouldDecode && event.tokens > 0) {
      const decodeRange = integrateTimeRangeMs(
        result.measurements,
        "tg",
        contextBefore,
        contextBefore + event.tokens
      );
      decodeMs = decodeRange.canonicalMs;
      decodeOptimisticMs = decodeRange.optimisticMs;
      tgConfidence = decodeRange.confidence;
    }

    const ppRate =
      prefillTokens > 0
        ? prefillTokens / (prefillIntegralMs / 1000)
        : (() => {
            const fallback = msPerTokenRangeAt(result.measurements, "pp", ppDepth);
            ppConfidence = fallback.confidence;
            return 1000 / fallback.canonicalMs;
          })();
    const tgRate =
      shouldDecode && event.tokens > 0
        ? event.tokens / (decodeMs / 1000)
        : (() => {
            const fallback = msPerTokenRangeAt(result.measurements, "tg", contextBefore);
            tgConfidence = fallback.confidence;
            return 1000 / fallback.canonicalMs;
          })();

    const prefillRangeMs = {
      min: Math.min(prefillOptimisticMs, prefillMs),
      max: Math.max(prefillOptimisticMs, prefillMs)
    };
    const decodeRangeMs = {
      min: Math.min(decodeOptimisticMs, decodeMs),
      max: Math.max(decodeOptimisticMs, decodeMs)
    };

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
      ppConfidence,
      tgConfidence,
      prefillRangeMs,
      decodeRangeMs,
      toolLatencyMs,
      extrapolated:
        (ppConfidence !== "measured" && ppConfidence !== "interpolated") ||
        (tgConfidence !== "measured" && tgConfidence !== "interpolated")
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
