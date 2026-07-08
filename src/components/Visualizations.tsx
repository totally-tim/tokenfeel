import { AlertTriangle, Database, FileText, Link as LinkIcon, Sigma } from "lucide-react";
import { formatClock, formatNumber, formatRate, formatTokens, percent } from "../lib/format";
import type { RaceWinner } from "../lib/raceComparison";
import type { BenchmarkResult, Timeline, TimelineEvent, TimelineSummary } from "../types";

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

export function TimelineStrip({ timeline, activeIndex }: { timeline: Timeline; activeIndex: number }) {
  return (
    <div className="timeline-strip" aria-label="Scenario phase map">
      {timeline.events.map((event) => {
        const total = Math.max(1, event.endMs - event.startMs);
        return (
          <span key={event.id} className={event.index === activeIndex ? "active" : ""}>
            <i className="phase-tool" style={{ width: `${pct(event.toolLatencyMs, total)}%` }} />
            <i className="phase-prefill" style={{ width: `${pct(event.prefillMs, total)}%` }} />
            <i className="phase-decode" style={{ width: `${pct(event.decodeMs, total)}%` }} />
          </span>
        );
      })}
    </div>
  );
}

export function CacheLedger({
  summary,
  activeEvent
}: {
  summary: TimelineSummary;
  activeEvent: TimelineEvent;
}) {
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
        {percent(summary.cacheSavedRatio)} less prompt processing. {activeEvent.cacheBust ? "Cache bust: " + (activeEvent.cacheBust.reason ?? "partial prefix retained") : "Append-only prefix reuse."}
      </p>
    </div>
  );
}

export function DepthRateCurve({ result }: { result: BenchmarkResult }) {
  const maxPrefillRate = Math.max(...result.measurements.map((point) => point.pp), 1);
  const maxDecodeRate = Math.max(...result.measurements.map((point) => point.tg), 1);
  return (
    <div className="depth-curve">
      <div className="viz-title">
        <Sigma size={14} />
        <span>depth curve</span>
      </div>
      <div className="depth-rows">
        {result.measurements.map((point) => (
          <div key={point.depth} className="depth-row">
            <span>{formatTokens(point.depth)} ctx</span>
            <div>
              <i className="curve-pp" style={{ width: `${Math.max(2, pct(point.pp, maxPrefillRate))}%` }} />
              <i className="curve-tg" style={{ width: `${Math.max(2, pct(point.tg, maxDecodeRate))}%` }} />
            </div>
            <strong>{formatRate(point.tg)}</strong>
          </div>
        ))}
      </div>
      <small><i className="legend cached" /> pp <i className="legend reprefill" /> tg · flat beyond last measured depth</small>
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
      {result.benchmark?.command && (
        <code>{result.benchmark.command}</code>
      )}
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
          <strong>{row.delta >= 0 ? "+" : "-"}{formatClock(Math.abs(row.delta))}</strong>
        </div>
      ))}
      <div className="non-measured-chips">
        <span className="non-measured-chip">A extrapolated {percent(left.nonMeasuredTimeShare)}</span>
        <span className="non-measured-chip">B extrapolated {percent(right.nonMeasuredTimeShare)}</span>
      </div>
    </div>
  );
}

export function QualityFlags({ result, extrapolatedEvents = 0 }: { result: BenchmarkResult; extrapolatedEvents?: number }) {
  const flags = [
    result.measurements.length < 2 ? "single point" : `${result.measurements.length} depths`,
    result.evidence?.rawUrl || result.source.raw ? "raw linked" : "source only",
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
