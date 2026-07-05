import { filterResultsBySelection, runtimeKey, type ConfigSelection, type ConfigSelectionField, type ConfigMatrixRefs, type MatrixOption } from "./configMatrix";
import type { BenchmarkResult, Catalog } from "../types";

export type RaceSetupField = ConfigSelectionField;
export type RaceSetupMode = "model" | "hardware" | "runtime";

export interface RaceSuggestion {
  result: BenchmarkResult;
  score: number;
  reason: string;
}

export const raceSetupOrders: Record<RaceSetupMode, RaceSetupField[]> = {
  model: ["modelId", "hardwareId", "runtimeKey", "quant"],
  hardware: ["hardwareId", "modelId", "runtimeKey", "quant"],
  runtime: ["runtimeKey", "modelId", "hardwareId", "quant"]
};

export function selectionFromResult(result: BenchmarkResult): Required<ConfigSelection> {
  return {
    hardwareId: result.hardware,
    modelId: result.model,
    quant: result.quant,
    runtimeKey: runtimeKey(result)
  };
}

function uniqueOptions(options: MatrixOption[]): MatrixOption[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (seen.has(option.value)) return false;
    seen.add(option.value);
    return true;
  });
}

function optionForResult(
  result: BenchmarkResult,
  field: RaceSetupField,
  refs: ConfigMatrixRefs
): MatrixOption {
  if (field === "hardwareId") {
    const hardware = refs.hardwareById(result.hardware);
    return {
      value: result.hardware,
      label: hardware?.shortName ?? result.hardware,
      sub: hardware?.memory
    };
  }

  if (field === "modelId") {
    const model = refs.modelById(result.model);
    return {
      value: result.model,
      label: model?.name ?? result.model,
      sub: model?.activeParams ? `${model.activeParams} active` : model?.params
    };
  }

  if (field === "runtimeKey") {
    return {
      value: runtimeKey(result),
      label: `${result.runtime.name} · ${result.runtime.backend}`,
      sub: result.runtime.flags || result.runtime.version
    };
  }

  return {
    value: result.quant,
    label: result.quant.toUpperCase()
  };
}

export function raceFieldOptions(
  results: BenchmarkResult[],
  field: RaceSetupField,
  refs: ConfigMatrixRefs,
  constraints: ConfigSelection = {}
): MatrixOption[] {
  return uniqueOptions(filterResultsBySelection(results, constraints).map((result) => optionForResult(result, field, refs)));
}

function candidatePreservationScore(candidate: BenchmarkResult, current: ConfigSelection): number {
  const candidateRuntime = runtimeKey(candidate);
  let score = 0;
  if (candidate.model === current.modelId) score += 48;
  if (candidate.hardware === current.hardwareId) score += 36;
  if (candidateRuntime === current.runtimeKey) score += 24;
  if (candidate.quant === current.quant) score += 18;
  return score;
}

export function resolveRaceSelection(
  results: BenchmarkResult[],
  current: ConfigSelection,
  constraints: ConfigSelection
): BenchmarkResult {
  const candidates = filterResultsBySelection(results, constraints);
  const ranked = [...candidates].sort((a, b) => {
    const delta = candidatePreservationScore(b, current) - candidatePreservationScore(a, current);
    return delta || a.id.localeCompare(b.id);
  });
  const result = ranked[0];

  if (!result) {
    throw new Error("No benchmark result matches the requested race setup");
  }

  return result;
}

export function constraintsForFieldChange(
  current: Required<ConfigSelection>,
  order: RaceSetupField[],
  field: RaceSetupField,
  value: string
): ConfigSelection {
  const fieldIndex = order.indexOf(field);
  const constraints: ConfigSelection = {};

  for (const priorField of order.slice(0, Math.max(0, fieldIndex))) {
    constraints[priorField] = current[priorField];
  }

  constraints[field] = value;
  return constraints;
}

function maxMeasuredDepth(result: BenchmarkResult): number {
  return Math.max(...result.measurements.map((measurement) => measurement.depth));
}

function modelFamily(catalog: Catalog, result: BenchmarkResult): string | undefined {
  return catalog.models.find((model) => model.id === result.model)?.family;
}

