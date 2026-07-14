import { useId, useMemo } from "react";
import { AlertTriangle, Database, FileText, Link as LinkIcon, Sigma } from "lucide-react";
import { formatClock, formatRate, formatTokens, percent } from "../lib/format";
import { hasAnyRawEvidence } from "../lib/catalogQuality";
import type { RaceWinner } from "../lib/raceComparison";
import { fitTimePerTokenLinear, msPerTokenRangeAt, rateToMsPerToken } from "../sim/timing";
import type {
  BenchmarkMeasurement,
  BenchmarkResult,
  RateConfidence,
  Timeline,
  TimelineEvent,
  TimelineSummary
} from "../types";

function pct(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (value / total) * 100));
}

function sourceRawLabel(result: BenchmarkResult): string {
  if (result.evidence?.rawUrl) return "raw log";
  if (result.source.raw) return "attached raw";
  return "source only";
}

export function PhaseWaterfall({
  event,
  elapsedMs,
  compact = false
}: {
  event: TimelineEvent;
  elapsedMs: number;
  compact?: boolean;
}) {
  const total = Math.max(1, event.endMs - event.startMs);
  const progress = pct(elapsedMs - event.startMs, total);
  const segments = [
    { key: "tool", label: "tool", value: event.toolLatencyMs, className: "phase-tool" },
    { key: "prefill", label: "prefill", value: event.prefillMs, className: "phase-prefill" },
    { key: "decode", label: "decode", value: event.decodeMs, className: "phase-decode" }
  ].filter((segment) => segment.value > 0);

  return (
    <div className={`phase-waterfall ${compact ? "compact" : ""}`}>
      <div className="phase-head">
        <span>REQUEST PHASES</span>
        <strong>{formatClock(total)}</strong>
      </div>
      <div className="phase-track" aria-label={`Request phase progress ${Math.round(progress)} percent`}>
        {segments.length === 0 ? (
          <span className="phase-instant" style={{ width: "100%" }} />
        ) : (
          segments.map((segment) => (
            <span
              key={segment.key}
              className={segment.className}
              style={{ width: `${Math.max(3, pct(segment.value, total))}%` }}
              title={`${segment.label}: ${formatClock(segment.value)}`}
            />
          ))
        )}
        <i style={{ left: `${progress}%` }} />
      </div>
      {!compact && (
        <div className="phase-labels">
          {segments.map((segment) => (
            <span key={segment.key}>
              {segment.label} {formatClock(segment.value)}
            </span>
          ))}
          {segments.length === 0 && <span>instant event</span>}
        </div>
      )}
    </div>
  );
}

// Beyond "measured"/"interpolated", segments running on a fitted trend or an
// unsupported single-point guess get their own class so the timeline map
// distinguishes real depth data from a guess at a glance.
function confidenceClass(confidence: RateConfidence): string {
  if (confidence === "extrapolated-fitted") return "confidence-fitted";
  if (confidence === "extrapolated-unsupported") return "confidence-unsupported";
  return "";
}

export function TimelineStrip({ timeline, activeIndex }: { timeline: Timeline; activeIndex: number }) {
  return (
    <div className="timeline-strip" aria-label="Scenario phase map">
      {timeline.events.map((event) => {
        const total = Math.max(1, event.endMs - event.startMs);
        return (
          <span key={event.id} className={event.index === activeIndex ? "active" : ""}>
            <i className="phase-tool" style={{ width: `${pct(event.toolLatencyMs, total)}%` }} />
            <i
              className={`phase-prefill ${confidenceClass(event.ppConfidence)}`}
              style={{ width: `${pct(event.prefillMs, total)}%` }}
              title={event.ppConfidence !== "measured" ? `prefill rate: ${event.ppConfidence}` : undefined}
            />
            <i
              className={`phase-decode ${confidenceClass(event.tgConfidence)}`}
              style={{ width: `${pct(event.decodeMs, total)}%` }}
              title={event.tgConfidence !== "measured" ? `decode rate: ${event.tgConfidence}` : undefined}
            />
          </span>
        );
      })}
    </div>
  );
}

