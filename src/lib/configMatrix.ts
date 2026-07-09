import type { BenchmarkResult, HardwareConfig, ModelMetadata } from "../types";

export interface ConfigSelection {
  hardwareId?: string;
  modelId?: string;
  quant?: string;
  runtimeKey?: string;
}

export interface ResolvedConfigSelection {
  hardwareId: string;
  modelId: string;
  quant: string;
  runtimeKey: string;
  resultId: string;
}

export interface MatrixOption {
  value: string;
  label: string;
  sub?: string;
}

export type ConfigSelectionField = keyof ConfigSelection;

export interface ConfigMatrixRefs {
  hardwareById: (id: string) => HardwareConfig | undefined;
  modelById: (id: string) => ModelMetadata | undefined;
}

const emptyRefs: ConfigMatrixRefs = {
  hardwareById: () => undefined,
  modelById: () => undefined
};

function isOmlxSourced(result: BenchmarkResult): boolean {
  return result.runtime.name === "oMLX";
}

export function runtimeKey(result: BenchmarkResult): string {
  const base = [result.runtime.name, result.runtime.backend, result.runtime.version, result.runtime.flags].join("::");
  // oMLX community rows carry their toolchain/OS version in topology, not in
  // runtime.flags -- fold it in so results that only differ by macOS version
  // (same oMLX version, same generic flags text) get distinct keys instead of
  // colliding as if they were the same benchmark config.
  if (!isOmlxSourced(result)) return base;
  return [base, result.topology?.os ?? "unknown-os"].join("::");
}

function uniqueOptions(options: MatrixOption[]): MatrixOption[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (seen.has(option.value)) return false;
    seen.add(option.value);
    return true;
  });
}

function matchesSelection(result: BenchmarkResult, selection: ConfigSelection): boolean {
  return (
    (!selection.hardwareId || result.hardware === selection.hardwareId) &&
    (!selection.modelId || result.model === selection.modelId) &&
    (!selection.quant || result.quant === selection.quant) &&
    (!selection.runtimeKey || runtimeKey(result) === selection.runtimeKey)
  );
}

export function filterResultsBySelection(results: BenchmarkResult[], selection: ConfigSelection): BenchmarkResult[] {
  return results.filter((result) => matchesSelection(result, selection));
}

export function getHardwareOptions(results: BenchmarkResult[], refs: ConfigMatrixRefs = emptyRefs): MatrixOption[] {
  return uniqueOptions(
    results.map((result) => {
      const hardware = refs.hardwareById(result.hardware);
      return {
        value: result.hardware,
        label: hardware?.shortName ?? result.hardware,
        sub: hardware?.memory
      };
    })
  );
}

export function getModelOptions(
  results: BenchmarkResult[],
  selection: ConfigSelection,
  refs: ConfigMatrixRefs = emptyRefs
): MatrixOption[] {
  return uniqueOptions(
    filterResultsBySelection(results, { hardwareId: selection.hardwareId }).map((result) => {
      const model = refs.modelById(result.model);
      return {
        value: result.model,
        label: model?.name ?? result.model,
        sub: model?.activeParams ? `${model.activeParams} active` : model?.params
      };
    })
  );
}

export function getQuantOptions(results: BenchmarkResult[], selection: ConfigSelection): MatrixOption[] {
  return uniqueOptions(
    filterResultsBySelection(results, {
      hardwareId: selection.hardwareId,
      modelId: selection.modelId
    }).map((result) => ({
      value: result.quant,
      label: result.quant.toUpperCase()
    }))
  );
}

export function getRuntimeOptions(results: BenchmarkResult[], selection: ConfigSelection): MatrixOption[] {
  return uniqueOptions(
    filterResultsBySelection(results, {
      hardwareId: selection.hardwareId,
      modelId: selection.modelId,
      quant: selection.quant
    }).map((result) => ({
      value: runtimeKey(result),
      label: `${result.runtime.name} · ${result.runtime.backend}`,
      sub: result.runtime.flags
    }))
  );
}

function firstValue(options: MatrixOption[], field: string): string {
  const value = options[0]?.value;
  if (!value) {
    throw new Error(`No benchmark results available for ${field}`);
  }
  return value;
}

function selectedOrFirst(options: MatrixOption[], value: string | undefined, field: string): string {
  if (value && options.some((option) => option.value === value)) {
    return value;
  }
  return firstValue(options, field);
}

const statusPreferenceRank: Record<BenchmarkResult["status"], number> = {
  verified: 0,
  community: 1,
  flagged: 2,
  illustrative: 2
};

function hasRawEvidence(result: BenchmarkResult): boolean {
  return Boolean(result.source.raw || result.evidence?.rawUrl);
}

