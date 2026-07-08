import { Copy, GitCompare, Link, Play, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CacheModeSelector, Disclosure, RaceLane, SearchSelect, SpeedSelector } from "../components/SimulatorPieces";
import { RaceGapBreakdown } from "../components/Visualizations";
import {
  DEFAULT_SCENARIO_ID,
  createCatalogLookups,
  defaultLeftResultId,
  defaultRightResultId,
  getResult,
  getScenario,
  scenarioOptions
} from "../lib/catalog";
import { formatClock, formatTokens } from "../lib/format";
import {
  comparisonSummary,
  constraintsForFieldChange,
  raceFieldOptions,
  raceSetupOrders,
  raceVerdict,
  resolveRaceSelection,
  selectionFromResult,
  suggestComparableResults,
  type RaceSetupField,
  type RaceSetupMode
} from "../lib/raceComparison";
import { usePlayback } from "../hooks/usePlayback";
import { buildRaceShareUrl, parseRaceShareHash } from "../lib/raceShare";
import { raceNeedsSetupReset } from "../lib/raceSession";
import type { PageId } from "../lib/routing";
import type { BenchmarkResult, CacheMode, Catalog } from "../types";

interface RacePageProps {
  catalog: Catalog;
  onNavigate: (page: PageId) => void;
}

const supportedSpeeds = new Set([1, 2, 4, 8]);

const fieldLabels: Record<RaceSetupField, string> = {
  modelId: "Model",
  hardwareId: "Machine",
  runtimeKey: "Runtime",
  quant: "Quant"
};

const modeLabels: Record<RaceSetupMode, string> = {
  model: "Model",
  hardware: "Machine",
  runtime: "Runtime"
};

function initialRaceState(catalog: Catalog) {
  const parsed = parseRaceShareHash(window.location.hash);
  return resolveRaceState(catalog, parsed);
}

function resolveRaceState(catalog: Catalog, parsed: ReturnType<typeof parseRaceShareHash>) {
  const resultIds = new Set(catalog.results.map((result) => result.id));
  const scenarioIds = new Set(catalog.scenarios.map((scenario) => scenario.id));

  return {
    leftId: parsed.leftId && resultIds.has(parsed.leftId) ? parsed.leftId : defaultLeftResultId(catalog),
    rightId: parsed.rightId && resultIds.has(parsed.rightId) ? parsed.rightId : defaultRightResultId(catalog),
    scenarioId: parsed.scenarioId && scenarioIds.has(parsed.scenarioId) ? parsed.scenarioId : DEFAULT_SCENARIO_ID,
    speed: parsed.speed && supportedSpeeds.has(parsed.speed) ? parsed.speed : 1,
    cacheMode: parsed.cacheMode ?? "runtime"
  };
}

function constraintsBeforeField(selection: ReturnType<typeof selectionFromResult>, order: RaceSetupField[], field: RaceSetupField) {
  const constraints: Partial<ReturnType<typeof selectionFromResult>> = {};
  for (const priorField of order.slice(0, Math.max(0, order.indexOf(field)))) {
    constraints[priorField] = selection[priorField];
  }
  return constraints;
}

function selectedOptionLabel(options: Array<{ value: string; label: string; sub?: string }>, value: string) {
  return options.find((option) => option.value === value) ?? { value, label: value };
}

function totalScenarioTokens(scenario: Catalog["scenarios"][number]) {
  return scenario.systemPromptTokens + scenario.events.reduce((sum, event) => sum + event.tokens, 0);
}

function fieldPlaceholder(field: RaceSetupField) {
  if (field === "modelId") return "Search models";
  if (field === "hardwareId") return "Search machines";
  if (field === "runtimeKey") return "Search runtimes";
  return "Search quants";
}