export function CacheLedger({ summary, activeEvent }: { summary: TimelineSummary; activeEvent: TimelineEvent }) {
  const savedTokens = Math.max(0, summary.prefilledWithoutCache - summary.prefilledWithCache);
  return (
    <div className="cache-ledger">
      <div>
        <span>with cache</span>
        <strong>{formatTokens(summary.prefilledWithCache)}</strong>
      </div>
      <div>
        <span>without</span>
        <strong>{formatTokens(summary.prefilledWithoutCache)}</strong>
      </div>
      <div>
        <span>saved</span>
        <strong>{formatTokens(savedTokens)}</strong>
      </div>
      <div>
        <span>this turn</span>
        <strong>{formatTokens(activeEvent.prefillTokens)}</strong>
      </div>
      <p>
        {percent(summary.cacheSavedRatio)} less prompt processing.{" "}
        {activeEvent.cacheBust
          ? "Cache bust: " + (activeEvent.cacheBust.reason ?? "partial prefix retained")
          : "Append-only prefix reuse."}
      </p>
    </div>
  );
}

interface CurvePoint {
  depth: number;
  rate: number;
}

interface RateCurveGeometry {
  measuredPoints: CurvePoint[];
  fittedPoints: CurvePoint[];
  activePoint?: CurvePoint;
  horizonDepth: number;
  singlePoint: boolean;
}

const DEPTH_CURVE_DISPLAY_HORIZON_MULTIPLIER = 1.6;
const DEPTH_CURVE_FIT_STEPS = 24;

function rateCurveGeometry(
  measurements: BenchmarkMeasurement[],
  field: "pp" | "tg",
  activeDepth?: number
): RateCurveGeometry {
  const points = [...measurements].sort((a, b) => a.depth - b.depth);
  const lastDepth = points[points.length - 1].depth;
  const horizonDepth = Math.max(lastDepth * DEPTH_CURVE_DISPLAY_HORIZON_MULTIPLIER, activeDepth ?? 0, lastDepth + 1);
  const measuredPoints: CurvePoint[] = points.map((point) => ({ depth: point.depth, rate: point[field] }));

  // Beyond the last measured depth, follow the least-squares fitted
  // per-token-time trend (converted back to a rate) rather than the old
  // flat clamp. Anchored to the last measured point exactly like
  // `msPerTokenRangeAt`/`integrateTimeRangeMs` in timing.ts, so the drawn
  // line is continuous with the last measured dot and matches the live
  // depth-cursor marker instead of the unconstrained global regression line.
  const fit = fitTimePerTokenLinear(points, field);
  const fittedPoints: CurvePoint[] = [];
  if (fit) {
    const lastPoint = points[points.length - 1];
    const anchorMs = rateToMsPerToken(lastPoint[field]);
    for (let step = 0; step <= DEPTH_CURVE_FIT_STEPS; step += 1) {
      const depth = lastDepth + ((horizonDepth - lastDepth) * step) / DEPTH_CURVE_FIT_STEPS;
      const msPerToken = anchorMs + fit.slope * (depth - lastDepth);
      if (msPerToken > 0) {
        fittedPoints.push({ depth, rate: 1000 / msPerToken });
      }
    }
  }

  let activePoint: CurvePoint | undefined;
  if (activeDepth !== undefined && activeDepth >= 0) {
    const canonicalMs = msPerTokenRangeAt(points, field, activeDepth).canonicalMs;
    if (canonicalMs > 0) {
      activePoint = { depth: activeDepth, rate: 1000 / canonicalMs };
    }
  }

  return { measuredPoints, fittedPoints, activePoint, horizonDepth, singlePoint: points.length === 1 };
}

const CURVE_WIDTH = 300;
const CURVE_HEIGHT = 92;
const CURVE_PADDING = { top: 10, right: 10, bottom: 8, left: 6 };

