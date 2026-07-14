import type { BenchmarkMeasurement, BenchmarkResult, Catalog, HardwareConfig, ModelMetadata } from "../types";

export type CatalogQualityIssue =
  | "hash-model-id"
  | "placeholder-model-id"
  | "unknown-model-params"
  | "unknown-quant"
  | "low-context-under-8k"
  | "zero-depth-only"
  | "ttft-pp-mismatch"
  | "severe-rate-spike";

export const PUBLIC_SIMULATION_MIN_DEPTH = 8192;

const hashLikeId = /^[a-f0-9]{40}$/;
const placeholderModelIds = new Set([
  "4b",
  "7bq8",
  "8b",
  "coder",
  "community",
  "context-1",
  "d1t",
  "default",
  "gemma4",
  "my-model",
  "qwen",
  "qwen3.5"
]);
// Beyond the exact-match set above, any id carrying one of these seed/scratch
// prefixes (e.g. "test-qwen3-coder-30b-a3b") is a leftover from authoring,
// not a real catalog entry, even when it doesn't match a known placeholder
// verbatim.
const placeholderIdPrefixes = ["test-", "tbd-", "demo-"];

function isPlaceholderId(id: string): boolean {
  return placeholderModelIds.has(id) || placeholderIdPrefixes.some((prefix) => id.startsWith(prefix));
}

export function maxMeasuredDepth(result: BenchmarkResult): number {
  return Math.max(...result.measurements.map((measurement) => measurement.depth));
}

/**
 * The lowest-context-depth ("baseline") measurement for a result -- what
 * callers actually mean when they reach for a single representative pp/tg
 * snapshot (summary cards, default sort key, etc). `measurements` is
 * schema-validated to be non-empty and sorted ascending by depth at catalog
 * build time, but call sites should not assume raw array index 0 is always
 * safe/meaningful (hand-built fixtures, future loaders with different
 * assumptions) -- this re-sorts defensively and returns undefined instead of
 * throwing/crashing when a result unexpectedly has no measurements.
 */
export function baselineMeasurement(result: BenchmarkResult): BenchmarkMeasurement | undefined {
  if (result.measurements.length === 0) return undefined;
  return [...result.measurements].sort((a, b) => a.depth - b.depth)[0];
}

function issueSet(issues: CatalogQualityIssue[]): CatalogQualityIssue[] {
  return [...new Set(issues)];
}

function ttftMismatchesPromptRate(measurement: BenchmarkMeasurement, ppTokens = 0): boolean {
  const ttftMs = measurement.source?.ttftMs;
  if (!ttftMs) return false;
  // Only bail when there is no signal at all to check against. A zero/absent
  // depth with a known ppTokens chunk size still has a real prompt-token
  // count to derive an expected TTFT from -- skipping it let ttft outliers
  // at depth 0 pass unchecked.
  if (measurement.depth <= 0 && ppTokens <= 0) return false;

  const promptTokenCounts: number[] = [];
  if (measurement.depth > 0) {
    promptTokenCounts.push(measurement.depth);
    if (ppTokens > 0) promptTokenCounts.push(measurement.depth + ppTokens);
  } else {
    promptTokenCounts.push(ppTokens);
  }

  return promptTokenCounts.every((tokens) => {
    const derivedMs = (tokens / measurement.pp) * 1000;
    const ratio = ttftMs / Math.max(1, derivedMs);
    return ratio < 0.25 || ratio > 2;
  });
}

function hasSevereRateSpike(result: BenchmarkResult): boolean {
  for (let index = 1; index < result.measurements.length; index += 1) {
    const previous = result.measurements[index - 1];
    const current = result.measurements[index];
    // Mirrors the cold-start exemption in scripts/validate-data.ts's
    // analyzeCatalogQuality: the first measured-depth transition is where
    // benchmark warm-up variance lives, so it gets no unearned pass unless a
    // longer curve exists beyond it to confirm the anomaly is confined there.
    const isFirstTransition = index === 1 && result.measurements.length > 2;
    if (isFirstTransition) continue;

    for (const metric of ["pp", "tg"] as const) {
      const increaseRatio = (current[metric] - previous[metric]) / previous[metric];
      if (increaseRatio > 1) return true;
    }
  }

  return false;
}

// Whether a result carries any trace of the raw upstream evidence it was
// derived from, in any of the shapes different importers/converters use.
// catalogSchema's cross-reference check already hard-fails a "verified" row
// with none of these; this is the softer check used to WARN (not fail) on
// "community" rows with no raw evidence at all -- see analyzeCatalogQuality
// in scripts/validate-data.ts.
export function hasAnyRawEvidence(result: BenchmarkResult): boolean {
  return Boolean(
    result.source.raw ||
    result.evidence?.rawUrl ||
    result.evidence?.rawRows?.length ||
    result.evidence?.upstreamUrls?.length ||
    result.evidence?.archiveUrl
  );
}

export function catalogQualityIssues(
  result: BenchmarkResult,
  context: { model?: ModelMetadata; hardware?: HardwareConfig } = {}
): CatalogQualityIssue[] {
  const issues: CatalogQualityIssue[] = [];
  const maxDepth = maxMeasuredDepth(result);
  const modelId = result.model.toLowerCase();

  if (hashLikeId.test(modelId)) issues.push("hash-model-id");
  if (isPlaceholderId(modelId)) issues.push("placeholder-model-id");
  if (context.model?.params.toLowerCase() === "unknown") issues.push("unknown-model-params");
  if (result.quant.toLowerCase() === "unknown") issues.push("unknown-quant");
  if (maxDepth < PUBLIC_SIMULATION_MIN_DEPTH) issues.push("low-context-under-8k");
  if (maxDepth === 0) issues.push("zero-depth-only");
  if (result.measurements.some((measurement) => ttftMismatchesPromptRate(measurement, result.benchmark?.ppTokens))) {
    issues.push("ttft-pp-mismatch");
  }
  if (hasSevereRateSpike(result)) issues.push("severe-rate-spike");

  return issueSet(issues);
}

export function pruneCatalogForSimulation(catalog: Catalog): Catalog {
  const modelById = new Map(catalog.models.map((model) => [model.id, model]));
  const hardwareById = new Map(catalog.hardware.map((hardware) => [hardware.id, hardware]));
  const results = catalog.results.filter(
    (result) =>
      catalogQualityIssues(result, {
        model: modelById.get(result.model),
        hardware: hardwareById.get(result.hardware)
      }).length === 0
  );
  const hardwareIds = new Set(results.map((result) => result.hardware));
  const modelIds = new Set(results.map((result) => result.model));

  return {
    ...catalog,
    hardware: catalog.hardware.filter((hardware) => hardwareIds.has(hardware.id)),
    models: catalog.models.filter((model) => modelIds.has(model.id)),
    results
  };
}
