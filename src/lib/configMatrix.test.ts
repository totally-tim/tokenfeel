import { describe, expect, test } from "vitest";
import { catalog, results } from "../data";
import { createCatalogLookups } from "./catalog";
import {
  filterResultsBySelection,
  getHardwareOptions,
  getModelOptions,
  getQuantOptions,
  getRuntimeOptions,
  resolveConfigSelection,
  updateConfigFilterSelection,
  updateConfigSelection
} from "./configMatrix";

const refs = createCatalogLookups(catalog);

describe("configuration matrix", () => {
  test("lists hardware as hardware choices, not full benchmark result labels", () => {
    const options = getHardwareOptions(results, refs);

    expect(options.map((option) => option.label)).toContain("DGX Spark");
    expect(options.every((option) => !option.label.includes("·"))).toBe(true);
  });

  test("cascades model options from selected hardware", () => {
    const options = getModelOptions(results, { hardwareId: "dgx-spark" }, refs);

    expect(options.map((option) => option.value)).toEqual(
      expect.arrayContaining([
        "qwen3-coder-next",
        "test-qwen3-coder-30b-a3b",
        "gpt-oss-120b",
        "gpt-oss-20b",
        "glm-4.7-flash"
      ])
    );
    expect(options.every((option) => results.some((result) => result.hardware === "dgx-spark" && result.model === option.value))).toBe(true);
  });

  test("cascades quant and runtime options from the selected upper dimensions", () => {
    const quantOptions = getQuantOptions(results, {
      hardwareId: "m4-max-40c-64gb",
      modelId: "qwen3.5-9b"
    });
    const runtimeOptions = getRuntimeOptions(results, {
      hardwareId: "m4-max-40c-64gb",
      modelId: "qwen3.5-9b",
      quant: "4bit"
    });

    expect(quantOptions).toEqual(expect.arrayContaining([{ value: "4bit", label: "4BIT" }]));
    expect(runtimeOptions.map((option) => option.label)).toEqual(
      expect.arrayContaining(["oMLX · MLX"])
    );
  });

  test("resolves conflicting carried-over selections to a valid top-down result", () => {
    const resolved = resolveConfigSelection(results, {
      hardwareId: "m2-max-32gb",
      modelId: "qwen3-coder-next",
      quant: "int4"
    }, refs);

    expect(resolved).toMatchObject({
      hardwareId: "m2-max-32gb",
      modelId: "qwen3.5-9b",
      quant: "8bit",
      resultId: "m2-max__qwen3.5-9b__8bit__omlx"
    });
  });

  test("filters rows by the selected dimensions", () => {
    const resolved = resolveConfigSelection(results, {
      hardwareId: "framework-strix-halo-128gb",
      modelId: "qwen3-30b-a3b",
      quant: "q4_k_xl"
    }, refs);
    const filtered = filterResultsBySelection(results, {
      hardwareId: resolved.hardwareId,
      modelId: resolved.modelId,
      quant: resolved.quant,
      runtimeKey: resolved.runtimeKey
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe(resolved.resultId);
  });

  test("updates one dimension and clears conflicting lower dimensions", () => {
    const dgx = resolveConfigSelection(results, {
      hardwareId: "dgx-spark",
      modelId: "qwen3-coder-next",
      quant: "int4"
    }, refs);

    const next = updateConfigSelection(results, dgx, "hardwareId", "m2-max-32gb", refs);

    expect(next).toMatchObject({
      hardwareId: "m2-max-32gb",
      modelId: "qwen3.5-9b",
      quant: "8bit",
      resultId: "m2-max__qwen3.5-9b__8bit__omlx"
    });
  });

  test("allows clearing a filter dimension for broad result filtering", () => {
    const selection = updateConfigFilterSelection(
      {
        hardwareId: "framework-strix-halo-128gb",
        modelId: "qwen3-30b-a3b",
        quant: "q4_k_xl"
      },
      "modelId",
      ""
    );

    expect(selection).toEqual({ hardwareId: "framework-strix-halo-128gb" });
    expect(filterResultsBySelection(results, selection).every((result) => result.hardware === "framework-strix-halo-128gb")).toBe(true);
  });

  test("keeps configs filters broad when choosing a parent dimension", () => {
    const selection = updateConfigFilterSelection({}, "hardwareId", "dgx-spark");
    const filtered = filterResultsBySelection(results, selection);

    expect(selection).toEqual({ hardwareId: "dgx-spark" });
    expect(filtered.length).toBeGreaterThan(1);
    expect(new Set(filtered.map((result) => result.model)).size).toBeGreaterThan(1);
  });
});
