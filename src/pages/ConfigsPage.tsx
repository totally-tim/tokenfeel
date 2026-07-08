import { ArrowRight, ExternalLink, Flag, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { StatusBadge } from "../components/StatusBadge";
import { SearchSelect } from "../components/SimulatorPieces";
import { DepthRateCurve, EvidencePanel, QualityFlags } from "../components/Visualizations";
import { createCatalogLookups, rankedResults, DEFAULT_SCENARIO_ID } from "../lib/catalog";
import { formatNumber, formatRate, formatSeconds } from "../lib/format";
import { defaultScenario } from "../lib/catalog";
import { buildRaceShareUrl } from "../lib/raceShare";
import { FLAG_RESULT_ISSUE_URL } from "../lib/projectLinks";
import { loadResultDetail, type StaticCatalog } from "../data/staticCatalog";
import {
  filterResultsBySelection,
  getHardwareOptions,
  getModelOptions,
  getQuantOptions,
  getRuntimeOptions,
  updateConfigFilterSelection,
  type ConfigSelection
} from "../lib/configMatrix";
import {
  baselineMetric,
  buildBaselineByResultId,
  buildRangeLabel,
  compareRowLabel,
  computeCoverage,
  computeFrontierRows,
  countDistinctHardware,
  filterRowsBySelectionAndQuery,
  labelFor,
  paginateRows,
  plural,
  sortRows,
  toggleCompareSelection,
  topCoverageEntries,
  withAllOption,
  type ConfigsSortKey
} from "../lib/configsFilter";
import type { BenchmarkResult } from "../types";

const SORTS: Array<{ key: ConfigsSortKey; label: string }> = [
  { key: "seconds", label: "Agent loop" },
  { key: "pp", label: "Prefill" },
  { key: "tg", label: "Decode" }
];

const pageSize = 80;

export function ConfigsPage({ catalog }: { catalog: StaticCatalog }) {
  const [query, setQuery] = useState("");
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [selection, setSelection] = useState<ConfigSelection>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<ConfigsSortKey>("seconds");
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [detailsById, setDetailsById] = useState<Record<string, BenchmarkResult>>({});
  const lookups = useMemo(() => createCatalogLookups(catalog), [catalog]);
  const rows = useMemo(() => rankedResults(catalog, defaultScenario(catalog)), [catalog]);
  const baselineByResultId = useMemo(() => buildBaselineByResultId(catalog.results), [catalog.results]);
  const hardwareOptions = useMemo(() => getHardwareOptions(catalog.results, lookups), [catalog.results, lookups]);
  const modelOptions = useMemo(
    () => (selection.hardwareId ? getModelOptions(catalog.results, selection, lookups) : []),
    [catalog.results, lookups, selection.hardwareId]
  );
  const quantOptions = useMemo(
    () => (selection.hardwareId && selection.modelId ? getQuantOptions(catalog.results, selection) : []),
    [catalog.results, selection.hardwareId, selection.modelId]
  );
  const runtimeOptions = useMemo(
    () => (selection.hardwareId && selection.modelId && selection.quant ? getRuntimeOptions(catalog.results, selection) : []),
    [catalog.results, selection.hardwareId, selection.modelId, selection.quant]
  );
  const selectedIds = useMemo(
    () => new Set(filterResultsBySelection(catalog.results, selection).map((result) => result.id)),
    [catalog.results, selection]
  );
  const filtered = useMemo(
    () => filterRowsBySelectionAndQuery(rows, selectedIds, query, verifiedOnly),
    [query, rows, selectedIds, verifiedOnly]
  );
  const sorted = useMemo(() => sortRows(filtered, sortKey, baselineByResultId), [filtered, sortKey, baselineByResultId]);
  const { pageCount, safePageIndex, visibleRows, firstVisible, lastVisible } = useMemo(
    () => paginateRows(sorted, pageIndex, pageSize),
    [sorted, pageIndex]
  );
  const top = filtered.slice(0, 4);

  useEffect(() => {
    setPageIndex(0);
  }, [query, selection, sortKey, verifiedOnly]);

  useEffect(() => {
    if (!expandedId || detailsById[expandedId]) return;

    let alive = true;
    loadResultDetail(catalog, expandedId)
      .then((detail) => {
        if (alive) {
          setDetailsById((current) => ({ ...current, [expandedId]: detail }));
        }
      })
      .catch(() => {
        if (alive) {
          const fallback = catalog.results.find((result) => result.id === expandedId);
          if (fallback) setDetailsById((current) => ({ ...current, [expandedId]: fallback }));
        }
      });

    return () => {
      alive = false;
    };
  }, [catalog, detailsById, expandedId]);

  const coverage = useMemo(() => computeCoverage(sorted), [sorted]);

  const activeChips: Array<{ id: string; label: string; clear: () => void }> = [];
  if (query.trim()) activeChips.push({ id: "query", label: `“${query.trim()}”`, clear: () => setQuery("") });
  if (selection.hardwareId)
    activeChips.push({
      id: "hardwareId",
      label: labelFor(hardwareOptions, selection.hardwareId),
      clear: () => setSelection((current) => updateConfigFilterSelection(current, "hardwareId", ""))
    });
  if (selection.modelId)
    activeChips.push({
      id: "modelId",
      label: labelFor(modelOptions, selection.modelId),
      clear: () => setSelection((current) => updateConfigFilterSelection(current, "modelId", ""))
    });
  if (selection.quant)
    activeChips.push({
      id: "quant",
      label: labelFor(quantOptions, selection.quant),
      clear: () => setSelection((current) => updateConfigFilterSelection(current, "quant", ""))
    });
  if (selection.runtimeKey)
    activeChips.push({
      id: "runtimeKey",
      label: labelFor(runtimeOptions, selection.runtimeKey),
      clear: () => setSelection((current) => updateConfigFilterSelection(current, "runtimeKey", ""))
    });
  if (verifiedOnly) activeChips.push({ id: "verified", label: "verified only", clear: () => setVerifiedOnly(false) });

  const clearAll = () => {
    setQuery("");
    setSelection({});
    setVerifiedOnly(false);
  };

  const toggleCompare = (id: string) => setCompareIds((current) => toggleCompareSelection(current, id));

  const raceCompare = () => {
    if (compareIds.length !== 2) return;
    const url = new URL(buildRaceShareUrl({ leftId: compareIds[0], rightId: compareIds[1], scenarioId: DEFAULT_SCENARIO_ID, speed: 1 }));
    window.location.hash = url.hash;
  };

  const compareLabel = (id: string) => compareRowLabel(rows, id);

  const rangeLabel = buildRangeLabel(sorted.length, firstVisible, lastVisible);
  const frontierRows = useMemo(() => computeFrontierRows(filtered, baselineByResultId, 8), [filtered, baselineByResultId]);
  const { rows: coverageRows, maxTotal: maxCoverageTotal } = useMemo(() => topCoverageEntries(coverage, 8), [coverage]);
  const configCount = countDistinctHardware(sorted);

  return (
    <main className="configs-page">
      <section className="configs-wrap">
        <header className="configs-header">
          <div>
            <div className="title-row">
              <h1>Configs & results</h1>
              <span>
                {formatNumber(sorted.length)} {plural(sorted.length, "result")} · {formatNumber(configCount)} {plural(configCount, "config")}
              </span>
            </div>
            <p>Search by hardware, model, backend, runtime or quant. Results are paged for the full catalog; pick any two rows to race them head to head.</p>
          </div>
          <div className="filters">
            <label className="search-box">
              <Search size={15} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter configs..." />
            </label>
            <SearchSelect
              compact
              label="Hardware"
              value={selection.hardwareId ? labelFor(hardwareOptions, selection.hardwareId) : "All hardware"}
              selectedValue={selection.hardwareId ?? ""}
              options={withAllOption("All hardware", hardwareOptions)}
              onChange={(next) => setSelection((current) => updateConfigFilterSelection(current, "hardwareId", next))}
              placeholder="Search hardware"
              limit={80}
            />
            <SearchSelect
              compact
              disabled={!selection.hardwareId}
              label="Model"
              value={!selection.hardwareId ? "Model" : selection.modelId ? labelFor(modelOptions, selection.modelId) : "All models"}
              selectedValue={selection.modelId ?? ""}
              options={withAllOption(selection.hardwareId ? "All models" : "Model", modelOptions)}
              onChange={(next) => setSelection((current) => updateConfigFilterSelection(current, "modelId", next))}
              placeholder="Search models"
              limit={80}
            />
            <SearchSelect
              compact
              disabled={!selection.modelId}
              label="Quant"
              value={!selection.modelId ? "Quant" : selection.quant ? labelFor(quantOptions, selection.quant) : "All quants"}
              selectedValue={selection.quant ?? ""}
              options={withAllOption(selection.modelId ? "All quants" : "Quant", quantOptions)}
              onChange={(next) => setSelection((current) => updateConfigFilterSelection(current, "quant", next))}
              placeholder="Search quants"
            />
            <SearchSelect
              compact
              disabled={!selection.quant}
              label="Runtime"
              value={!selection.quant ? "Runtime" : selection.runtimeKey ? labelFor(runtimeOptions, selection.runtimeKey) : "All runtimes"}
              selectedValue={selection.runtimeKey ?? ""}
              options={withAllOption(selection.quant ? "All runtimes" : "Runtime", runtimeOptions)}
              onChange={(next) => setSelection((current) => updateConfigFilterSelection(current, "runtimeKey", next))}
              placeholder="Search runtimes"
            />
            <button
              type="button"
              className={verifiedOnly ? "active" : ""}
              onClick={() => setVerifiedOnly((value) => !value)}
            >
              Verified only
            </button>
          </div>
        </header>

        <div className="configs-controls">
          <div className="sort-control" role="group" aria-label="Sort results">
            <span>SORT BY</span>
            {SORTS.map((option) => (
              <button
                key={option.key}
                type="button"
                className={sortKey === option.key ? "active" : ""}
                onClick={() => setSortKey(option.key)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {activeChips.length > 0 && (
            <div className="filter-chips" aria-label="Active filters">
              {activeChips.map((chip) => (
                <button key={chip.id} type="button" className="filter-chip" onClick={chip.clear}>
                  {chip.label}
                  <X size={12} />
                </button>
              ))}
              <button type="button" className="clear-all" onClick={clearAll}>
                Clear all
              </button>
            </div>
          )}
        </div>

        {top.length > 0 && (
          <section className="summary-cards">
            {top.map(({ result, seconds, hardware }, index) => (
              <article key={result.id} className={index === 0 ? "summary-card fastest" : "summary-card"}>
                <div>
                  <span>#{index + 1}</span>
                  {index === 0 && <small>FASTEST LOOP</small>}
                </div>
                <h2>{hardware?.shortName ?? result.hardware}</h2>
                <strong>{formatSeconds(seconds)}</strong>
                <p>{result.runtime.backend} · {formatRate(baselineMetric(baselineByResultId, result.id, "tg"))}</p>
              </article>
            ))}
          </section>
        )}

        <section className="configs-intelligence" aria-label="Benchmark intelligence">
          <div className="frontier-panel">
            <div>
              <span>FRONTIER</span>
              <strong>fastest comparable configs</strong>
            </div>
            <p className="frontier-note">shorter agent loop is better · decode shown for throughput context</p>
            <div className="chart-legend" aria-label="Frontier chart legend">
              <span><i className="loop" /> agent loop</span>
              <span><i className="decode" /> decode t/s</span>
            </div>
            <div className="frontier-bars">
              {frontierRows.length === 0 ? (
                <p className="empty-panel">No frontier rows match the current filters.</p>
              ) : frontierRows.map(({ result, seconds, hardware, model, tgRate, loopPct, decodePct }) => {
                return (
                  <article
                    key={result.id}
                    className="frontier-bar-row"
                    title={`${hardware?.shortName ?? result.hardware}: ${formatSeconds(seconds)} · ${formatRate(tgRate)}`}
                  >
                    <span>
                      <strong>{hardware?.shortName ?? result.hardware}</strong>
                      <small>{model?.name ?? result.model} · {result.quant.toUpperCase()}</small>
                    </span>
                    <div className="frontier-bar-metrics">
                      <div className="frontier-bar loop">
                        <i style={{ width: `${loopPct}%` }} />
                      </div>
                      <div className="frontier-bar decode">
                        <i style={{ width: `${decodePct}%` }} />
                      </div>
                    </div>
                    <span className="frontier-values">
                      <strong>{formatSeconds(seconds)}</strong>
                      <small>{formatRate(tgRate)}</small>
                    </span>
                  </article>
                );
              })}
            </div>
          </div>
          <div className="coverage-panel">
            <div>
              <span>COVERAGE</span>
              <strong>{coverage.size} {plural(coverage.size, "hardware group")}</strong>
            </div>
            <p className="coverage-note">results per hardware · evidence counts listed</p>
            <div className="chart-legend" aria-label="Coverage chart legend">
              <span><i className="results" /> results</span>
            </div>
            <div className="coverage-list">
              {coverageRows.length === 0 ? (
                <p className="empty-panel">No hardware coverage matches the current filters.</p>
              ) : coverageRows.map((item) => {
                const hardware = lookups.hardwareById(item.hardware);
                const totalPct = Math.max(4, (item.total / maxCoverageTotal) * 100);
                return (
                  <article key={item.hardware} className="coverage-row">
                    <span>
                      <strong>{hardware?.shortName ?? item.hardware}</strong>
                      <small>{item.total} results</small>
                    </span>
                    <div className="coverage-stack" aria-label={`${hardware?.shortName ?? item.hardware} coverage`}>
                      <i className="results" style={{ width: `${totalPct}%` }} />
                    </div>
                    <span className="coverage-values">
                      <strong>{item.total} results</strong>
                      <small>{item.raw} raw · {item.verified} verified</small>
                    </span>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section className="results-table" aria-label="Benchmark results">
          <div className="table-status">
            <span>{rangeLabel}</span>
            <div className="pager">
              <button type="button" onClick={() => setPageIndex((value) => Math.max(0, value - 1))} disabled={safePageIndex === 0}>
                Previous
              </button>
              <strong>
                Page {safePageIndex + 1} / {pageCount}
              </strong>
              <button
                type="button"
                onClick={() => setPageIndex((value) => Math.min(pageCount - 1, value + 1))}
                disabled={safePageIndex >= pageCount - 1}
              >
                Next
              </button>
            </div>
          </div>
          {compareIds.length > 0 && (
            <div className="compare-bar" role="region" aria-label="Compare selection">
              <div className="compare-slots">
                <span>COMPARE</span>
                <strong>{compareLabel(compareIds[0])}</strong>
                <em>vs</em>
                <strong className={compareIds[1] ? "" : "empty"}>{compareIds[1] ? compareLabel(compareIds[1]) : "pick a second"}</strong>
              </div>
              <div className="compare-actions">
                <button type="button" className="secondary-button small" onClick={() => setCompareIds([])}>
                  Clear
                </button>
                <button type="button" className="primary-button small" onClick={raceCompare} disabled={compareIds.length !== 2}>
                  Race these <ArrowRight size={15} />
                </button>
              </div>
            </div>
          )}
          <div className="table-scroll">
            <div className="table-row table-head">
              <span>COMPARE</span>
              <span>CONFIG</span>
              <span>MODEL</span>
              <span>QUANT</span>
              <span>RUNTIME</span>
              <span>PP</span>
              <span>TG</span>
              <span>AGENT LOOP</span>
              <span>STATUS</span>
              <span />
            </div>
            {visibleRows.length === 0 ? (
              <div className="empty-table-state">
                <strong>No configs match these filters.</strong>
                <span>Clear a filter or search for hardware, model, runtime, backend, or quant.</span>
              </div>
            ) : visibleRows.map(({ result, seconds, hardware, model, summary }) => (
              <div className={`table-entry ${compareIds.includes(result.id) ? "compared" : ""}`} key={result.id}>
                <div className="table-row">
                  <span className="compare-cell">
                    <input
                      type="checkbox"
                      checked={compareIds.includes(result.id)}
                      onChange={() => toggleCompare(result.id)}
                      aria-label={`Add ${hardware?.shortName ?? result.hardware} to compare`}
                    />
                  </span>
                  <span>
                    <strong>{hardware?.shortName ?? result.hardware}</strong>
                    <small>{hardware?.memory}</small>
                  </span>
                  <span>{model?.name ?? result.model}</span>
                  <span>{result.quant.toUpperCase()}</span>
                  <span>
                    <strong>{result.runtime.name}</strong>
                    <small>{result.runtime.backend}</small>
                  </span>
                  <span>{formatNumber(baselineMetric(baselineByResultId, result.id, "pp"))}</span>
                  <span>{baselineMetric(baselineByResultId, result.id, "tg").toFixed(1)}</span>
                  <span className="accent-strong">{formatSeconds(seconds)}</span>
                  <span><StatusBadge status={result.status} /></span>
                  <span className="table-actions">
                    <button
                      type="button"
                      onClick={() => setExpandedId((current) => (current === result.id ? null : result.id))}
                      aria-expanded={expandedId === result.id}
                    >
                      {expandedId === result.id ? "less" : "more"}
                    </button>
                    <a href={result.source.url} target="_blank" rel="noreferrer" aria-label={`Open source for ${result.id}`}>
                      {result.status === "flagged" ? <Flag size={15} /> : <ExternalLink size={15} />}
                    </a>
                  </span>
                </div>
                {expandedId === result.id && (
                  <div className="result-detail-row">
                    <EvidencePanel result={detailsById[result.id] ?? result} />
                    <DepthRateCurve result={detailsById[result.id] ?? result} />
                    <div className="result-quality-panel">
                      <QualityFlags result={detailsById[result.id] ?? result} extrapolatedEvents={summary.extrapolatedEvents} />
                      <dl>
                        <div>
                          <dt>scenario time</dt>
                          <dd>{formatSeconds(seconds)}</dd>
                        </div>
                        <div>
                          <dt>prefill/decode/tool</dt>
                          <dd>{formatSeconds(summary.prefillMs / 1000)} / {formatSeconds(summary.decodeMs / 1000)} / {formatSeconds(summary.toolLatencyMs / 1000)}</dd>
                        </div>
                        <div>
                          <dt>cache saved</dt>
                          <dd>{formatNumber(summary.prefilledWithoutCache - summary.prefilledWithCache)} tokens</dd>
                        </div>
                      </dl>
                      <a
                        className="report-result-link"
                        href={`${FLAG_RESULT_ISSUE_URL}&title=${encodeURIComponent(`Flag result: ${result.id}`)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Report this result
                      </a>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}
