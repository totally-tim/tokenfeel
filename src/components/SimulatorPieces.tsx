import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  Gauge,
  MessageSquare,
  Play,
  Square,
  Terminal,
  Wrench
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref
} from "react";
import { formatClock, formatNumber, formatRate, formatTokens } from "../lib/format";
import type {
  BenchmarkResult,
  CacheMode,
  Catalog,
  RateConfidence,
  RuntimeMetadata,
  ScenarioEvent,
  Timeline,
  TimelineEvent,
  TimelineSummary
} from "../types";
import { compactResultLabel, resultMeta } from "../lib/catalog";
import { maxMeasuredDepth } from "../lib/catalogQuality";
import { StatusBadge } from "./StatusBadge";
import { isGeneratedEvent, streamFrameForEvent } from "../lib/streaming";
import { PhaseWaterfall, QualityFlags } from "./Visualizations";
import { filterPickerOptions } from "../lib/pickerOptions";
import type { MatrixOption } from "../lib/configMatrix";
import { phaseCopyForEvent, statFootItems, turnMetricForEvent } from "../lib/phaseCopy";
import { cadenceDurationMs, phaseTrackVisualState, sweepDurationMs } from "../lib/phaseProgress";
import { raceOutputWindow } from "../lib/raceOutput";
import { activePhaseForEvent, type PhaseKind } from "../lib/activePhase";

function PhaseIcon({ kind }: { kind: PhaseKind }) {
  if (kind === "prefill") return <Cpu size={15} />;
  if (kind === "decode") return <Gauge size={15} />;
  if (kind === "tool") return <Wrench size={15} />;
  if (kind === "complete") return <Check size={15} />;
  return <Clock size={15} />;
}

// Badge copy for the dominant "NOW" readout when the active phase's rate
// isn't backed by measured/interpolated data — surfaced inline instead of
// buried in QualityFlags inside a Disclosure, since this is the primary
// reading path during playback.
function confidenceBadgeLabel(confidence: RateConfidence): string | undefined {
  if (confidence === "extrapolated-fitted") return "fitted estimate";
  if (confidence === "extrapolated-unsupported") return "no depth data";
  return undefined;
}

function compactPhaseLabel(kind: PhaseKind) {
  if (kind === "prefill") return "Prefill";
  if (kind === "decode") return "Decode";
  if (kind === "tool") return "Tool wait";
  if (kind === "complete") return "Complete";
  if (kind === "instant") return "Instant";
  return "Queued";
}