function suggestionReason(catalog: Catalog, anchor: BenchmarkResult, candidate: BenchmarkResult): string {
  const sameModel = anchor.model === candidate.model;
  const sameQuant = anchor.quant === candidate.quant;
  const sameRuntime = runtimeKey(anchor) === runtimeKey(candidate);
  const sameRuntimeName = anchor.runtime.name === candidate.runtime.name;
  const sameBackend = anchor.runtime.backend === candidate.runtime.backend;
  const sameFamily = modelFamily(catalog, anchor) && modelFamily(catalog, anchor) === modelFamily(catalog, candidate);

  if (sameModel && sameQuant && sameRuntime) return "same model, quant and runtime";
  if (sameModel && sameQuant && sameRuntimeName) return "same model and quant, similar runtime";
  if (sameModel && (sameRuntimeName || sameBackend)) return "same model, related runtime";
  if (sameModel) return "same model on different stack";
  if (sameFamily) return "same model family";
  return "exploratory comparison";
}

function suggestionScore(catalog: Catalog, anchor: BenchmarkResult, candidate: BenchmarkResult): number {
  const sameRuntime = runtimeKey(anchor) === runtimeKey(candidate);
  const sameFamily = modelFamily(catalog, anchor) && modelFamily(catalog, anchor) === modelFamily(catalog, candidate);
  let score = 0;

  if (candidate.hardware !== anchor.hardware) score += 30;
  else score -= 30;

  if (candidate.model === anchor.model) score += 120;
  else if (sameFamily) score += 42;

  if (candidate.quant === anchor.quant) score += 42;
  if (sameRuntime) score += 36;
  else {
    if (candidate.runtime.name === anchor.runtime.name) score += 22;
    if (candidate.runtime.backend === anchor.runtime.backend) score += 16;
  }
  if (candidate.runtime.cache === anchor.runtime.cache) score += 8;

  score += Math.min(18, Math.log2(maxMeasuredDepth(candidate) + 1));
  return score;
}

export function suggestComparableResults(catalog: Catalog, anchor: BenchmarkResult, limit = 4): RaceSuggestion[] {
  const anchorFamily = modelFamily(catalog, anchor);
  return catalog.results
    .filter((candidate) => candidate.id !== anchor.id)
    .filter((candidate) => candidate.model === anchor.model || (!!anchorFamily && modelFamily(catalog, candidate) === anchorFamily))
    .map((candidate) => ({
      result: candidate,
      score: suggestionScore(catalog, anchor, candidate),
      reason: suggestionReason(catalog, anchor, candidate)
    }))
    .filter((suggestion) => suggestion.score > 50)
    .sort((a, b) => b.score - a.score || a.result.id.localeCompare(b.result.id))
    .slice(0, limit);
}

export function comparisonSummary(catalog: Catalog, left: BenchmarkResult, right: BenchmarkResult): { label: string; detail: string; level: "strong" | "related" | "loose" } {
  const sameModel = left.model === right.model;
  const sameQuant = left.quant === right.quant;
  const sameRuntime = runtimeKey(left) === runtimeKey(right);
  const sameFamily = modelFamily(catalog, left) && modelFamily(catalog, left) === modelFamily(catalog, right);

  if (sameModel && sameQuant && sameRuntime && left.hardware !== right.hardware) {
    return {
      label: "Hardware comparison",
      detail: "Same model, quant and runtime. The hardware is the main variable.",
      level: "strong"
    };
  }

  if (sameModel && left.hardware === right.hardware) {
    return {
      label: sameQuant ? "Runtime comparison" : "Configuration comparison",
      detail:
        sameQuant && sameRuntime
          ? "Same model and hardware. This is effectively the same measured setup."
          : sameQuant
            ? "Same model, hardware and quant. Runtime differences are the main variable."
            : "Same model and hardware, but quant and runtime both differ.",
      level: sameQuant ? "strong" : "related"
    };
  }

  if (sameModel && left.hardware !== right.hardware) {
    return {
      label: "Same model comparison",
      detail:
        sameQuant && left.runtime.name === right.runtime.name && left.runtime.backend === right.runtime.backend
          ? "Same model and quant on the same runtime family. Hardware is the main variable."
          : sameQuant
            ? "Same model and quant; runtime differences are still visible."
            : "Same model, different quant or runtime.",
      level: "strong"
    };
  }

  if (sameFamily) {
    return {
      label: "Related model comparison",
      detail: "Same model family. Useful, but not a clean hardware-only race.",
      level: "related"
    };
  }

  return {
    label: "Exploratory comparison",
    detail: "Different models. Use this deliberately when the setup itself is the question.",
    level: "loose"
  };
}
