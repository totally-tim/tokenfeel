// Pure, side-effect-free (aside from one deliberate console.warn -- see
// buildBaselineByResultId) logic extracted from ConfigsPage.tsx: facet/query
// filtering, sorting, pagination math, and the "frontier" best-result-per-config
// bar-chart derivation. Kept independent of React so it is testable without
// mounting the page.
import { baselineMeasurement } from "./catalogQuality";
import { formatNumber } from "./format";
import type { BenchmarkMeasurement, BenchmarkResult, HardwareConfig, ModelMetadata, TimelineSummary } from "../types";

export interface RankedResultRow {
  result: BenchmarkResult;
  seconds: number;
  hardware?: HardwareConfig;
  model?: ModelMetadata;
  summary: TimelineSummary;
}

export type ConfigsSortKey = "seconds" | "pp" | "tg";

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

// Prepends a synthetic "All X" option so a combobox can represent "no
// filter" the same way a native <select>'s blank option would.
export function withAllOption<T extends { value: string; label: string }>(
  allLabel: string,
  options: T[]
): Array<T | { value: string; label: string }> {
  return [{ value: "", label: allLabel }, ...options];
}

export function labelFor(options: Array<{ value: string; label: string }>, value?: string): string {
  return options.find((option) => option.value === value)?.label ?? value ?? "";
}

// Builds the "baseline (lowest-depth) measurement's pp/tg" lookup once per
// results array instead of resorting `result.measurements` on every read --
// ConfigsPage invokes `baselineMetric` many times per row across sorting and
// rendering. Logs (does not throw) when a result has no measurements, since
// that should never happen for schema-valid data but must degrade safely.
export function buildBaselineByResultId(results: BenchmarkResult[]): Map<string, BenchmarkMeasurement | undefined> {
  const map = new Map<string, BenchmarkMeasurement | undefined>();
  for (const result of results) {
    const baseline = baselineMeasurement(result);
    if (!baseline) {
      console.warn(`Result ${result.id} has no measurements; baseline pp/tg is falling back to 0`);
    }
    map.set(result.id, baseline);
  }
  return map;
}

export function baselineMetric(
  baselineByResultId: Map<string, BenchmarkMeasurement | undefined>,
  resultId: string,
  key: "pp" | "tg"
): number {
  return baselineByResultId.get(resultId)?.[key] ?? 0;
}

export function filterRowsBySelectionAndQuery(
  rows: RankedResultRow[],
  selectedIds: Set<string>,
  query: string,
  verifiedOnly: boolean
): RankedResultRow[] {
  const normalizedQuery = query.toLowerCase();
  return rows.filter(({ result, hardware, model }) => {
    const haystack =
      `${hardware?.name} ${model?.name} ${result.runtime.name} ${result.runtime.backend} ${result.quant}`.toLowerCase();
    return (
      selectedIds.has(result.id) &&
      haystack.includes(normalizedQuery) &&
      (!verifiedOnly || result.status === "verified")
    );
  });
}

export function sortRows(
  rows: RankedResultRow[],
  sortKey: ConfigsSortKey,
  baselineByResultId: Map<string, BenchmarkMeasurement | undefined>
): RankedResultRow[] {
  if (sortKey === "seconds") return rows;
  return [...rows].sort(
    (a, b) =>
      baselineMetric(baselineByResultId, b.result.id, sortKey) -
      baselineMetric(baselineByResultId, a.result.id, sortKey)
  );
}

export interface PaginatedRows<T> {
  pageCount: number;
  safePageIndex: number;
  visibleRows: T[];
  firstVisible: number;
  lastVisible: number;
}

export function paginateRows<T>(rows: T[], pageIndex: number, pageSize: number): PaginatedRows<T> {
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePageIndex = Math.min(Math.max(pageIndex, 0), pageCount - 1);
  const visibleRows = rows.slice(safePageIndex * pageSize, safePageIndex * pageSize + pageSize);
  const firstVisible = rows.length === 0 ? 0 : safePageIndex * pageSize + 1;
  const lastVisible = Math.min(rows.length, (safePageIndex + 1) * pageSize);
  return { pageCount, safePageIndex, visibleRows, firstVisible, lastVisible };
}

export function buildRangeLabel(totalCount: number, firstVisible: number, lastVisible: number): string {
  if (totalCount === 0) return "No results";
  return `Showing ${formatNumber(firstVisible)}-${formatNumber(lastVisible)} of ${formatNumber(totalCount)}`;
}

export interface FrontierRow {
  result: BenchmarkResult;
  seconds: number;
  hardware?: HardwareConfig;
  model?: ModelMetadata;
  tgRate: number;
  loopPct: number;
  decodePct: number;
}

// The "frontier" bars compare the fastest comparable configs: agent-loop
// seconds (shorter is better, so the bar length is inverted relative to
// `seconds`) alongside decode throughput for context. Percentages are
// clamped to a visible minimum (6%/4%) so a fast-but-not-fastest bar never
// renders as an invisible sliver.
export function computeFrontierRows(
  rows: RankedResultRow[],
  baselineByResultId: Map<string, BenchmarkMeasurement | undefined>,
  limit = 8
): FrontierRow[] {
  const frontierRows = rows.slice(0, limit);
  const maxSeconds = Math.max(...frontierRows.map((row) => row.seconds), 1);
  const minSeconds = Math.min(...frontierRows.map((row) => row.seconds), maxSeconds);
  const secondsRange = maxSeconds - minSeconds;
  const maxTg = Math.max(...frontierRows.map((row) => baselineMetric(baselineByResultId, row.result.id, "tg")), 1);

  return frontierRows.map(({ result, seconds, hardware, model }) => {
    const tgRate = baselineMetric(baselineByResultId, result.id, "tg");
    const loopPct = secondsRange === 0 ? 100 : Math.max(6, 6 + ((maxSeconds - seconds) / secondsRange) * 94);
    const decodePct = Math.max(4, (tgRate / maxTg) * 100);
    return { result, seconds, hardware, model, tgRate, loopPct, decodePct };
  });
}

export interface CoverageEntry {
  hardware: string;
  total: number;
  verified: number;
  raw: number;
}

export function computeCoverage(rows: RankedResultRow[]): Map<string, CoverageEntry> {
  return rows.reduce((map, { result }) => {
    const item = map.get(result.hardware) ?? { hardware: result.hardware, total: 0, verified: 0, raw: 0 };
    item.total += 1;
    if (result.status === "verified") item.verified += 1;
    if (result.evidence?.rawUrl || result.source.raw) item.raw += 1;
    map.set(result.hardware, item);
    return map;
  }, new Map<string, CoverageEntry>());
}

export function topCoverageEntries(
  coverage: Map<string, CoverageEntry>,
  limit = 8
): { rows: CoverageEntry[]; maxTotal: number } {
  const rows = [...coverage.values()].sort((a, b) => b.total - a.total).slice(0, limit);
  const maxTotal = Math.max(...rows.map((item) => item.total), 1);
  return { rows, maxTotal };
}

export function countDistinctHardware(rows: RankedResultRow[]): number {
  return new Set(rows.map(({ result }) => result.hardware)).size;
}

export function toggleCompareSelection(current: string[], id: string): string[] {
  if (current.includes(id)) return current.filter((value) => value !== id);
  if (current.length >= 2) return [current[1], id];
  return [...current, id];
}

export function compareRowLabel(rows: RankedResultRow[], id: string): string {
  const row = rows.find(({ result }) => result.id === id);
  return row?.hardware?.shortName ?? id;
}
