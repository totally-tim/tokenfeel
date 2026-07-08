import { buildTimeline, summarizeTimeline } from "../sim/timing";
import { resolveConfigSelection, type ConfigSelection, type ResolvedConfigSelection } from "./configMatrix";
import type { BenchmarkResult, CacheMode, Catalog, HardwareConfig, ModelMetadata, ScenarioScript } from "../types";

export const DEFAULT_SCENARIO_ID = "repo-wide-refactor";

// Stable (hardware/model/quant) tuples, not raw result ids -- individual
// result ids carry a runtime version + OS + content hash suffix that changes
// as new benchmark submissions come in, so pinning a literal id here goes
// stale silently. `resolveConfigSelection` picks the best current row for
// the tuple using the same preference order (verified > community, raw
// evidence, depth, recency) as every other config picker in the app.
export const DEFAULT_LEFT_CONFIG: ConfigSelection = { hardwareId: "m4-max-40c-48gb", modelId: "qwen3.5-9b", quant: "4bit" };
export const DEFAULT_RIGHT_CONFIG: ConfigSelection = { hardwareId: "m5-max-40c-128gb", modelId: "qwen3.5-9b", quant: "4bit" };

// `resolveConfigSelection` degrades a hardware/model/quant tuple that no
// longer exists in the catalog to whatever the "first available" fallback
// resolves to, rather than failing -- which would let both pinned defaults
// silently collapse onto the same fallback result (comparing a config
// against itself) once either tuple goes stale. Require the resolved tuple
// to still match the pin exactly so a stale default fails loudly instead.
function resolvePinnedConfig(catalog: Catalog, pinned: ConfigSelection): ResolvedConfigSelection {
  const resolved = resolveConfigSelection(catalog.results, pinned, createCatalogLookups(catalog));
  if (resolved.hardwareId !== pinned.hardwareId || resolved.modelId !== pinned.modelId || resolved.quant !== pinned.quant) {
    throw new Error(
      `Pinned default config (hardware=${pinned.hardwareId}, model=${pinned.modelId}, quant=${pinned.quant}) no longer matches any catalog result -- update DEFAULT_LEFT_CONFIG/DEFAULT_RIGHT_CONFIG in catalog.ts.`
    );
  }
  return resolved;
}

export function defaultLeftResultId(catalog: Catalog): string {
  return resolvePinnedConfig(catalog, DEFAULT_LEFT_CONFIG).resultId;
}

export function defaultRightResultId(catalog: Catalog): string {
  return resolvePinnedConfig(catalog, DEFAULT_RIGHT_CONFIG).resultId;
}

export interface CatalogLookups {
  hardwareById: (id: string) => HardwareConfig | undefined;
  modelById: (id: string) => ModelMetadata | undefined;
  resultById: (id: string) => BenchmarkResult | undefined;
  scenarioById: (id: string) => ScenarioScript | undefined;
}

export function createCatalogLookups(catalog: Catalog): CatalogLookups {
  const hardwareByIdMap = new Map(catalog.hardware.map((item) => [item.id, item]));
  const modelByIdMap = new Map(catalog.models.map((item) => [item.id, item]));
  const resultByIdMap = new Map(catalog.results.map((item) => [item.id, item]));
  const scenarioByIdMap = new Map(catalog.scenarios.map((item) => [item.id, item]));

  return {
    hardwareById: (id) => hardwareByIdMap.get(id),
    modelById: (id) => modelByIdMap.get(id),
    resultById: (id) => resultByIdMap.get(id),
    scenarioById: (id) => scenarioByIdMap.get(id)
  };
}

export function getResult(catalog: Catalog, id: string): BenchmarkResult {
  const result = createCatalogLookups(catalog).resultById(id);
  if (!result) {
    throw new Error(`Unknown result: ${id}`);
  }
  return result;
}

export function getScenario(catalog: Catalog, id: string): ScenarioScript {
  const scenario = createCatalogLookups(catalog).scenarioById(id);
  if (!scenario) {
    throw new Error(`Unknown scenario: ${id}`);
  }
  return scenario;
}

export function compactResultLabel(catalog: Catalog, result: BenchmarkResult): string {
  const lookups = createCatalogLookups(catalog);
  const config = lookups.hardwareById(result.hardware);
  const model = lookups.modelById(result.model);
  return `${config?.shortName ?? result.hardware} · ${model?.name ?? result.model}`;
}

export function resultMeta(catalog: Catalog, result: BenchmarkResult): string {
  const config = createCatalogLookups(catalog).hardwareById(result.hardware);
  return `${config?.memory ?? "memory unknown"} · ${result.runtime.backend} · ${result.runtime.cache} cache`;
}

export function defaultScenario(catalog: Catalog) {
  return getScenario(catalog, DEFAULT_SCENARIO_ID);
}

export function computeScenarioSeconds(
  result: BenchmarkResult,
  scenario: ScenarioScript,
  cacheMode: CacheMode = "runtime"
): number {
  const timeline = buildTimeline({ result, scenario, cacheMode });
  return summarizeTimeline(timeline).wallTimeMs / 1000;
}

export function rankedResults(catalog: Catalog, scenario: ScenarioScript = defaultScenario(catalog)) {
  const lookups = createCatalogLookups(catalog);
  return catalog.results
    .map((result) => {
      const seconds = computeScenarioSeconds(result, scenario);
      return {
        result,
        seconds,
        hardware: lookups.hardwareById(result.hardware),
        model: lookups.modelById(result.model),
        summary: summarizeTimeline(buildTimeline({ result, scenario, cacheMode: "runtime" }))
      };
    })
    .sort((a, b) => a.seconds - b.seconds);
}

export function scenarioOptions(catalog: Catalog) {
  return catalog.scenarios.map((scenario) => ({
    value: scenario.id,
    title: scenario.title,
    sub:
      scenario.type === "agent"
        ? `${Math.round(scenario.systemPromptTokens / 1000)}k system · ${scenario.events.filter((event) => event.role.startsWith("tool")).length} tool events`
        : scenario.type === "chatbot"
          ? `${scenario.events.filter((event) => event.role === "assistant").length} turns · growing context`
          : `${Math.round(scenario.events.reduce((sum, event) => sum + event.tokens, 0) / 100) / 10}k tokens`
  }));
}
