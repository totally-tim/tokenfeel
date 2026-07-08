import { useMemo, useState } from "react";
import {
  CacheModeSelector,
  Disclosure,
  PhaseState,
  PlayButton,
  ScenarioCard,
  SearchSelect,
  SessionHeader,
  SourceNote,
  SpeedSelector,
  StatFoot,
  Transcript,
  ContextMeter
} from "../components/SimulatorPieces";
import { CacheLedger, DepthRateCurve, QualityFlags, TimelineStrip } from "../components/Visualizations";
import {
  createCatalogLookups,
  scenarioOptions,
  getResult,
  getScenario,
  DEFAULT_LEFT_CONFIG,
  DEFAULT_SCENARIO_ID
} from "../lib/catalog";
import { baselineMeasurement, maxMeasuredDepth } from "../lib/catalogQuality";
import {
  getHardwareOptions,
  getModelOptions,
  getQuantOptions,
  getRuntimeOptions,
  resolveConfigSelection,
  updateConfigSelection,
  type ConfigSelection
} from "../lib/configMatrix";
import { usePlayback } from "../hooks/usePlayback";
import { liveDepthForEvent } from "../lib/streaming";
import { formatNumber } from "../lib/format";
import type { CacheMode, Catalog } from "../types";

export function PlaygroundPage({ catalog }: { catalog: Catalog }) {
  const lookups = useMemo(() => createCatalogLookups(catalog), [catalog]);
  // `selection` intentionally stays whatever `updateConfigSelection` hands
  // back -- including partial/cleared fields when the user clears a picker.
  // The fully-resolved config used to actually play a result is derived
  // separately below (`resolvedSelection`) and never written back into this
  // state, so clearing a field doesn't get immediately re-resolved away.
  const [selection, setSelection] = useState<ConfigSelection>(() =>
    resolveConfigSelection(catalog.results, DEFAULT_LEFT_CONFIG, lookups)
  );
  const [scenarioId, setScenarioId] = useState(DEFAULT_SCENARIO_ID);
  const [cacheMode, setCacheMode] = useState<CacheMode>("runtime");
  const [speed, setSpeed] = useState(1);

  const resolvedSelection = useMemo(
    () => resolveConfigSelection(catalog.results, selection, lookups),
    [catalog.results, selection, lookups]
  );
  const result = getResult(catalog, resolvedSelection.resultId);
  const scenario = getScenario(catalog, scenarioId);
  const playback = usePlayback({ result, scenario, cacheMode, speed });
  const activeIndex = playback.activeEvent.index;
  const hardware = lookups.hardwareById(result.hardware);
  const model = lookups.modelById(result.model);

  const hardwareOptions = useMemo(() => getHardwareOptions(catalog.results, lookups), [catalog.results, lookups]);
  const modelOptions = useMemo(
    () => getModelOptions(catalog.results, selection, lookups),
    [catalog.results, lookups, selection.hardwareId]
  );
  const quantOptions = useMemo(
    () => getQuantOptions(catalog.results, selection),
    [catalog.results, selection.hardwareId, selection.modelId]
  );
  const runtimeOptions = useMemo(
    () => getRuntimeOptions(catalog.results, selection),
    [catalog.results, selection.hardwareId, selection.modelId, selection.quant]
  );
  const scenarios = useMemo(() => scenarioOptions(catalog), [catalog]);
  const selectedRuntime = runtimeOptions.find((option) => option.value === selection.runtimeKey);

  return (
    <main className="playground-page full-height-page">
      <aside className="config-rail">
        <div className="rail-head">
          <span>CONFIGURATION</span>
          <small>{formatNumber(catalog.results.length)} results</small>
        </div>
        <SearchSelect
          label="HARDWARE"
          value={hardware?.shortName ?? result.hardware}
          sub={`${hardware?.memory ?? ""} · ${hardware?.accelerator ?? ""}`}
          selectedValue={selection.hardwareId}
          options={hardwareOptions}
          onChange={(hardwareId) =>
            setSelection((current) =>
              updateConfigSelection(catalog.results, current, "hardwareId", hardwareId, lookups)
            )
          }
          placeholder="Search hardware"
        />
        <SearchSelect
          label="MODEL"
          value={model?.name ?? result.model}
          sub={`${model?.activeParams ?? model?.params ?? ""} active`}
          selectedValue={selection.modelId}
          options={modelOptions}
          onChange={(modelId) =>
            setSelection((current) => updateConfigSelection(catalog.results, current, "modelId", modelId, lookups))
          }
          placeholder="Search models"
        />
        <SearchSelect
          label="QUANT"
          value={result.quant.toUpperCase()}
          sub={baselineMeasurement(result)?.ppLabel ?? "submitted benchmark"}
          selectedValue={selection.quant}
          options={quantOptions}
          onChange={(quant) =>
            setSelection((current) => updateConfigSelection(catalog.results, current, "quant", quant, lookups))
          }
          placeholder="Search quant"
        />
        <SearchSelect
          label="RUNTIME"
          value={`${result.runtime.name} · ${result.runtime.backend}`}
          sub={selectedRuntime?.sub ?? result.runtime.flags}
          selectedValue={selection.runtimeKey}
          options={runtimeOptions}
          onChange={(selectedRuntimeKey) =>
            setSelection((current) =>
              updateConfigSelection(catalog.results, current, "runtimeKey", selectedRuntimeKey, lookups)
            )
          }
          placeholder="Search runtime"
        />

        <div className="rail-divider" />
        <span className="rail-section-title">SCENARIO</span>
        <div className="scenario-list">
          {scenarios.map((item) => (
            <ScenarioCard
              key={item.value}
              title={item.title}
              sub={item.sub}
              type={getScenario(catalog, item.value).type}
              active={scenarioId === item.value}
              onClick={() => setScenarioId(item.value)}
            />
          ))}
        </div>

        <div className="rail-actions">
          <div className="cache-control">
            <span>
              <strong>Prompt cache</strong>
              <small>
                {cacheMode === "runtime"
                  ? "submitted runtime default"
                  : cacheMode === "on"
                    ? "forced hypothetical prefix reuse"
                    : "disabled worst case"}
              </small>
            </span>
            <CacheModeSelector mode={cacheMode} onMode={setCacheMode} />
          </div>

          <PlayButton
            isPlaying={playback.isPlaying}
            hasStarted={playback.hasStarted}
            onPlay={playback.restart}
            onStop={playback.reset}
          />
          <div className="speed-row">
            <span>SPEED</span>
            <SpeedSelector speed={speed} onSpeed={setSpeed} />
          </div>
          <p className="rail-note">Real time is the point. Fast-forward is clearly labeled.</p>
        </div>
      </aside>

      <section className="session-main">
        <SessionHeader
          catalog={catalog}
          title={scenario.title}
          result={result}
          activeEvent={playback.activeEvent}
          hasStarted={playback.hasStarted}
          isComplete={playback.isComplete}
        />
        <Transcript
          events={playback.timeline.events}
          activeIndex={activeIndex}
          elapsedMs={playback.elapsedMs}
          cacheMode={cacheMode}
          runtimeCache={result.runtime.cache}
        />
        <footer className="bottom-bar">
          <div className="playback-primary">
            <PhaseState
              event={playback.activeEvent}
              elapsedMs={playback.elapsedMs}
              hasStarted={playback.hasStarted}
              complete={playback.isComplete}
            />
            <div className="playback-side">
              <StatFoot summary={playback.summary} />
              <ContextMeter
                compact
                cached={playback.activeEvent.cachedPrefixTokens}
                reprefill={playback.activeEvent.prefillTokens}
                total={playback.activeEvent.contextAfter}
                dataHorizon={maxMeasuredDepth(result)}
              />
            </div>
          </div>
          <Disclosure label="Cache ledger · phase map · depth curve · provenance">
            <div className="playback-details">
              <CacheLedger summary={playback.summary} activeEvent={playback.activeEvent} />
              <DepthRateCurve
                result={result}
                activeDepth={liveDepthForEvent(playback.activeEvent, playback.elapsedMs)}
              />
              <div className="detail-extra">
                <TimelineStrip timeline={playback.timeline} activeIndex={activeIndex} />
                <div className="legend-row">
                  <span>
                    <i className="legend cached" /> cached prefix ·{" "}
                    {formatNumber(Math.round(playback.activeEvent.cachedPrefixTokens))} tok
                  </span>
                  <span>
                    <i className="legend reprefill" /> re-prefilled this turn ·{" "}
                    {formatNumber(Math.round(playback.activeEvent.prefillTokens))} tok
                  </span>
                  <span>
                    <i className="legend headroom" /> headroom
                  </span>
                </div>
                <QualityFlags result={result} extrapolatedEvents={playback.summary.extrapolatedEvents} />
                <SourceNote catalog={catalog} result={result} />
              </div>
            </div>
          </Disclosure>
        </footer>
      </section>
    </main>
  );
}
