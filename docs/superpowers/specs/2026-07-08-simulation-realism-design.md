# Simulation realism & accuracy — design

Date: 2026-07-08
Status: approved, implementing

## Problem

Tokenfeel's timing engine (`src/sim/timing.ts`) and its visualizations have two
classes of accuracy gaps, surfaced by an internal review (Claude + an
independent Fable-model second opinion):

1. **Math correctness bugs**, not just missing features:
   - `ppRate`/`tgRate` are point-sampled once per scenario event (prefill at
     the event's _end_ depth, decode at the event's _start_ depth) instead of
     integrated across the depth span the event actually traverses. Prefill
     is priced pessimistically, decode optimistically.
   - Depths beyond the last submitted measurement are flat-clamped to the
     last measured rate. This is not "conservative" — it's optimistic (real
     pp/tg curves keep degrading with depth) and it rewards contributors who
     submit less data (a single-point submission gets clamped to peak rate
     for an entire scenario; a full depth sweep gets its real degradation
     modeled). Race mode can crown a winner purely on data laziness.
   - `measuredPrefillMs`'s cache-aware scaling assumes uniform per-token
     prefill cost, but a retained cached prefix is the cheap early portion —
     the uncached suffix costs more than the naive proportional average.
2. **Visualization gaps**: nothing in the UI shows the difference between
   measured, interpolated, and extrapolated data, so users can't tell when
   they're looking at real benchmark numbers versus a guess. Decode cadence
   is a flat linear reveal with no connection to the underlying rate curve.

## Non-goals

No synthetic/random jitter (fabricates realism the data doesn't support, and
contradicts the product's "honest to the millisecond" framing). No batching,
speculative decoding, KV eviction, thermal throttling, or memory-pressure
modeling — no contributor-submitted data supports any of these.

## Design

### Phase 1 — Integrate instead of point-sample (behavior-preserving beyond last measured depth)

Replace point-sampled `ppRate`/`tgRate` with a trapezoidal integral of
per-token time (`1/rate`, interpolated linearly in _time_ between measured
depths — the physically appropriate quantity) across the actual depth span:

- Decode integrates across `[contextBefore, contextAfter]`.
- Prefill integrates across `[effectiveCachedPrefix, withoutCachePrefillTokens]`
  (the tokens that actually need reprocessing — this also fixes a cache-bust
  edge case where reprocessed tokens were priced only at the end-depth rate).
- `measuredPrefillMs` is recalibrated: derive an implied fixed overhead from
  the full-depth measured TTFT (`measuredTtft - integral(0, fullDepth)`,
  clamped to a sane floor, falling back to `overheadMs` if implausible), then
  apply that same overhead once to the actual partial-prefill integral. This
  is self-consistent for a cold prefill and fixes the double-counting /
  inconsistent-overhead bug between the measured and computed code paths.
- `ppRate`/`tgRate` on `TimelineEvent` become the _effective average rate_
  implied by the integral (`tokens / (ms/1000)`), keeping existing UI
  read-sites (`SessionHeader`, `RaceLane`, `PhaseState`) valid without
  changes.
- Beyond the last measured depth, behavior is unchanged in this phase
  (flat clamp) — extrapolation honesty is Phase 2's job, kept separate for
  isolated review.

### Phase 2 — Honest extrapolation model + confidence tiers

Four confidence tiers per depth, up from today's binary
measured/extrapolated:

1. **measured** — exact submitted depth.
2. **interpolated** — between two measured points.
3. **extrapolated-fitted** — beyond the last measured point, ≥2 points
   available: fit a line to per-token time vs. depth (least squares, slope
   clamped to ≥0) and extrapolate the trend.
4. **extrapolated-unsupported** — beyond the only measured point (single-point
   result): no trend derivable. Simulated pace holds flat at that single
   point (same numeric fallback as tier 3 would use for its optimistic
   bound), but is flagged as "no depth data" rather than "extrapolated" —
   there's no real basis at all, vs. a real (if speculative) trend.

For tier 3, canonical playback follows the fitted line (realistic, slower);
the old flat-clamp value becomes the _optimistic_ bound of a range rather
than the only answer. Adds an optional `ppStddev`/`tgStddev` per-measurement
field (schema + type + converter passthrough where llama-bench emits it) —
purely additive, used in Phase 3 to widen ranges when contributors supply
it.

### Phase 3 — Range propagation to summaries & race verdicts

`TimelineSummary` gains `wallTimeRangeMs: {min, max}` and a time-weighted
`nonMeasuredTimeShare` (fraction of wall time resting on tier 3/4 rates).
Race verdict logic: if both lanes' ranges overlap, report "too close to call
from this data" instead of a confident winner from a point estimate.
`RaceGapBreakdown` gets a chip surfacing each lane's non-measured time share.

### Phase 4 — Visualization

- `DepthRateCurve` becomes a real line chart: measured points as dots, solid
  interpolated line, dashed/shaded band for the fitted-extrapolation region
  (visually distinct hatching for the unsupported/single-point case), with a
  live depth-cursor marker during playback.
- `TimelineStrip` gets a visual treatment marking which scenario segments run
  on tier 3/4 data.
- `PhaseState` (the dominant live readout) gets an inline confidence badge
  when the active event's rate is non-measured/interpolated.
- Decode cadence follows the integrated time curve (precomputed per-token
  cumulative timing) instead of a flat linear reveal, so pacing visibly
  decelerates in long generations — no synthetic jitter, purely the real
  depth-dependent rate.
- `ContextMeter` gets a "data ends here" tick at the last measured depth,
  derived from data already collected.

### Phase 5 — Docs

`MethodPage.tsx` and `CONTRIBUTING.md` updated to describe the four-tier
confidence model, range framing, and the optional stddev field.

## Process

Implemented via a multi-agent workflow: sequential phases (each depends on
the previous phase's code), with a parallel multi-lens review (runtime
execution / cold adversarial / completeness critic) + fix + re-verify gate
between every phase before moving on.
