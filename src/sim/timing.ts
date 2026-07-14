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

export function rateToMsPerToken(rate: number): number {
  if (!(rate > 0)) {
    throw new Error(`Measurement rate must be positive, got ${rate}`);
  }
  return 1000 / rate;
}

/**
 * Per-measurement rate stddev, propagated into ms/token terms via the
 * derivative of `1000 / rate` (d(msPerToken) = -1000/rate^2 * d(rate)).
 * Zero when the contributor didn't submit a stddev for this point — the
 * widening this feeds is purely additive and never fabricates uncertainty.
 */
function stddevMsAtPoint(point: BenchmarkMeasurement, field: "pp" | "tg"): number {
  const stddev = field === "pp" ? point.ppStddev : point.tgStddev;
  if (!stddev) return 0;
  const rate = point[field];
  return (1000 * stddev) / (rate * rate);
}

/**
 * Companion to `msPerTokenClampedAt`: the ms/token stddev at `depth`, flat
 * beyond the measured span and linearly interpolated between bracketing
 * points within it — same interpolation shape as the rate itself, so the
 * uncertainty band tracks the curve it's widening.
 */
function msStddevClampedAt(measurements: BenchmarkMeasurement[], field: "pp" | "tg", depth: number): number {
  const points = sortMeasurementsByDepth(measurements);
  const first = points[0];
  if (depth <= first.depth) {
    return stddevMsAtPoint(first, field);
  }

  const last = points[points.length - 1];
  if (depth >= last.depth) {
    return stddevMsAtPoint(last, field);
  }

  for (let index = 0; index < points.length - 1; index += 1) {
    const left = points[index];
    const right = points[index + 1];
    if (depth >= left.depth && depth <= right.depth) {
      const span = right.depth - left.depth;
      const progress = span === 0 ? 0 : (depth - left.depth) / span;
      const leftStddevMs = stddevMsAtPoint(left, field);
      const rightStddevMs = stddevMsAtPoint(right, field);
      return leftStddevMs + (rightStddevMs - leftStddevMs) * progress;
    }
  }

  return stddevMsAtPoint(last, field);
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
function msPerTokenClampedAt(measurements: BenchmarkMeasurement[], field: "pp" | "tg", depth: number): number {
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
export function rateConfidenceAt(measurements: BenchmarkMeasurement[], depth: number): RateConfidence {
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
 *
 * `stddevMs` is the additional (purely additive) uncertainty half-width at
 * `depth` derived from the contributor-submitted `ppStddev`/`tgStddev`, zero
 * when absent. Callers that build a min/max range from `canonicalMs`/
 * `optimisticMs` should subtract/add it to widen the bounds further.
 */
export function msPerTokenRangeAt(
  measurements: BenchmarkMeasurement[],
  field: "pp" | "tg",
  depth: number
): { canonicalMs: number; optimisticMs: number; stddevMs: number; confidence: RateConfidence } {
  const confidence = rateConfidenceAt(measurements, depth);
  const clampedMs = msPerTokenClampedAt(measurements, field, depth);
  const stddevMs = msStddevClampedAt(measurements, field, depth);

  if (confidence !== "extrapolated-fitted") {
    return { canonicalMs: clampedMs, optimisticMs: clampedMs, stddevMs, confidence };
  }

  const points = sortMeasurementsByDepth(measurements);
  const fit = fitTimePerTokenLinear(measurements, field);
  if (!fit) {
    // Unreachable given rateConfidenceAt's guarantees, but keeps this total.
    return { canonicalMs: clampedMs, optimisticMs: clampedMs, stddevMs, confidence };
  }

  const last = points[points.length - 1];
  const anchorMs = rateToMsPerToken(last[field]);
  const fittedMs = Math.max(0, anchorMs + fit.slope * (depth - last.depth));
  return { canonicalMs: fittedMs, optimisticMs: clampedMs, stddevMs, confidence };
}

interface PreparedIntegration {
  points: BenchmarkMeasurement[];
  first: BenchmarkMeasurement;
  last: BenchmarkMeasurement;
  firstMs: number;
  lastMs: number;
  firstStddevMs: number;
  lastStddevMs: number;
  fit: { intercept: number; slope: number } | undefined;
}

/**
 * Sorts measurements and fits the trend line once so a run of many
 * `integrateTimeRangeMsPrepared` calls (e.g. one per decode token in
 * `buildDecodeCumulativeMs`) doesn't re-sort and re-fit the same measurement
 * set on every call.
 */
function prepareIntegration(measurements: BenchmarkMeasurement[], field: "pp" | "tg"): PreparedIntegration {
  const points = sortMeasurementsByDepth(measurements);
  const first = points[0];
  const last = points[points.length - 1];
  return {
    points,
    first,
    last,
    firstMs: rateToMsPerToken(first[field]),
    lastMs: rateToMsPerToken(last[field]),
    firstStddevMs: stddevMsAtPoint(first, field),
    lastStddevMs: stddevMsAtPoint(last, field),
    fit: fitTimePerTokenLinear(points, field)
  };
}

function integrateTimeRangeMsPrepared(
  prepared: PreparedIntegration,
  field: "pp" | "tg",
  fromDepth: number,
  toDepth: number
): { canonicalMs: number; optimisticMs: number; stddevMs: number; confidence: RateConfidence } {
  // Runtime guard (A2): a non-finite bound would poison every arithmetic
  // segment below and still be tagged "interpolated". Reject it outright and
  // never let a broken integral pass as interpolated confidence. Negative
  // bounds are clamped to 0 -- depth is a token count that can't go below
  // zero, and a negative bound would otherwise widen the pre-first-depth
  // segment with phantom width.
  if (!Number.isFinite(fromDepth) || !Number.isFinite(toDepth)) {
    return { canonicalMs: 0, optimisticMs: 0, stddevMs: 0, confidence: "extrapolated-unsupported" };
  }
  fromDepth = Math.max(0, fromDepth);
  toDepth = Math.max(0, toDepth);
  if (toDepth <= fromDepth) {
    return { canonicalMs: 0, optimisticMs: 0, stddevMs: 0, confidence: rateConfidenceAt(prepared.points, fromDepth) };
  }

  const { points, first, last, firstMs, lastMs, firstStddevMs, lastStddevMs, fit } = prepared;

  function integrateFittedMs(from: number, to: number): number {
    if (!fit) return 0;
    // Closed-form integral of (lastMs + slope * (x - last.depth)) over
    // [from, to] — anchored at the last measured point so the fitted line
    // is continuous with it rather than the unconstrained global intercept.
    return lastMs * (to - from) + (fit.slope * ((to - last.depth) ** 2 - (from - last.depth) ** 2)) / 2;
  }

  let canonicalTotal = 0;
  let optimisticTotal = 0;
  let stddevTotal = 0;
  let confidence: RateConfidence = "measured";

  // Segment before the first measured depth: no basis to extrapolate the
  // fitted trend backward, so both bounds hold flat and it is always
  // extrapolated-unsupported, never fitted.
  const preEnd = Math.min(toDepth, first.depth);
  if (fromDepth < preEnd) {
    const width = preEnd - fromDepth;
    optimisticTotal += width * firstMs;
    canonicalTotal += width * firstMs;
    stddevTotal += width * firstStddevMs;
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

    const leftStddevMs = stddevMsAtPoint(left, field);
    const rightStddevMs = stddevMsAtPoint(right, field);
    const stddevAt = (depth: number) => leftStddevMs + (rightStddevMs - leftStddevMs) * ((depth - left.depth) / span);

    const startValue = valueAt(segStart);
    const endValue = valueAt(segEnd);
    const segmentMs = ((startValue + endValue) / 2) * (segEnd - segStart);
    canonicalTotal += segmentMs;
    optimisticTotal += segmentMs;
    stddevTotal += ((stddevAt(segStart) + stddevAt(segEnd)) / 2) * (segEnd - segStart);
    confidence = worseConfidence(confidence, "interpolated");
  }

  // Segment after the last measured depth (extrapolated).
  const postStart = Math.max(fromDepth, last.depth);
  if (postStart < toDepth) {
    const width = toDepth - postStart;
    optimisticTotal += width * lastMs;
    stddevTotal += width * lastStddevMs;
    if (points.length >= 2) {
      canonicalTotal += Math.max(0, integrateFittedMs(postStart, toDepth));
      confidence = worseConfidence(confidence, "extrapolated-fitted");
    } else {
      canonicalTotal += width * lastMs;
      confidence = worseConfidence(confidence, "extrapolated-unsupported");
    }
  }

  // Final safety (A2): never surface a NaN/Infinity total under an
  // "interpolated" (or any measured-ish) confidence tier -- collapse a broken
  // result to a safe zero tagged extrapolated-unsupported instead.
  if (!Number.isFinite(canonicalTotal) || !Number.isFinite(optimisticTotal)) {
    return { canonicalMs: 0, optimisticMs: 0, stddevMs: 0, confidence: "extrapolated-unsupported" };
  }

  return { canonicalMs: canonicalTotal, optimisticMs: optimisticTotal, stddevMs: stddevTotal, confidence };
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
 * `stddevMs` is the trapezoidal integral of `msStddevClampedAt` over the same
 * span — purely additive uncertainty widening from contributor-submitted
 * `ppStddev`/`tgStddev`, zero when none was supplied.
 */
export function integrateTimeRangeMs(
  measurements: BenchmarkMeasurement[],
  field: "pp" | "tg",
  fromDepth: number,
  toDepth: number
): { canonicalMs: number; optimisticMs: number; stddevMs: number; confidence: RateConfidence } {
  if (measurements.length === 0) {
    throw new Error("Cannot integrate an empty measurement set");
  }
  return integrateTimeRangeMsPrepared(prepareIntegration(measurements, field), field, fromDepth, toDepth);
}

/**
 * Cumulative canonical decode ms from decode-start (token 0) to each token
 * count in `[0, tokens]`, integrating the real depth-dependent per-token
 * rate curve one token at a time via `integrateTimeRangeMs`. This is the
 * data source for realistic (non-flat) decode cadence in playback: summing
 * these per-token integrals over the full span is mathematically equal (up
 * to floating-point rounding) to integrating over `[contextBefore,
 * contextBefore + tokens]` directly, so `decodeCumulativeMs[tokens]` tracks
 * the event's `decodeMs`.
 */
function buildDecodeCumulativeMs(
  measurements: BenchmarkMeasurement[],
  contextBefore: number,
  tokens: number
): number[] {
  const prepared = prepareIntegration(measurements, "tg");
  const cumulative = new Array<number>(tokens + 1);
  cumulative[0] = 0;
  let running = 0;
  for (let tokenIndex = 1; tokenIndex <= tokens; tokenIndex += 1) {
    const stepRange = integrateTimeRangeMsPrepared(
      prepared,
      "tg",
      contextBefore + tokenIndex - 1,
      contextBefore + tokenIndex
    );
    running += stepRange.canonicalMs;
    cumulative[tokenIndex] = running;
  }
  return cumulative;
}

/**
 * Interpolates measured TTFT at `depth`, where `depth` is expressed in the
 * SAME convention as `measurement.depth + ttftDepthOffset` -- see
 * `ttftDepthOffset`'s doc comment on the two conventions this normalizes
 * between. `ttftDepthOffset` shifts every measurement's depth onto the
 * "total prompt tokens actually processed for that TTFT reading" axis before
 * sorting/interpolating, so the lookup key (`depth`, always expressed as a
 * total-prompt-tokens count by callers) lines up with the measurements
 * regardless of which convention the source used.
 *
 * Below the first TTFT-bearing depth the reading flat-clamps to that first
 * measured TTFT. At or beyond the LAST TTFT-bearing depth the value clamps to
 * that last measured TTFT AND the returned anchorDepth clamps to that last
 * measured depth. buildTimeline reconciles the implied launch overhead at
 * anchorDepth, then adds the pp integral over the real (larger) prompt depth
 * on top -- so beyond the measured range prefill keeps growing with prompt
 * size instead of collapsing back to the stale flat TTFT (A1). Anchoring the
 * depth (rather than returning undefined and falling through to the bare
 * integral) keeps that growth continuous at the boundary, where the bare
 * integral would cliff-drop below the last measured TTFT for a one-token-
 * larger prompt.
 */
function resolveTtftAnchor(
  measurements: BenchmarkMeasurement[],
  depth: number,
  ttftDepthOffset: number
): { ttftMs: number; anchorDepth: number } | undefined {
  const points = measurements
    .filter((measurement) => typeof measurement.source?.ttftMs === "number")
    .map((measurement) => ({
      effectiveDepth: measurement.depth + ttftDepthOffset,
      ttftMs: measurement.source!.ttftMs!
    }))
    .sort((a, b) => a.effectiveDepth - b.effectiveDepth);

  if (points.length === 0) return undefined;

  const first = points[0];
  const last = points[points.length - 1];
  if (depth <= first.effectiveDepth) return { ttftMs: first.ttftMs, anchorDepth: depth };
  if (depth >= last.effectiveDepth) return { ttftMs: last.ttftMs, anchorDepth: last.effectiveDepth };

  for (let index = 0; index < points.length - 1; index += 1) {
    const left = points[index];
    const right = points[index + 1];
    if (depth >= left.effectiveDepth && depth <= right.effectiveDepth) {
      const span = right.effectiveDepth - left.effectiveDepth;
      const progress = span === 0 ? 0 : (depth - left.effectiveDepth) / span;
      return { ttftMs: left.ttftMs + (right.ttftMs - left.ttftMs) * progress, anchorDepth: depth };
    }
  }

  return { ttftMs: last.ttftMs, anchorDepth: last.effectiveDepth };
}

export function buildTimeline(input: TimelineInput): Timeline {
  const { result, scenario } = input;
  // A2: an empty event list builds a zero-event timeline that activeEventAt
  // cannot consume (it throws "Timeline has no events" downstream). Fail here
  // with a clear message instead of producing a structurally broken timeline.
  if (scenario.events.length === 0) {
    throw new Error(`Cannot build a timeline for scenario "${scenario.id}" with no events`);
  }
  const cacheEnabled = input.cacheMode === "on" || (input.cacheMode === "runtime" && result.runtime.cache === "prefix");
  const overheadMs = result.overheadMs ?? DEFAULT_OVERHEAD_MS;
  // Depth-axis normalization for TTFT lookups (T3): oMLX imports set
  // `measurement.depth` to the full prompt length the TTFT reading was taken
  // at, so no offset is needed. llama-bench/llama-benchy-style sweeps instead
  // report `depth` as the context ALREADY present before the pp-test's own
  // chunk, with TTFT measured for `depth + ppTokens` total tokens (mirroring
  // the two conventions `ttftMismatchesPromptRate` in catalogQuality.ts
  // already checks). `benchmark.ppTokens` is the signal that distinguishes
  // them: unset (oMLX) means depth already is the total, set means depth
  // must be shifted forward by that chunk size to reach the true total.
  const ttftDepthOffset = result.benchmark?.ppTokens ?? 0;
  let cursorMs = 0;
  let contextDepth = scenario.systemPromptTokens;
  let cachedPrefixTokens = 0;

  const events: TimelineEvent[] = scenario.events.map((event, index) => {
    const contextBefore = contextDepth;
    const shouldPrefill = event.role === "user" || event.role === "tool_result";
    const shouldDecode = event.role === "assistant" || event.role === "thinking" || event.role === "tool_call";
    // "cache_bust" is a zero-content, zero-duration marker role (see
    // ScenarioRole in types.ts): a standalone event using it must never
    // advance context depth or add wall-clock time. The schema rejects
    // nonzero tokens/toolLatencyMs (and any cacheBust property at all) on
    // it, but this is enforced again here defensively so a malformed event
    // can never silently inflate contextDepth/cachedPrefixTokens or add
    // tool latency for zero timing cost (T1).
    const isCacheBustMarker = event.role === "cache_bust";
    // Defensive nonnegative clamp (A2), mirroring the cache_bust re-guard: a
    // malformed event that slipped a negative token count past schema
    // validation must never subtract context depth or produce a negative
    // integration span.
    const eventTokens = Math.max(0, event.tokens);
    const contextTokens = isCacheBustMarker ? 0 : eventTokens;
    const withoutCachePrefillTokens = shouldPrefill ? contextBefore + eventTokens : 0;
    const cacheBustPrefix = isCacheBustMarker ? undefined : event.cacheBust?.retainedPrefixTokens;
    const effectiveCachedPrefix = cacheEnabled ? Math.min(cacheBustPrefix ?? cachedPrefixTokens, contextBefore) : 0;
    const prefillTokens = !shouldPrefill ? 0 : Math.max(0, withoutCachePrefillTokens - effectiveCachedPrefix);
    const ppDepth = shouldPrefill ? withoutCachePrefillTokens : contextBefore;

    let prefillMs = 0;
    let prefillOptimisticMs = 0;
    let prefillIntegralMs = 0;
    let prefillStddevMs = 0;
    let ppConfidence: RateConfidence = "measured";
    if (prefillTokens > 0) {
      const prefillRange = integrateTimeRangeMs(
        result.measurements,
        "pp",
        effectiveCachedPrefix,
        withoutCachePrefillTokens
      );
      prefillIntegralMs = prefillRange.canonicalMs;
      prefillStddevMs = prefillRange.stddevMs;
      ppConfidence = prefillRange.confidence;

      const ttftAnchor = resolveTtftAnchor(result.measurements, withoutCachePrefillTokens, ttftDepthOffset);
      if (ttftAnchor !== undefined) {
        // impliedOverheadMs is the fixed launch cost the model's integral doesn't
        // capture, measured at the anchor depth (the real prompt depth within the
        // measured range, or the last measured depth beyond it). Adding it back to
        // the (possibly cache-shortened) integral over the real prefill range
        // reproduces measuredTtftMs exactly for a fully cold prefill within range;
        // beyond the last measured depth the anchor freezes but prefillRange keeps
        // integrating to the real depth, so prefill grows monotonically (A1).
        const anchorPrefillRange = integrateTimeRangeMs(result.measurements, "pp", 0, ttftAnchor.anchorDepth);
        const impliedOverheadMs = ttftAnchor.ttftMs - anchorPrefillRange.canonicalMs;
        // A fully cold prefill (effectiveCachedPrefix === 0) within the measured
        // range has prefillRange.canonicalMs === anchorPrefillRange.canonicalMs,
        // so the raw implied overhead -- even when negative for a fast launch --
        // reproduces measuredTtftMs exactly and must pass through unclamped. A
        // cache-shortened prefill instead reuses this overhead on top of a
        // sub-range integral, where a negative overhead would drag the result
        // below the real integrated cost of the reprocessed tokens; clamp it to
        // >= 0 there (A1).
        const reusableOverheadMs = effectiveCachedPrefix > 0 ? Math.max(0, impliedOverheadMs) : impliedOverheadMs;
        const rawPrefillMs = reusableOverheadMs + prefillRange.canonicalMs;
        const rawOptimisticMs = reusableOverheadMs + prefillRange.optimisticMs;
        prefillMs = Number.isFinite(rawPrefillMs) ? Math.max(0, rawPrefillMs) : prefillRange.canonicalMs + overheadMs;
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
    let decodeStddevMs = 0;
    let tgConfidence: RateConfidence = "measured";
    const decodeIsActive = shouldDecode && eventTokens > 0;
    if (decodeIsActive) {
      const decodeRange = integrateTimeRangeMs(result.measurements, "tg", contextBefore, contextBefore + eventTokens);
      decodeMs = decodeRange.canonicalMs;
      decodeOptimisticMs = decodeRange.optimisticMs;
      decodeStddevMs = decodeRange.stddevMs;
      tgConfidence = decodeRange.confidence;
    }

    // Per-token cumulative decode timing is only needed by playback's live
    // streaming reveal (`decodeCumulativeProgress` in lib/streaming.ts), not
    // by callers that only read the aggregate summary (e.g. the catalog-wide
    // leaderboard). Computing it costs one `integrateTimeRangeMs` call per
    // decode token, so it's deferred behind a getter and cached on first
    // access rather than paid unconditionally for every event.
    let cachedDecodeCumulativeMs: number[] | undefined;
    const decodeCumulativeMsGetter = (): number[] => {
      if (cachedDecodeCumulativeMs === undefined) {
        cachedDecodeCumulativeMs = decodeIsActive
          ? buildDecodeCumulativeMs(result.measurements, contextBefore, eventTokens)
          : [0];
      }
      return cachedDecodeCumulativeMs;
    };

    const ppRate =
      prefillTokens > 0
        ? prefillTokens / (prefillIntegralMs / 1000)
        : (() => {
            const fallback = msPerTokenRangeAt(result.measurements, "pp", ppDepth);
            ppConfidence = fallback.confidence;
            return 1000 / fallback.canonicalMs;
          })();
    const tgRate =
      shouldDecode && eventTokens > 0
        ? eventTokens / (decodeMs / 1000)
        : (() => {
            const fallback = msPerTokenRangeAt(result.measurements, "tg", contextBefore);
            tgConfidence = fallback.confidence;
            return 1000 / fallback.canonicalMs;
          })();

    const prefillRangeMs = {
      min: Math.max(0, Math.min(prefillOptimisticMs, prefillMs) - prefillStddevMs),
      max: Math.max(prefillOptimisticMs, prefillMs) + prefillStddevMs
    };
    const decodeRangeMs = {
      min: Math.max(0, Math.min(decodeOptimisticMs, decodeMs) - decodeStddevMs),
      max: Math.max(decodeOptimisticMs, decodeMs) + decodeStddevMs
    };

    const toolLatencyMs = isCacheBustMarker ? 0 : Math.max(0, event.toolLatencyMs ?? 0);
    const startMs = cursorMs;
    const toolDoneMs = startMs + toolLatencyMs;
    const prefillDoneMs = toolDoneMs + prefillMs;
    const endMs = prefillDoneMs + decodeMs;
    const ttftMs = toolLatencyMs + prefillMs;

    contextDepth += contextTokens;
    cachedPrefixTokens = cacheEnabled ? contextDepth : 0;

    cursorMs = endMs;

    return {
      ...event,
      // Emit the defensively-clamped token count (A2) so downstream summaries
      // and streaming never see a negative that slipped past schema validation.
      tokens: eventTokens,
      index,
      phase: toolLatencyMs > 0 ? "tool_latency" : prefillMs > 0 ? "prefill" : decodeMs > 0 ? "decode" : "instant",
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
      get decodeCumulativeMs() {
        return decodeCumulativeMsGetter();
      },
      toolLatencyMs,
      // Only count a confidence tier toward the extrapolated flag when that
      // phase actually ran (A2): a zero-token/instant event still resolves
      // ppConfidence/tgConfidence via the depth fallback, but with no real
      // prefill or decode work those tiers are irrelevant and must not flag
      // the event as extrapolated.
      extrapolated:
        (prefillTokens > 0 && ppConfidence !== "measured" && ppConfidence !== "interpolated") ||
        (decodeIsActive && tgConfidence !== "measured" && tgConfidence !== "interpolated")
    };
  });

  return {
    result,
    scenario,
    cacheMode: input.cacheMode,
    events,
    totalMs: cursorMs
  };
}

const NON_MEASURED_TIERS = new Set<RateConfidence>(["extrapolated-fitted", "extrapolated-unsupported"]);

export function summarizeTimeline(timeline: Timeline): TimelineSummary {
  const generatedTokens = timeline.events
    .filter((event) => generatedRoles.has(event.role))
    .reduce((sum, event) => sum + event.tokens, 0);
  const totalDecodeMs = timeline.events.reduce((sum, event) => sum + event.decodeMs, 0);
  const prefilledWithCache = timeline.events.reduce((sum, event) => sum + event.prefillTokens, 0);
  const prefilledWithoutCache = timeline.events.reduce((sum, event) => sum + event.withoutCachePrefillTokens, 0);
  const cacheSavedRatio = prefilledWithoutCache === 0 ? 0 : Math.max(0, 1 - prefilledWithCache / prefilledWithoutCache);

  const wallTimeRangeMs = timeline.events.reduce(
    (range, event) => ({
      min: range.min + event.toolLatencyMs + event.prefillRangeMs.min + event.decodeRangeMs.min,
      max: range.max + event.toolLatencyMs + event.prefillRangeMs.max + event.decodeRangeMs.max
    }),
    { min: 0, max: 0 }
  );

  const nonMeasuredMs = timeline.events.reduce((sum, event) => {
    const prefillNonMeasured = NON_MEASURED_TIERS.has(event.ppConfidence) ? event.prefillMs : 0;
    const decodeNonMeasured = NON_MEASURED_TIERS.has(event.tgConfidence) ? event.decodeMs : 0;
    return sum + prefillNonMeasured + decodeNonMeasured;
  }, 0);

  return {
    wallTimeMs: timeline.totalMs,
    wallTimeRangeMs,
    totalTokens: timeline.events.at(-1)?.contextAfter ?? timeline.scenario.systemPromptTokens,
    generatedTokens,
    prefilledWithCache,
    prefilledWithoutCache,
    cacheSavedRatio,
    prefillMs: timeline.events.reduce((sum, event) => sum + event.prefillMs, 0),
    decodeMs: totalDecodeMs,
    toolLatencyMs: timeline.events.reduce((sum, event) => sum + event.toolLatencyMs, 0),
    extrapolatedEvents: timeline.events.filter((event) => event.extrapolated).length,
    nonMeasuredTimeShare: timeline.totalMs === 0 ? 0 : nonMeasuredMs / timeline.totalMs,
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
