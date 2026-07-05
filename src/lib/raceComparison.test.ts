import { describe, expect, test } from "vitest";
import type { BenchmarkResult, Catalog } from "../types";
import {
  comparisonSummary,
  constraintsForFieldChange,
  raceFieldOptions,
  raceSetupOrders,
  resolveRaceSelection,
  selectionFromResult,
  suggestComparableResults
} from "./raceComparison";

const baseResult = {
  measurements: [{ depth: 0, pp: 100, tg: 50 }],
  runtime: { name: "oMLX", version: "1", backend: "MLX", flags: "pp2048/tg128", cache: "prefix" },
  source: { kind: "raw-json", title: "Synthetic", url: "https://example.com" },
  submitter: "test",
  date: "2026-01-01",
  status: "verified"
} satisfies Partial<BenchmarkResult>;

function result(overrides: Partial<BenchmarkResult>): BenchmarkResult {
  return {
    ...baseResult,
    id: "missing",
    hardware: "missing-hardware",
    model: "missing-model",
    quant: "4bit",
    ...overrides
  } as BenchmarkResult;
}

const catalog: Catalog = {
  hardware: [
    { id: "m4", name: "M4", shortName: "M4", vendor: "Apple", memory: "64 GB", accelerator: "GPU", notes: "" },
    { id: "m5", name: "M5", shortName: "M5", vendor: "Apple", memory: "64 GB", accelerator: "GPU", notes: "" },
    { id: "dgx", name: "DGX", shortName: "DGX", vendor: "NVIDIA", memory: "128 GB", accelerator: "GPU", notes: "" }
  ],
  models: [
    { id: "qwen", name: "Qwen", family: "Qwen", params: "9B", license: "test", notes: "" },
    { id: "qwen-coder", name: "Qwen Coder", family: "Qwen", params: "30B", license: "test", notes: "" },
    { id: "gemma", name: "Gemma", family: "Gemma", params: "26B", license: "test", notes: "" }
  ],
  results: [
    result({ id: "m4-qwen", hardware: "m4", model: "qwen", quant: "4bit" }),
    result({ id: "m5-qwen", hardware: "m5", model: "qwen", quant: "4bit", measurements: [{ depth: 32768, pp: 80, tg: 40 }] }),
    result({ id: "dgx-qwen", hardware: "dgx", model: "qwen", quant: "4bit", runtime: { name: "vLLM", version: "1", backend: "CUDA", flags: "", cache: "prefix" } }),
    result({ id: "m5-gemma", hardware: "m5", model: "gemma", quant: "4bit" })
  ],
  scenarios: []
};

const refs = {
  hardwareById: (id: string) => catalog.hardware.find((item) => item.id === id),
  modelById: (id: string) => catalog.models.find((item) => item.id === id)
};

describe("race comparison helpers", () => {
  test("resolves a model-first field change even when current hardware would otherwise conflict", () => {
    const current = selectionFromResult(catalog.results[3]!);
    const constraints = constraintsForFieldChange(current, raceSetupOrders.model, "modelId", "qwen");
    const resolved = resolveRaceSelection(catalog.results, current, constraints);

    expect(resolved.model).toBe("qwen");
    expect(resolved.hardware).toBe("m5");
  });

  test("narrows later field options by earlier progressive-disclosure choices", () => {
    const options = raceFieldOptions(catalog.results, "hardwareId", refs, { modelId: "qwen" });

    expect(options.map((option) => option.value)).toEqual(["m4", "m5", "dgx"]);
  });

  test("suggests same-model hardware comparisons before exploratory comparisons", () => {
    const suggestions = suggestComparableResults(catalog, catalog.results[0]!, 3);

    expect(suggestions[0]?.result.id).toBe("m5-qwen");
    expect(suggestions[0]?.reason).toBe("same model, quant and runtime");
    expect(suggestions.map((suggestion) => suggestion.result.id)).not.toContain("m5-gemma");
  });

  test("labels exact same-model runtime races as hardware comparisons", () => {
    expect(comparisonSummary(catalog, catalog.results[0]!, catalog.results[1]!)).toMatchObject({
      label: "Hardware comparison",
      level: "strong"
    });
  });

  test("labels same-model same-hardware quant variants as related configuration comparisons", () => {
    const dspark = result({
      id: "dgx-qwen-dspark",
      hardware: "dgx",
      model: "qwen",
      quant: "fp4-fp8-mixed",
      runtime: { name: "vLLM DSpark", version: "1", backend: "CUDA/mp TP=2", flags: "", cache: "prefix" }
    });
    const mtp = result({
      id: "dgx-qwen-mtp",
      hardware: "dgx",
      model: "qwen",
      quant: "fp8",
      runtime: { name: "vLLM MTP", version: "1", backend: "CUDA/mp TP=2", flags: "", cache: "prefix" }
    });

    expect(comparisonSummary(catalog, dspark, mtp)).toMatchObject({
      label: "Configuration comparison",
      detail: "Same model and hardware, but quant and runtime both differ.",
      level: "related"
    });
  });
});