/**
 * Preference order for picking a default result among legitimately distinct
 * runtime variants of the same (hardware, model, quant) -- i.e. results that
 * do NOT share a runtimeKey. This must never be used to silently pick a
 * winner between true duplicates (same runtimeKey too); those are a hard
 * catalogSchema validation issue instead. Precedence, most to least
 * important: verified > community > flagged/illustrative status; raw
 * evidence (source.raw or evidence.rawUrl) present over absent; more
 * measurement depth points over fewer; most recent date over older.
 */
export function compareResultPreference(a: BenchmarkResult, b: BenchmarkResult): number {
  const statusDiff = statusPreferenceRank[a.status] - statusPreferenceRank[b.status];
  if (statusDiff !== 0) return statusDiff;

  const evidenceDiff = Number(hasRawEvidence(b)) - Number(hasRawEvidence(a));
  if (evidenceDiff !== 0) return evidenceDiff;

  const depthDiff = b.measurements.length - a.measurements.length;
  if (depthDiff !== 0) return depthDiff;

  return b.date.localeCompare(a.date);
}

function preferredResult(results: BenchmarkResult[], field: string): BenchmarkResult {
  if (results.length === 0) {
    throw new Error(`No benchmark results available for ${field}`);
  }
  return [...results].sort(compareResultPreference)[0];
}

export function resolveConfigSelection(
  results: BenchmarkResult[],
  selection: ConfigSelection = {},
  refs: ConfigMatrixRefs = emptyRefs
): ResolvedConfigSelection {
  const hardwareId = selectedOrFirst(getHardwareOptions(results, refs), selection.hardwareId, "hardware");
  const modelId = selectedOrFirst(getModelOptions(results, { hardwareId }, refs), selection.modelId, "model");
  const quant = selectedOrFirst(getQuantOptions(results, { hardwareId, modelId }), selection.quant, "quant");
  const runtimeOptions = getRuntimeOptions(results, { hardwareId, modelId, quant });
  const runtimeKeyValue =
    selection.runtimeKey && runtimeOptions.some((option) => option.value === selection.runtimeKey)
      ? selection.runtimeKey
      : runtimeKey(preferredResult(filterResultsBySelection(results, { hardwareId, modelId, quant }), "runtime"));
  const result = filterResultsBySelection(results, {
    hardwareId,
    modelId,
    quant,
    runtimeKey: runtimeKeyValue
  })[0];

  if (!result) {
    throw new Error(`No benchmark result for ${hardwareId}/${modelId}/${quant}/${runtimeKeyValue}`);
  }

  return {
    hardwareId,
    modelId,
    quant,
    runtimeKey: runtimeKeyValue,
    resultId: result.id
  };
}

export function updateConfigSelection(
  results: BenchmarkResult[],
  current: ConfigSelection,
  field: ConfigSelectionField,
  value: string,
  refs: ConfigMatrixRefs = emptyRefs
): ConfigSelection | ResolvedConfigSelection {
  if (!value) {
    if (field === "hardwareId") return {};
    if (field === "modelId") return current.hardwareId ? { hardwareId: current.hardwareId } : {};
    if (field === "quant") {
      return {
        hardwareId: current.hardwareId,
        modelId: current.modelId
      };
    }
    return {
      hardwareId: current.hardwareId,
      modelId: current.modelId,
      quant: current.quant
    };
  }

  if (field === "hardwareId") {
    return resolveConfigSelection(results, { hardwareId: value }, refs);
  }

  if (field === "modelId") {
    return resolveConfigSelection(
      results,
      {
        hardwareId: current.hardwareId,
        modelId: value
      },
      refs
    );
  }

  if (field === "quant") {
    return resolveConfigSelection(
      results,
      {
        hardwareId: current.hardwareId,
        modelId: current.modelId,
        quant: value
      },
      refs
    );
  }

  return resolveConfigSelection(
    results,
    {
      hardwareId: current.hardwareId,
      modelId: current.modelId,
      quant: current.quant,
      runtimeKey: value
    },
    refs
  );
}

export function updateConfigFilterSelection(
  current: ConfigSelection,
  field: ConfigSelectionField,
  value: string
): ConfigSelection {
  if (field === "hardwareId") {
    return value ? { hardwareId: value } : {};
  }

  if (field === "modelId") {
    return value ? { hardwareId: current.hardwareId, modelId: value } : { hardwareId: current.hardwareId };
  }

  if (field === "quant") {
    return value
      ? { hardwareId: current.hardwareId, modelId: current.modelId, quant: value }
      : { hardwareId: current.hardwareId, modelId: current.modelId };
  }

  return value
    ? {
        hardwareId: current.hardwareId,
        modelId: current.modelId,
        quant: current.quant,
        runtimeKey: value
      }
    : {
        hardwareId: current.hardwareId,
        modelId: current.modelId,
        quant: current.quant
      };
}