function RaceSetupCard({
  catalog,
  lane,
  result,
  onResult
}: {
  catalog: Catalog;
  lane: "A" | "B";
  result: BenchmarkResult;
  onResult: (id: string) => void;
}) {
  const lookups = useMemo(() => createCatalogLookups(catalog), [catalog]);
  const [mode, setMode] = useState<RaceSetupMode>("model");
  const selection = selectionFromResult(result);
  const order = raceSetupOrders[mode];
  const hardware = lookups.hardwareById(result.hardware);
  const model = lookups.modelById(result.model);

  const changeField = (field: RaceSetupField, value: string) => {
    const constraints = constraintsForFieldChange(selection, order, field, value);
    onResult(resolveRaceSelection(catalog.results, selection, constraints).id);
  };

  return (
    <article className={`race-setup-card lane-${lane.toLowerCase()}`}>
      <div className="race-setup-card-head">
        <span>Lane {lane}</span>
        <div>
          <strong>{hardware?.shortName ?? result.hardware}</strong>
          <small>{model?.name ?? result.model}</small>
        </div>
      </div>

      <div className="setup-mode-tabs" role="group" aria-label={`Lane ${lane} setup starting point`}>
        {(Object.keys(modeLabels) as RaceSetupMode[]).map((item) => (
          <button key={item} type="button" className={mode === item ? "active" : ""} onClick={() => setMode(item)}>
            {modeLabels[item]}
          </button>
        ))}
      </div>

      <div className="setup-field-grid">
        {order.map((field) => {
          const constraints = constraintsBeforeField(selection, order, field);
          const options = raceFieldOptions(catalog.results, field, lookups, constraints);
          const selected = selectedOptionLabel(options, selection[field]);
          return (
            <SearchSelect
              key={field}
              label={fieldLabels[field]}
              value={selected.label}
              sub={selected.sub}
              selectedValue={selection[field]}
              options={options}
              onChange={(value) => changeField(field, value)}
              placeholder={fieldPlaceholder(field)}
              limit={50}
            />
          );
        })}
      </div>
    </article>
  );
}

