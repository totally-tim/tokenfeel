import { buildTimeline, summarizeTimeline } from "../sim/timing";
import type { BenchmarkResult, CacheMode, Catalog, HardwareConfig, ModelMetadata, ScenarioScript } from "../types";

export const DEFAULT_SCENARIO_ID = "repo-wide-refactor";
export const DEFAULT_LEFT_RESULT_ID = "m4-max-40c-48gb__qwen3.5-9b__4bit__omlx-api";
export const DEFAULT_RIGHT_RESULT_ID = "m5-max-40c-128gb__qwen3.5-9b__4bit__omlx-api";

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

export function resultLabel(catalog: Catalog, result: BenchmarkResult): string {
  const lookups = createCatalogLookups(catalog);
  const config = lookups.hardwareById(result.hardware);
  const model = lookups.modelById(result.model);
  return `${config?.shortName ?? result.hardware} · ${model?.name ?? result.model} · ${result.quant.toUpperCase()} · ${result.runtime.name}/${result.runtime.backend}`;
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

export function uniqueCombos(catalog: Catalog) {
  return new Set(catalog.results.map((result) => `${result.hardware}:${result.model}:${result.quant}`)).size;
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

export function resultOptions(catalog: Catalog) {
  const lookups = createCatalogLookups(catalog);
  return catalog.results.map((result) => ({
    value: result.id,
    label: `${lookups.hardwareById(result.hardware)?.shortName ?? result.hardware} · ${lookups.modelById(result.model)?.name ?? result.model} · ${result.quant.toUpperCase()} · ${result.runtime.name}/${result.runtime.backend}`,
    sub: `${lookups.hardwareById(result.hardware)?.memory ?? "memory unknown"} · ${result.runtime.backend} · ${result.runtime.cache} cache`
  }));
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

export function hardwareOptions(catalog: Catalog) {
  return catalog.hardware.map((item) => ({ value: item.id, label: item.shortName, sub: item.memory }));
}