function RateCurvePanel({
  title,
  measurements,
  field,
  activeDepth
}: {
  title: string;
  measurements: BenchmarkMeasurement[];
  field: "pp" | "tg";
  activeDepth?: number;
}) {
  const geometry = useMemo(
    () => rateCurveGeometry(measurements, field, activeDepth),
    [measurements, field, activeDepth]
  );
  const hatchId = useId();

  const innerWidth = CURVE_WIDTH - CURVE_PADDING.left - CURVE_PADDING.right;
  const innerHeight = CURVE_HEIGHT - CURVE_PADDING.top - CURVE_PADDING.bottom;
  const maxRate =
    Math.max(
      ...geometry.measuredPoints.map((point) => point.rate),
      ...geometry.fittedPoints.map((point) => point.rate),
      geometry.activePoint?.rate ?? 0,
      1
    ) * 1.12;

  const xScale = (depth: number) =>
    CURVE_PADDING.left + (geometry.horizonDepth <= 0 ? 0 : (depth / geometry.horizonDepth) * innerWidth);
  const yScale = (rate: number) => CURVE_PADDING.top + innerHeight - (rate / maxRate) * innerHeight;
  const toPath = (curvePoints: CurvePoint[]) =>
    curvePoints
      .map(
        (point, index) =>
          `${index === 0 ? "M" : "L"} ${xScale(point.depth).toFixed(2)} ${yScale(point.rate).toFixed(2)}`
      )
      .join(" ");

  const lastMeasured = geometry.measuredPoints[geometry.measuredPoints.length - 1];
  const firstMeasured = geometry.measuredPoints[0];

  // The shaded band between the fitted canonical trend and the flat
  // optimistic bound (`msPerTokenRangeAt`'s old flat-clamp value, i.e. the
  // last measured rate held constant) — same range framing as
  // `RaceGapBreakdown`/`wallTimeRangeMs` elsewhere in the app.
  const bandPath =
    geometry.fittedPoints.length > 1
      ? `${toPath(geometry.fittedPoints)} L ${xScale(geometry.horizonDepth).toFixed(2)} ${yScale(lastMeasured.rate).toFixed(2)} L ${xScale(lastMeasured.depth).toFixed(2)} ${yScale(lastMeasured.rate).toFixed(2)} Z`
      : undefined;

  return (
    <div className={`rate-curve rate-curve-${field}`}>
      <div className="rate-curve-head">
        <span>{title}</span>
        <strong>{formatRate(lastMeasured.rate)}</strong>
      </div>
      <svg
        className="rate-curve-svg"
        viewBox={`0 0 ${CURVE_WIDTH} ${CURVE_HEIGHT}`}
        role="img"
        aria-label={`${title} versus context depth, ${geometry.singlePoint ? "single measured point, no data beyond it" : "measured up to " + formatTokens(lastMeasured.depth) + " tokens, fitted trend beyond"}`}
      >
        <defs>
          <pattern id={hatchId} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="4" className="rate-curve-hatch-line" />
          </pattern>
        </defs>
        {bandPath && <path className="rate-curve-band" d={bandPath} />}
        {geometry.singlePoint && (
          <rect
            className="rate-curve-no-data-fill"
            x={xScale(firstMeasured.depth)}
            y={CURVE_PADDING.top}
            width={Math.max(0, xScale(geometry.horizonDepth) - xScale(firstMeasured.depth))}
            height={innerHeight}
            fill={`url(#${hatchId})`}
          />
        )}
        {geometry.singlePoint && (
          <line
            className="rate-curve-no-data"
            x1={xScale(firstMeasured.depth)}
            y1={yScale(firstMeasured.rate)}
            x2={xScale(geometry.horizonDepth)}
            y2={yScale(firstMeasured.rate)}
          />
        )}
        {geometry.measuredPoints.length > 1 && (
          <path className="rate-curve-line-measured" d={toPath(geometry.measuredPoints)} fill="none" />
        )}
        {geometry.fittedPoints.length > 1 && (
          <path className="rate-curve-line-fitted" d={toPath(geometry.fittedPoints)} fill="none" />
        )}
        {geometry.measuredPoints.map((point) => (
          <circle
            key={point.depth}
            className="rate-curve-dot"
            cx={xScale(point.depth)}
            cy={yScale(point.rate)}
            r={2.75}
          />
        ))}
        {geometry.activePoint && (
          <g className="rate-curve-active">
            <line
              x1={xScale(geometry.activePoint.depth)}
              x2={xScale(geometry.activePoint.depth)}
              y1={CURVE_PADDING.top}
              y2={CURVE_HEIGHT - CURVE_PADDING.bottom}
            />
            <circle cx={xScale(geometry.activePoint.depth)} cy={yScale(geometry.activePoint.rate)} r={3.75} />
          </g>
        )}
      </svg>
      <div className="rate-curve-foot">
        <span>{formatTokens(firstMeasured.depth)} ctx</span>
        <span>
          {geometry.singlePoint ? "no data beyond here" : `fitted beyond ${formatTokens(lastMeasured.depth)}`}
        </span>
        <span>{formatTokens(geometry.horizonDepth)} ctx</span>
      </div>
    </div>
  );
}