export function RacePage({ catalog, onNavigate }: RacePageProps) {
  const lookups = useMemo(() => createCatalogLookups(catalog), [catalog]);
  const scenarioOptionItems = useMemo(() => scenarioOptions(catalog), [catalog]);
  const [initialState] = useState(() => initialRaceState(catalog));
  const [leftId, setLeftId] = useState(initialState.leftId);
  const [rightId, setRightId] = useState(initialState.rightId);
  const [scenarioId, setScenarioId] = useState(initialState.scenarioId);
  const [speed, setSpeed] = useState(initialState.speed);
  const [cacheMode, setCacheMode] = useState<CacheMode>(initialState.cacheMode);
  const [copyText, setCopyText] = useState("Copy link");

  const scenario = getScenario(catalog, scenarioId);
  const left = getResult(catalog, leftId);
  const right = getResult(catalog, rightId);
  const leftPlayback = usePlayback({ result: left, scenario, cacheMode, speed, autoStart: false });
  const rightPlayback = usePlayback({ result: right, scenario, cacheMode, speed, autoStart: false });
  const raceStarted = leftPlayback.hasStarted || rightPlayback.hasStarted;
  const raceRunning = leftPlayback.isPlaying || rightPlayback.isPlaying;
  const raceComplete = leftPlayback.isComplete && rightPlayback.isComplete;
  const verdict = raceVerdict(leftPlayback.summary, rightPlayback.summary);
  const gap = verdict.deltaMs;
  // "too-close" carries no lane preference of its own; fall back to the
  // point-estimate comparison so the gap sign stays consistent with RaceGapBreakdown.
  const leftLeads =
    verdict.winner === "left" ||
    (verdict.winner === "too-close" && leftPlayback.summary.wallTimeMs <= rightPlayback.summary.wallTimeMs);
  const comparison = useMemo(() => comparisonSummary(catalog, left, right), [catalog, left, right]);
  const suggestions = useMemo(() => suggestComparableResults(catalog, left, 3), [catalog, left]);
  const scenarioTokens = totalScenarioTokens(scenario);
  const shareUrl = useMemo(() => {
    return buildRaceShareUrl({ leftId, rightId, scenarioId, speed, cacheMode });
  }, [leftId, rightId, scenarioId, speed, cacheMode]);

  const raceElapsedMs = raceComplete
    ? Math.max(leftPlayback.summary.wallTimeMs, rightPlayback.summary.wallTimeMs)
    : raceStarted
      ? Math.max(
          Math.min(leftPlayback.elapsedMs, leftPlayback.timeline.totalMs),
          Math.min(rightPlayback.elapsedMs, rightPlayback.timeline.totalMs)
        )
      : 0;
  const raceClockLabel = raceComplete ? "finished" : raceRunning ? "running" : raceStarted ? "stopped" : "ready";
  const raceMeta = raceComplete
    ? `${formatClock(leftPlayback.summary.wallTimeMs)} vs ${formatClock(rightPlayback.summary.wallTimeMs)} final`
    : `${formatClock(leftPlayback.summary.wallTimeMs)} vs ${formatClock(rightPlayback.summary.wallTimeMs)} projected`;

  useEffect(() => {
    const onHash = () => {
      const parsed = parseRaceShareHash(window.location.hash);
      let next: ReturnType<typeof resolveRaceState>;
      try {
        next = resolveRaceState(catalog, parsed);
      } catch (error) {
        console.error("Failed to resolve race state from hash change", error);
        return;
      }
      setLeftId(next.leftId);
      setRightId(next.rightId);
      setScenarioId(next.scenarioId);
      setSpeed(next.speed);
      setCacheMode(next.cacheMode);
    };

    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [catalog]);

  useEffect(() => {
    const next = buildRaceShareUrl({ leftId, rightId, scenarioId, speed, cacheMode });
    if (window.location.href !== next) {
      window.history.replaceState(null, "", next);
    }
  }, [leftId, rightId, scenarioId, speed, cacheMode]);

  const startRace = () => {
    leftPlayback.restart();
    rightPlayback.restart();
  };

  const stopRace = () => {
    leftPlayback.reset();
    rightPlayback.reset();
  };

  const resetRaceForSetupChange = () => {
    if (!raceNeedsSetupReset({ leftStarted: leftPlayback.hasStarted, rightStarted: rightPlayback.hasStarted })) return;
    leftPlayback.reset();
    rightPlayback.reset();
  };

  const updateLeftId = (nextId: string) => {
    if (nextId === leftId) return;
    resetRaceForSetupChange();
    setLeftId(nextId);
  };

  const updateRightId = (nextId: string) => {
    if (nextId === rightId) return;
    resetRaceForSetupChange();
    setRightId(nextId);
  };

  const updateScenarioId = (nextScenarioId: string) => {
    if (nextScenarioId === scenarioId) return;
    resetRaceForSetupChange();
    setScenarioId(nextScenarioId);
  };

  const updateCacheMode = (nextMode: CacheMode) => {
    if (nextMode === cacheMode) return;
    resetRaceForSetupChange();
    setCacheMode(nextMode);
  };

  const copyRace = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopyText("Copied");
      setTimeout(() => setCopyText("Copy link"), 1200);
    } catch {
      setCopyText("Copy failed");
    }
  };

  return (
    <main className={`race-page full-height-page ${raceRunning ? "race-in-session" : ""}`}>
      <section className="race-workbench">
        <div className="race-workbench-head">
          <div className="race-title-block">
            <span className={`comparison-chip comparison-${comparison.level}`}>
              <GitCompare size={14} />
              {comparison.label}
            </span>
            <h1>{comparison.detail}</h1>
            <p>{raceMeta} · gap {formatClock(gap)} · {formatTokens(scenarioTokens)} context</p>
          </div>

          <div className="race-control-cluster">
            <button type="button" className={`run-race-button ${raceRunning ? "stop" : ""}`} onClick={raceRunning ? stopRace : startRace}>
              {raceRunning ? <Square size={15} /> : <Play size={16} />}
              {raceRunning ? "Stop" : "Start"}
            </button>
            <button type="button" className="secondary-button small quiet-share" onClick={copyRace} title={shareUrl}>
              <Link size={15} /> {copyText}
            </button>
            <SpeedSelector speed={speed} onSpeed={setSpeed} />
            <CacheModeSelector mode={cacheMode} onMode={updateCacheMode} />
            <button type="button" className="secondary-button small" onClick={() => onNavigate("configs")}>
              Configs
            </button>
          </div>
        </div>

        <div className="race-builder-grid">
          <RaceSetupCard catalog={catalog} lane="A" result={left} onResult={updateLeftId} />

          <article className="race-scenario-card">
            <SearchSelect
              label="Scenario"
              value={scenario.title}
              sub={`${scenario.events.length} events · ${formatTokens(scenarioTokens)} context`}
              selectedValue={scenarioId}
              options={scenarioOptionItems.map((option) => ({ value: option.value, label: option.title, sub: option.sub }))}
              onChange={updateScenarioId}
              placeholder="Search scenarios"
            />
            <div className="scenario-token-grid">
              <div>
                <span>System</span>
                <strong>{formatTokens(scenario.systemPromptTokens)}</strong>
              </div>
              <div>
                <span>Events</span>
                <strong>{scenario.events.length}</strong>
              </div>
              <div>
                <span>Script</span>
                <strong>{formatTokens(scenarioTokens)}</strong>
              </div>
            </div>
            <div className="suggestion-panel">
              <span>Suggested lane B</span>
              {suggestions.map((suggestion) => {
                const hardware = lookups.hardwareById(suggestion.result.hardware);
                const model = lookups.modelById(suggestion.result.model);
                return (
                  <button key={suggestion.result.id} type="button" onClick={() => updateRightId(suggestion.result.id)}>
                    <Copy size={13} />
                    <span>
                      <strong>{hardware?.shortName ?? suggestion.result.hardware}</strong>
                      <small>{model?.name ?? suggestion.result.model} · {suggestion.reason}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          </article>

          <RaceSetupCard catalog={catalog} lane="B" result={right} onResult={updateRightId} />
        </div>
      </section>

      <section className="lanes">
        <RaceLane
          catalog={catalog}
          label="A"
          result={left}
          timeline={leftPlayback.timeline}
          summary={leftPlayback.summary}
          activeEvent={leftPlayback.activeEvent}
          elapsedMs={leftPlayback.elapsedMs}
          hasStarted={leftPlayback.hasStarted}
          winner={verdict.winner === "left"}
        />
        <aside className="delta-spine">
          <div className={`race-clock-card ${raceRunning ? "running" : raceComplete ? "complete" : ""}`}>
            <span>RACE CLOCK</span>
            <strong>{formatClock(raceElapsedMs)}</strong>
            <p>{raceClockLabel}</p>
          </div>
          <div className="gap-summary">
            <span>GAP</span>
            <strong>{leftLeads ? "+" : "-"}{formatClock(gap)}</strong>
            <p>
              {raceComplete
                ? verdict.winner === "too-close"
                  ? "Too close to call from this data"
                  : verdict.winner === "left"
                    ? "Lane A won"
                    : "Lane B won"
                : raceStarted
                  ? "projected finish gap"
                  : "projected gap"}
            </p>
          </div>
          <div className="spine-progress">
            <div>
              <span>A</span>
              <i><b className="bar-a" style={{ width: `${Math.max(2, leftPlayback.progress * 100)}%` }} /></i>
              <strong>{Math.round(leftPlayback.progress * 100)}%</strong>
            </div>
            <div>
              <span>B</span>
              <i><b className="bar-b" style={{ width: `${Math.max(2, rightPlayback.progress * 100)}%` }} /></i>
              <strong>{Math.round(rightPlayback.progress * 100)}%</strong>
            </div>
          </div>
          <Disclosure label="Gap breakdown · prefill vs decode vs tool">
            <RaceGapBreakdown left={leftPlayback.summary} right={rightPlayback.summary} winner={verdict.winner} />
          </Disclosure>
        </aside>
        <RaceLane
          catalog={catalog}
          label="B"
          result={right}
          timeline={rightPlayback.timeline}
          summary={rightPlayback.summary}
          activeEvent={rightPlayback.activeEvent}
          elapsedMs={rightPlayback.elapsedMs}
          hasStarted={rightPlayback.hasStarted}
          winner={verdict.winner === "right"}
        />
      </section>
    </main>
  );
}