// The dominant "NOW" block. One shared vocabulary for every simulation state,
// each with a distinct color + motion signature so the phase is unmistakable.
export function PhaseState({
  event,
  elapsedMs,
  hasStarted,
  complete
}: {
  event: TimelineEvent;
  elapsedMs: number;
  hasStarted: boolean;
  complete: boolean;
}) {
  const phase = activePhaseForEvent(event, elapsedMs, hasStarted, complete);
  const copy = phaseCopyForEvent(event, phase.kind);
  const streamFrame = streamFrameForEvent(event, elapsedMs);
  const processedPromptTokens = Math.round(event.prefillTokens * phase.progress);
  const waiting = phase.kind === "idle";
  const phaseTokens =
    phase.kind === "prefill"
      ? `${formatTokens(processedPromptTokens)} / ${formatTokens(event.prefillTokens)} ${copy.tokenLabel}`
      : phase.kind === "decode"
        ? `${formatNumber(streamFrame.tokens)} / ${formatNumber(event.tokens)} ${copy.tokenLabel}`
        : phase.kind === "tool"
          ? copy.tokenLabel
          : phase.kind === "complete"
            ? copy.tokenLabel
            : copy.tokenLabel;
  const phaseRate =
    phase.kind === "prefill"
      ? `${formatRate(event.ppRate)} prompt`
      : phase.kind === "decode"
        ? `${formatRate(event.tgRate)} decode`
        : phase.kind === "tool"
          ? "tool bound"
          : phase.kind === "complete"
            ? "done"
            : "idle";
  const activeConfidence =
    phase.kind === "prefill" ? event.ppConfidence : phase.kind === "decode" ? event.tgConfidence : undefined;
  const confidenceBadge = activeConfidence ? confidenceBadgeLabel(activeConfidence) : undefined;
  const trackVisual = phaseTrackVisualState(phase.progress, waiting);
  const trackStyle = {
    "--phase-fill-width": trackVisual.fillWidth,
    "--phase-pip-left": trackVisual.pipLeft,
    "--cadence-duration": `${cadenceDurationMs(event.tgRate)}ms`,
    "--sweep-duration": `${sweepDurationMs(event.ppRate)}ms`
  } as CSSProperties;

  return (
    <div className={`phase-state phase-state-${phase.kind}`}>
      <div className="phase-state-head">
        <span className="phase-state-name">
          <PhaseIcon kind={phase.kind} />
          {copy.label}
        </span>
        <strong>
          {formatClock(phase.elapsedMs)} / {formatClock(phase.totalMs)}
        </strong>
      </div>
      <div
        className="phase-state-track"
        role="progressbar"
        aria-valuenow={trackVisual.ariaValueNow}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${trackVisual.ariaValueNow}% ${copy.label}`}
        aria-label={copy.label}
        style={trackStyle}
      >
        {waiting && <em className="phase-dot" />}
        <span className="phase-fill">{phase.kind === "prefill" && <i className="phase-sweep" />}</span>
        {phase.kind === "decode" && <b className="phase-pip" />}
      </div>
      <div className="phase-state-meta">
        <span>{phaseTokens}</span>
        <span className="phase-rate-group">
          {phaseRate}
          {confidenceBadge && activeConfidence && (
            <em className={`confidence-badge confidence-badge-${activeConfidence}`}>{confidenceBadge}</em>
          )}
        </span>
      </div>
      <p>{copy.detail}</p>
    </div>
  );
}

// Progressive-disclosure wrapper: keeps diagnostics available but out of the
// primary reading path until the user asks for them.
export function Disclosure({
  label,
  children,
  defaultOpen = false
}: {
  label: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`disclosure ${open ? "open" : ""}`}>
      <button
        type="button"
        className="disclosure-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <ChevronRight size={13} />
        {label}
      </button>
      {open && <div className="disclosure-body">{children}</div>}
    </div>
  );
}

// Live while its event is streaming (expanded, auto-scrolling tail so the
// newest text stays in view); once that turn completes and playback moves
// on, collapses to a one-line summary via the shared Disclosure pattern,
// expandable back open to inspect the full finished trace. Shared between
// Transcript (Playground) and RaceLane (Race) -- see
// docs/superpowers/specs/2026-07-09-thinking-token-streaming-design.md.
export function ThinkingStream({
  event,
  streamedText,
  streamedTokens,
  active,
  showCursor
}: {
  event: TimelineEvent;
  streamedText: string;
  streamedTokens: number;
  active: boolean;
  showCursor: boolean;
}) {
  const tailRef = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    if (!active) return;
    tailRef.current?.scrollIntoView({ block: "end" });
  }, [active, streamedText]);

  if (!active) {
    return (
      <Disclosure label={`Thought for ${formatClock(event.decodeMs)} · ${formatNumber(event.tokens)} tok`}>
        <div className="thinking-row">
          <div className="thinking-row-scroll">
            <p>{streamedText}</p>
          </div>
        </div>
      </Disclosure>
    );
  }

  return (
    <div className="thinking-row">
      <span>
        › THINKING · {formatNumber(streamedTokens)} / {formatNumber(event.tokens)} tokens
      </span>
      <div className="thinking-row-scroll">
        <p ref={tailRef}>
          {streamedText}
          {showCursor ? <span className="cursor">▍</span> : null}
        </p>
      </div>
    </div>
  );
}

interface SearchSelectProps {
  label: string;
  value: string;
  sub?: string;
  selectedValue: string | undefined;
  options: MatrixOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  limit?: number;
  /**
   * Compact rendering for tight toolbar contexts (Configs filter row): drops
   * the label/count caption row and shrinks the trigger to match neighboring
   * filter controls. Same combobox behavior either way -- this is a shared
   * component (design.md: "search pickers" are shared vocabulary across
   * Landing, Playground, Race, and Configs), not a parallel implementation.
   */
  compact?: boolean;
  disabled?: boolean;
}

export function SearchSelect({
  label,
  value,
  sub,
  selectedValue,
  options,
  onChange,
  placeholder = "Search",
  limit = 40,
  compact = false,
  disabled = false
}: SearchSelectProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const visibleOptions = useMemo(
    () => filterPickerOptions(options, query, selectedValue, limit),
    [limit, options, query, selectedValue]
  );

  // Reset the keyboard-highlighted row to the top whenever the panel opens
  // or the query narrows/widens the result set.
  useEffect(() => {
    setHighlightedIndex(0);
  }, [open, query]);

  // Clamp separately (rather than resetting to 0) when the option list
  // itself shrinks with the query unchanged -- e.g. a cascading filter
  // upstream narrows `options` while this panel is still open -- so arrow
  // keys never point past the end of the list and the highlight stays near
  // its prior position instead of jumping back to the top.
  useEffect(() => {
    setHighlightedIndex((index) => Math.min(index, Math.max(0, visibleOptions.length - 1)));
  }, [visibleOptions]);

  // A disabled trigger must not leave its popover open and interactive
  // behind it -- close and clear any in-progress search immediately.
  useEffect(() => {
    if (disabled && open) {
      setQuery("");
      setOpen(false);
    }
  }, [disabled, open]);

  useEffect(() => {
    if (!open) return;

    const close = () => {
      setQuery("");
      setOpen(false);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      close();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Keep the highlighted option scrolled into view as arrow keys move it.
  useEffect(() => {
    if (!open) return;
    const option = visibleOptions[highlightedIndex];
    if (!option) return;
    const node = rootRef.current?.querySelector(`#${CSS.escape(`${listboxId}-${highlightedIndex}`)}`);
    node?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex, open, visibleOptions, listboxId]);

  const choose = (nextValue: string) => {
    onChange(nextValue);
    setQuery("");
    setOpen(false);
    triggerRef.current?.focus();
  };

  // Arrow-key navigation + Enter-to-choose, matching the existing
  // Escape-to-close behavior so the listbox/option ARIA roles this component
  // advertises are backed by real keyboard behavior, not just mouse/pointer.
  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (visibleOptions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((index) => (index + 1) % visibleOptions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((index) => (index - 1 + visibleOptions.length) % visibleOptions.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = visibleOptions[highlightedIndex];
      if (option) choose(option.value);
    }
  };

  return (
    <div ref={rootRef} className={`search-select ${compact ? "compact" : ""} ${open ? "open" : ""}`}>
      {!compact && (
        <div className="search-select-label">
          <span>{label}</span>
          <small>{formatNumber(options.length)} choices</small>
        </div>
      )}
      <button
        ref={triggerRef}
        type="button"
        className="search-select-trigger"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`${label}: ${value}`}
        disabled={disabled}
      >
        <span>
          <strong>{value}</strong>
          {sub && <small>{sub}</small>}
        </span>
        <ChevronDown size={16} />
      </button>
      {open && !disabled && (
        <div className="search-select-panel">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder={placeholder}
            aria-label={`${label} search`}
            role="combobox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-activedescendant={visibleOptions[highlightedIndex] ? `${listboxId}-${highlightedIndex}` : undefined}
            aria-autocomplete="list"
            autoFocus
          />
          <div id={listboxId} className="search-select-results" role="listbox" aria-label={`${label} options`}>
            {visibleOptions.length === 0 ? (
              <p>No matches. Try hardware, model, runtime, backend, or quant.</p>
            ) : (
              visibleOptions.map((option, index) => (
                <button
                  key={option.value}
                  id={`${listboxId}-${index}`}
                  type="button"
                  tabIndex={-1}
                  className={[
                    option.value === selectedValue ? "active" : "",
                    index === highlightedIndex ? "focused" : ""
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => choose(option.value)}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  role="option"
                  aria-selected={option.value === selectedValue}
                >
                  <span>
                    <strong>{option.label}</strong>
                    {option.sub && <small>{option.sub}</small>}
                  </span>
                  {option.value === selectedValue && <Check size={15} />}
                </button>
              ))
            )}
          </div>
          {options.length > visibleOptions.length && (
            <span className="search-select-count">
              Showing {formatNumber(visibleOptions.length)} of {formatNumber(options.length)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

interface SpeedSelectorProps {
  speed: number;
  onSpeed: (speed: number) => void;
}

export function SpeedSelector({ speed, onSpeed }: SpeedSelectorProps) {
  return (
    <div className="speed-grid" role="group" aria-label="Playback speed">
      {[1, 2, 4, 8].map((item) => (
        <button key={item} type="button" className={speed === item ? "active" : ""} onClick={() => onSpeed(item)}>
          {item}×
        </button>
      ))}
    </div>
  );
}

interface CacheModeSelectorProps {
  mode: CacheMode;
  onMode: (mode: CacheMode) => void;
}

export function CacheModeSelector({ mode, onMode }: CacheModeSelectorProps) {
  const options: Array<{ value: CacheMode; label: string; title: string }> = [
    { value: "runtime", label: "runtime", title: "Use submitted runtime capability" },
    { value: "on", label: "force on", title: "Compare hypothetical prefix-cache support" },
    { value: "off", label: "off", title: "Worst-case no prompt cache" }
  ];

  return (
    <div className="cache-mode-grid" role="group" aria-label="Prompt cache mode">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={mode === option.value ? "active" : ""}
          onClick={() => onMode(option.value)}
          title={option.title}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

interface ScenarioCardProps {
  title: string;
  sub: string;
  active: boolean;
  type: string;
  onClick: () => void;
}

export function ScenarioCard({ title, sub, active, type, onClick }: ScenarioCardProps) {
  const Icon = type === "agent" ? Terminal : type === "reasoning" ? Brain : MessageSquare;
  return (
    <button className={`scenario-card ${active ? "active" : ""}`} type="button" onClick={onClick}>
      <Icon size={18} />
      <span>
        <strong>{title}</strong>
        <small>{sub}</small>
      </span>
      {active && <Check size={16} />}
    </button>
  );
}

interface ContextMeterProps {
  cached: number;
  reprefill: number;
  total: number;
  max?: number;
  compact?: boolean;
  /**
   * Depth of the last measured benchmark point (from `maxMeasuredDepth`,
   * shared with `catalogQuality`/`raceComparison`). When provided, renders a
   * "data ends here" tick on the meter track so it's visible how much of the
   * context window rests on measured versus extrapolated rates.
   */
  dataHorizon?: number;
}

export function ContextMeter({
  cached,
  reprefill,
  total,
  max = 128_000,
  compact = false,
  dataHorizon
}: ContextMeterProps) {
  const cachedPct = Math.min(100, (cached / max) * 100);
  const reprefillPct = Math.min(100 - cachedPct, (reprefill / max) * 100);
  const dataHorizonPct =
    dataHorizon !== undefined && dataHorizon >= 0 ? Math.min(100, (dataHorizon / max) * 100) : undefined;

  return (
    <div className={`context-meter ${compact ? "compact" : ""}`}>
      <div className="meter-head">
        <span>CONTEXT · CACHED vs RE-PREFILLED</span>
        <span>
          {formatTokens(total)} / {formatTokens(max)}
        </span>
      </div>
      <div className="meter-track">
        <span className="meter-cached" style={{ width: `${cachedPct}%` }} />
        <span className="meter-reprefill" style={{ width: `${reprefillPct}%` }} />
        {dataHorizonPct !== undefined && (
          <i
            className="meter-data-horizon"
            style={{ left: `${dataHorizonPct}%` }}
            title={`data ends here · ${formatTokens(dataHorizon ?? 0)} ctx`}
          />
        )}
      </div>
      {dataHorizonPct !== undefined && (
        <div className="meter-data-horizon-label" style={{ left: `${dataHorizonPct}%` }}>
          data ends here
        </div>
      )}
    </div>
  );
}

function eventLabel(event: ScenarioEvent) {
  if (event.role === "tool_call") return "TOOL CALL";
  if (event.role === "tool_result") return "TOOL RESULT";
  return event.role.toUpperCase();
}

export function Transcript({
  events,
  activeIndex,
  elapsedMs,
  cacheMode,
  runtimeCache
}: {
  events: TimelineEvent[];
  activeIndex: number;
  elapsedMs: number;
  cacheMode: CacheMode;
  runtimeCache: RuntimeMetadata["cache"];
}) {
  const visibleEvents = events.slice(0, Math.max(1, activeIndex + 1));
  const activeRef = useRef<HTMLElement | null>(null);
  const tailRef = useRef<HTMLElement | null>(null);
  const cacheEnabled = cacheMode === "on" || (cacheMode === "runtime" && runtimeCache === "prefix");
  const activeEvent = events[activeIndex];
  const activeStreamedText = activeEvent ? streamFrameForEvent(activeEvent, elapsedMs).text : "";

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // Keep the newest streamed text of the active event in view as it grows,
  // independent of the whole-article scroll above -- needed now that
  // generated text runs far longer than the transcript's visible height.
  useEffect(() => {
    tailRef.current?.scrollIntoView({ block: "end" });
  }, [activeIndex, activeStreamedText]);

  return (
    <div className="transcript">
      <div className="system-chip">
        <span>SYSTEM PROMPT · {cacheEnabled ? "cache eligible" : "cache off"}</span>
        <span>{cacheEnabled ? "prefix reusable" : "full prefill"}</span>
      </div>
      {visibleEvents.map((event) => {
        const active = event.index === activeIndex;
        const streamFrame = streamFrameForEvent(event, active ? elapsedMs : event.endMs);
        const streamedText = streamFrame.text;
        const streamedTokens = streamFrame.tokens;
        const showCursor = active && isGeneratedEvent(event) && streamedText.length < event.text.length;
        return (
          <article
            key={event.id}
            ref={active ? activeRef : undefined}
            className={`transcript-event event-${event.role} ${active ? "current" : ""}`}
          >
            <div className="event-head">
              <span>{eventLabel(event)}</span>
              <span>
                {isGeneratedEvent(event) && active
                  ? `${formatNumber(streamedTokens)} / ${formatNumber(event.tokens)} tok`
                  : `${formatNumber(event.tokens)} tok`}
              </span>
              {event.cacheBust && <span className="warn-text">re-prefilled · cache bust</span>}
            </div>
            {event.role === "tool_call" ? (
              <pre ref={active ? (tailRef as Ref<HTMLPreElement>) : undefined}>
                {streamedText}
                {showCursor ? <span className="cursor">▍</span> : null}
              </pre>
            ) : event.role === "tool_result" ? (
              <div className="tool-result">{event.text}</div>
            ) : event.role === "thinking" ? (
              <ThinkingStream
                event={event}
                streamedText={streamedText}
                streamedTokens={streamedTokens}
                active={active}
                showCursor={showCursor}
              />
            ) : (
              <p ref={active ? (tailRef as Ref<HTMLParagraphElement>) : undefined}>
                {streamedText}
                {showCursor ? <span className="cursor">▍</span> : null}
              </p>
            )}
          </article>
        );
      })}
    </div>
  );
}

interface SessionHeaderProps {
  catalog: Catalog;
  title: string;
  result: BenchmarkResult;
  activeEvent: TimelineEvent;
  hasStarted: boolean;
  isComplete: boolean;
}

export function SessionHeader({ catalog, title, result, activeEvent, hasStarted, isComplete }: SessionHeaderProps) {
  return (
    <div className="session-header">
      <div>
        <h1>{title}</h1>
        <p>
          {compactResultLabel(catalog, result)} · {result.quant.toUpperCase()} · {result.runtime.name}/
          {result.runtime.backend}
        </p>
      </div>
      <div className="session-header-right">
        <StatusBadge status={!hasStarted ? "idle" : isComplete ? "finished" : "generating"} />
        <div className="live-rate">
          <strong>{formatRate(activeEvent.tgRate)}</strong>
          <span>turn {activeEvent.index + 1}</span>
        </div>
      </div>
    </div>
  );
}

export function StatFoot({ summary }: { summary: TimelineSummary }) {
  const stats = statFootItems(summary);
  return (
    <div className="stat-foot">
      {stats.map(({ label, value }) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

interface LaneProps {
  catalog: Catalog;
  label: string;
  result: BenchmarkResult;
  timeline: Timeline;
  summary: TimelineSummary;
  activeEvent: TimelineEvent;
  elapsedMs: number;
  hasStarted: boolean;
  winner?: boolean;
}

export function RaceLane({
  catalog,
  label,
  result,
  timeline,
  summary,
  activeEvent,
  elapsedMs,
  hasStarted,
  winner = false
}: LaneProps) {
  const complete = hasStarted && elapsedMs >= timeline.totalMs;
  const active = hasStarted && !complete;
  const phase = activePhaseForEvent(activeEvent, elapsedMs, hasStarted, complete);
  const outputEvents = raceOutputWindow(timeline.events, activeEvent.index, 4, hasStarted);
  const activeOutputRef = useRef<HTMLElement | null>(null);
  const tailRef = useRef<HTMLElement | null>(null);
  const activeStreamedText = streamFrameForEvent(activeEvent, elapsedMs).text;
  const laneRate = phase.kind === "prefill" ? activeEvent.ppRate : activeEvent.tgRate;
  const laneRateKind = !hasStarted
    ? "projected"
    : phase.kind === "prefill"
      ? "prompt"
      : phase.kind === "tool"
        ? "tool wait"
        : "decode";
  const labelParts = compactResultLabel(catalog, result).split(" · ");
  const laneStatus = complete
    ? formatClock(summary.wallTimeMs)
    : active
      ? `turn ${activeEvent.index + 1} live`
      : "ready";
  const primaryLabel = complete ? "FINAL ELAPSED" : active ? "CURRENT PHASE" : "READY";
  const primaryValue = complete ? formatClock(summary.wallTimeMs) : active ? compactPhaseLabel(phase.kind) : "Ready";
  const progressValue = active ? `${Math.round(phase.progress * 100)}% phase` : `${timeline.events.length} turns`;

  useEffect(() => {
    activeOutputRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeEvent.index]);

  // Keep the newest streamed text of the active event in view as it grows,
  // independent of the whole-card scroll above.
  useEffect(() => {
    tailRef.current?.scrollIntoView({ block: "end" });
  }, [activeEvent.index, activeStreamedText]);

  return (
    <section
      className={`race-lane ${label === "B" ? "lane-b" : "lane-a"} ${winner && complete ? "winner" : ""} ${active ? "active" : ""}`}
    >
      <div className="lane-stripe" />
      <div className="lane-inner">
        <div className="lane-head">
          <div>
            <div className="lane-title-row">
              <span className="lane-tag">LANE {label}</span>
              <h2>{labelParts[0]}</h2>
            </div>
            <p>
              {labelParts.slice(1).join(" · ")} · {result.runtime.name}/{result.runtime.backend}
            </p>
          </div>
          <span className={`lane-state-text ${active ? "live" : complete ? "done" : ""}`}>{laneStatus}</span>
        </div>
        <div className="lane-big">
          <div>
            <span>{primaryLabel}</span>
            <strong>{primaryValue}</strong>
          </div>
          <div>
            <strong>{formatRate(laneRate)}</strong>
            <span>
              {activeEvent.index + 1} / {timeline.events.length} · {laneRateKind} · {progressValue}
            </span>
          </div>
        </div>
        <div className="race-output-panel">
          <div className="race-output-head">
            <span>LIVE OUTPUT</span>
            <strong>
              turn {activeEvent.index + 1} · {eventLabel(activeEvent).toLowerCase()}
            </strong>
          </div>
          <div className="race-output-scroll" aria-label={`Lane ${label} live transcript`}>
            {outputEvents.length === 0 ? (
              <div className="race-output-empty">Start the race to stream this lane's transcript.</div>
            ) : (
              outputEvents.map((event) => {
                const eventActive = event.index === activeEvent.index;
                const eventElapsedMs = eventActive ? elapsedMs : event.endMs;
                const streamFrame = streamFrameForEvent(event, eventElapsedMs);
                const streamedText = streamFrame.text;
                const waitingForOutput =
                  eventActive &&
                  isGeneratedEvent(event) &&
                  streamedText.length === 0 &&
                  streamFrame.tokens === 0 &&
                  elapsedMs < event.endMs;
                const waitingCopy =
                  event.toolLatencyMs > 0 && elapsedMs < event.toolDoneMs
                    ? "Waiting on tool latency before output can stream."
                    : "Decode will stream here as soon as the first token arrives.";
                const showCursor = eventActive && isGeneratedEvent(event) && streamFrame.progress < 1;
                const eventMetric =
                  eventActive && isGeneratedEvent(event)
                    ? `${formatNumber(streamFrame.tokens)} / ${formatNumber(event.tokens)} tok`
                    : eventActive
                      ? turnMetricForEvent(event)
                      : `${formatNumber(event.tokens)} tok`;

                return (
                  <article
                    key={event.id}
                    ref={eventActive ? activeOutputRef : undefined}
                    className={`race-output-event event-${event.role} ${eventActive ? "current" : ""}`}
                  >
                    <div className="event-head">
                      <span>
                        turn {event.index + 1} · {eventLabel(event)}
                      </span>
                      <span>{eventMetric}</span>
                    </div>
                    {waitingForOutput ? (
                      <p className="race-output-waiting">{waitingCopy}</p>
                    ) : event.role === "tool_call" ? (
                      <pre ref={eventActive ? (tailRef as Ref<HTMLPreElement>) : undefined}>
                        {streamedText}
                        {showCursor ? <span className="cursor">▍</span> : null}
                      </pre>
                    ) : event.role === "tool_result" ? (
                      <div className="tool-result">{event.text}</div>
                    ) : event.role === "thinking" ? (
                      <ThinkingStream
                        event={event}
                        streamedText={streamedText}
                        streamedTokens={streamFrame.tokens}
                        active={eventActive}
                        showCursor={showCursor}
                      />
                    ) : (
                      <p ref={eventActive ? (tailRef as Ref<HTMLParagraphElement>) : undefined}>
                        {streamedText}
                        {showCursor ? <span className="cursor">▍</span> : null}
                      </p>
                    )}
                  </article>
                );
              })
            )}
          </div>
          {complete && (
            <p className="done-line">
              <Check size={14} /> finished in {formatClock(summary.wallTimeMs)}
            </p>
          )}
        </div>
        <PhaseState event={activeEvent} elapsedMs={elapsedMs} hasStarted={hasStarted} complete={complete} />
        <Disclosure label="Lane details · context, phases, provenance">
          <ContextMeter
            compact
            cached={activeEvent.cachedPrefixTokens}
            reprefill={activeEvent.prefillTokens}
            total={activeEvent.contextAfter}
            dataHorizon={maxMeasuredDepth(result)}
          />
          <PhaseWaterfall event={activeEvent} elapsedMs={elapsedMs} />
          <QualityFlags result={result} extrapolatedEvents={summary.extrapolatedEvents} />
          <SourceNote catalog={catalog} result={result} />
        </Disclosure>
      </div>
    </section>
  );
}

export function PlayButton({
  isPlaying,
  onPlay,
  onStop,
  hasStarted = false
}: {
  isPlaying: boolean;
  onPlay: () => void;
  onStop?: () => void;
  hasStarted?: boolean;
}) {
  const action = isPlaying && onStop ? onStop : onPlay;
  return (
    <button className={`play-button ${isPlaying ? "stop" : ""}`} type="button" onClick={action}>
      {isPlaying ? <Square size={17} /> : <Play size={17} />}
      {isPlaying ? "Stop" : hasStarted ? "Replay session" : "Play session"}
    </button>
  );
}

export function SourceNote({ catalog, result }: { catalog: Catalog; result: BenchmarkResult }) {
  const raw = result.evidence?.rawUrl || result.source.raw ? "raw evidence" : "source citation";
  return (
    <a className="source-note" href={result.source.url} target="_blank" rel="noreferrer">
      {result.status} · {result.source.kind} · {raw} · {resultMeta(catalog, result)}
    </a>
  );
}