export function DepthRateCurve({ result, activeDepth }: { result: BenchmarkResult; activeDepth?: number }) {
  const singlePoint = result.measurements.length < 2;
  return (
    <div className="depth-curve">
      <div className="viz-title">
        <Sigma size={14} />
        <span>depth curve</span>
      </div>
      <div className="rate-curve-grid">
        <RateCurvePanel title="prefill tok/s" measurements={result.measurements} field="pp" activeDepth={activeDepth} />
        <RateCurvePanel title="decode tok/s" measurements={result.measurements} field="tg" activeDepth={activeDepth} />
      </div>
      <small>
        <i className="legend cached" /> measured · dashed = fitted extrapolation · shaded = range to optimistic bound
        {singlePoint ? " · hatched = no depth data beyond the single point" : ""}
      </small>
    </div>
  );
}

export function EvidencePanel({ result }: { result: BenchmarkResult }) {
  const evidenceHref = result.evidence?.rawUrl ?? result.source.url;
  return (
    <div className="evidence-panel">
      <div className="viz-title">
        <Database size={14} />
        <span>evidence</span>
      </div>
      <dl>
        <div>
          <dt>status</dt>
          <dd>{result.status}</dd>
        </div>
        <div>
          <dt>source</dt>
          <dd>{result.source.kind}</dd>
        </div>
        <div>
          <dt>raw</dt>
          <dd>{sourceRawLabel(result)}</dd>
        </div>
        <div>
          <dt>date</dt>
          <dd>{result.date}</dd>
        </div>
      </dl>
      <a href={evidenceHref} target="_blank" rel="noreferrer">
        <LinkIcon size={13} />
        {result.evidence?.rawUrl ? "Open raw evidence" : "Open source"}
      </a>
      {result.benchmark?.command && <code title={result.benchmark.command}>{result.benchmark.command}</code>}
    </div>
  );
}

export function RaceGapBreakdown({
  left,
  right,
  winner: raceWinner
}: {
  left: TimelineSummary;
  right: TimelineSummary;
  winner: RaceWinner;
}) {
  // "too-close" carries no lane preference of its own; fall back to the
  // point-estimate comparison so the phase breakdown below still has a
  // consistent sign (matches the pre-tri-state tie-breaking behavior).
  const leftWins = raceWinner === "left" || (raceWinner === "too-close" && left.wallTimeMs <= right.wallTimeMs);
  const winner = leftWins ? left : right;
  const loser = leftWins ? right : left;
  const rows = [
    { label: "prefill", delta: loser.prefillMs - winner.prefillMs, className: "phase-prefill" },
    { label: "decode", delta: loser.decodeMs - winner.decodeMs, className: "phase-decode" },
    { label: "tool", delta: loser.toolLatencyMs - winner.toolLatencyMs, className: "phase-tool" }
  ];
  const max = Math.max(...rows.map((row) => Math.abs(row.delta)), 1);

  return (
    <div className="gap-breakdown">
      <div className="viz-title">
        <FileText size={14} />
        <span>gap breakdown</span>
      </div>
      {rows.map((row) => (
        <div className="gap-row" key={row.label}>
          <span>{row.label}</span>
          <div>
            <i className={row.className} style={{ width: `${Math.max(2, pct(Math.abs(row.delta), max))}%` }} />
          </div>
          <strong>
            {row.delta >= 0 ? "+" : "-"}
            {formatClock(Math.abs(row.delta))}
          </strong>
        </div>
      ))}
      <div className="non-measured-chips">
        <span className="non-measured-chip">A extrapolated {percent(left.nonMeasuredTimeShare)}</span>
        <span className="non-measured-chip">B extrapolated {percent(right.nonMeasuredTimeShare)}</span>
      </div>
    </div>
  );
}

export function QualityFlags({
  result,
  extrapolatedEvents = 0
}: {
  // `hasSourceRaw` only exists on the compacted static-catalog row (see
  // StaticBenchmarkResult); a full detail row fetched via loadResultDetail
  // (ConfigsPage) has real source.raw/evidence.rawUrl instead but no
  // hasSourceRaw field, so this falls back to that check when absent.
  result: BenchmarkResult & { hasSourceRaw?: boolean };
  extrapolatedEvents?: number;
}) {
  const hasRaw = result.hasSourceRaw ?? hasAnyRawEvidence(result);
  const flags = [
    result.measurements.length < 2 ? "single point" : `${result.measurements.length} depths`,
    hasRaw ? "raw linked" : "source only",
    result.benchmark?.runs ? `${result.benchmark.runs} runs` : "runs unknown",
    extrapolatedEvents > 0 ? `${extrapolatedEvents} extrapolated` : "within measured range"
  ];

  return (
    <div className="quality-flags">
      <AlertTriangle size={14} />
      {flags.map((flag) => (
        <span key={flag}>{flag}</span>
      ))}
    </div>
  );
}
