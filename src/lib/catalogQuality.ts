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
  if (!ttftMs || measurement.depth <= 0) return false;

  const promptTokenCounts = [measurement.depth];
  if (ppTokens > 0) promptTokenCounts.push(measurement.depth + ppTokens);

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

export function catalogQualityIssues(
  result: BenchmarkResult,
  context: { model?: ModelMetadata; hardware?: HardwareConfig } = {}
): CatalogQualityIssue[] {
  const issues: CatalogQualityIssue[] = [];
  const maxDepth = maxMeasuredDepth(result);
  const modelId = result.model.toLowerCase();

  if (hashLikeId.test(modelId)) issues.push("hash-model-id");
  if (placeholderModelIds.has(modelId)) issues.push("placeholder-model-id");
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
