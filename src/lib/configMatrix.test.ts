import { describe, expect, test } from "vitest";
import type { BenchmarkResult } from "../types";
import { readPrunedCatalogFromDisk } from "../../scripts/validate-data";
import { createCatalogLookups } from "./catalog";
import {
  compareResultPreference,
  filterResultsBySelection,
  getHardwareOptions,
  getModelOptions,
  getQuantOptions,
  getRuntimeOptions,
  resolveConfigSelection,
  updateConfigFilterSelection,
  updateConfigSelection
} from "./configMatrix";

const catalog = readPrunedCatalogFromDisk();
const { results } = catalog;
const refs = createCatalogLookups(catalog);

function makeResult(overrides: Partial<BenchmarkResult> & { id: string }): BenchmarkResult {
  return {
    hardware: "comparator-hw",
    model: "comparator-model",
    quant: "4bit",
    runtime: { name: "TestRuntime", version: "1.0", backend: "CPU", flags: "default", cache: "prefix" },
    measurements: [{ depth: 0, pp: 100, tg: 50 }],
    source: { kind: "raw-json", title: "Synthetic comparator fixture", url: "https://example.com/a" },
    submitter: "test",
    date: "2026-01-01",
    status: "community",
    ...overrides
  };
}

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
    expect(
      options.every((option) =>
        results.some((result) => result.hardware === "dgx-spark" && result.model === option.value)
      )
    ).toBe(true);
  });

  test("cascades quant and runtime options from the selected upper dimensions", () => {
    const quantOptions = getQuantOptions(results, {
      hardwareId: "m2-pro-19c-32gb",
      modelId: "qwen3.5-9b"
    });
    const runtimeOptions = getRuntimeOptions(results, {
      hardwareId: "m2-pro-19c-32gb",
      modelId: "qwen3.5-9b",
      quant: "4bit"
    });

    expect(quantOptions).toEqual(expect.arrayContaining([{ value: "4bit", label: "4BIT" }]));
    expect(runtimeOptions.map((option) => option.label)).toEqual(expect.arrayContaining(["oMLX · MLX"]));
  });

  test("resolves conflicting carried-over selections to a valid top-down result", () => {
    const resolved = resolveConfigSelection(
      results,
      {
        hardwareId: "m2-max-32gb",
        modelId: "qwen3-coder-next",
        quant: "int4"
      },
      refs
    );

    expect(resolved).toMatchObject({
      hardwareId: "m2-max-32gb",
      modelId: "gemma-4-26b-a4b-it",
      quant: "4bit",
      resultId: "m2-max-32gb__gemma-4-26b-a4b-it__4bit__omlx-api-0.3.5.dev1-macos-26.5-78fd5c70d0"
    });
  });

  test("filters rows by the selected dimensions", () => {
    const resolved = resolveConfigSelection(
      results,
      {
        hardwareId: "framework-strix-halo-128gb",
        modelId: "qwen3-30b-a3b",
        quant: "q4_k_xl"
      },
      refs
    );
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
    const dgx = resolveConfigSelection(
      results,
      {
        hardwareId: "dgx-spark",
        modelId: "qwen3-coder-next",
        quant: "int4"
      },
      refs
    );

    const next = updateConfigSelection(results, dgx, "hardwareId", "m2-max-32gb", refs);

    expect(next).toMatchObject({
      hardwareId: "m2-max-32gb",
      modelId: "gemma-4-26b-a4b-it",
      quant: "4bit",
      resultId: "m2-max-32gb__gemma-4-26b-a4b-it__4bit__omlx-api-0.3.5.dev1-macos-26.5-78fd5c70d0"
    });
  });

  test("updateConfigSelection used directly (no redundant second resolve) keeps a cleared field cleared -- PlaygroundPage regression", () => {
    // This is exactly how PlaygroundPage's onChange handlers must consume the
    // return value: assign it straight to state, with no outer
    // resolveConfigSelection wrap. updateConfigSelection already resolves
    // internally for non-clearing changes; wrapping it again only matters
    // (and only breaks things) on the clearing path.
    const current = resolveConfigSelection(
      results,
      {
        hardwareId: "m4-max-40c-64gb",
        modelId: "qwen3.5-9b",
        quant: "4bit"
      },
      refs
    );

    const cleared = updateConfigSelection(results, current, "modelId", "", refs);

    expect(cleared).toEqual({ hardwareId: "m4-max-40c-64gb" });
    expect(cleared).not.toHaveProperty("modelId");
    expect(cleared).not.toHaveProperty("resultId");

    // A page can still derive a resolved view (e.g. to know which result to
    // actually play) without persisting that resolution back into state.
    const resolvedView = resolveConfigSelection(results, cleared, refs);
    expect(resolvedView.modelId).toBeDefined();
    expect(resolvedView.resultId).toBeDefined();

    // The stored selection itself must remain untouched by deriving that view.
    expect(cleared).not.toHaveProperty("modelId");
  });

  test("wrapping updateConfigSelection's clear result in a second resolveConfigSelection call defeats clearing (the bug this guards against)", () => {
    const current = resolveConfigSelection(
      results,
      {
        hardwareId: "m4-max-40c-64gb",
        modelId: "qwen3.5-9b",
        quant: "4bit"
      },
      refs
    );

    const cleared = updateConfigSelection(results, current, "modelId", "", refs);
    // The buggy pattern PlaygroundPage used to have: re-resolve the clear
    // result immediately, snapping modelId back to a concrete value instead
    // of showing the user their clear actually took effect.
    const doubleResolved = resolveConfigSelection(results, cleared, refs);

    expect(doubleResolved.modelId).toBeDefined();
    expect(doubleResolved).not.toEqual(cleared);
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
    expect(
      filterResultsBySelection(results, selection).every((result) => result.hardware === "framework-strix-halo-128gb")
    ).toBe(true);
  });

  test("keeps configs filters broad when choosing a parent dimension", () => {
    const selection = updateConfigFilterSelection({}, "hardwareId", "dgx-spark");
    const filtered = filterResultsBySelection(results, selection);

    expect(selection).toEqual({ hardwareId: "dgx-spark" });
    expect(filtered.length).toBeGreaterThan(1);
    expect(new Set(filtered.map((result) => result.model)).size).toBeGreaterThan(1);
  });
});

describe("compareResultPreference", () => {
  test("prefers verified over community over flagged/illustrative", () => {
    const verified = makeResult({ id: "a", status: "verified" });
    const community = makeResult({ id: "b", status: "community" });
    const flagged = makeResult({ id: "c", status: "flagged" });
    const illustrative = makeResult({ id: "d", status: "illustrative" });

    expect(compareResultPreference(verified, community)).toBeLessThan(0);
    expect(compareResultPreference(community, flagged)).toBeLessThan(0);
    expect(compareResultPreference(flagged, illustrative)).toBe(0);
  });

  test("among equal status, prefers raw evidence over none", () => {
    const withEvidence = makeResult({ id: "a", evidence: { rawUrl: "https://example.com/raw" } });
    const withoutEvidence = makeResult({ id: "b" });

    expect(compareResultPreference(withEvidence, withoutEvidence)).toBeLessThan(0);
  });

  test("source.raw also counts as raw evidence", () => {
    const withSourceRaw = makeResult({
      id: "a",
      source: { kind: "raw-json", title: "x", url: "https://example.com", raw: "data/upstream/x.jsonl" }
    });
    const withoutEvidence = makeResult({ id: "b" });

    expect(compareResultPreference(withSourceRaw, withoutEvidence)).toBeLessThan(0);
  });

  test("among equal status and evidence, prefers more measurement depth points", () => {
    const deeper = makeResult({
      id: "a",
      measurements: [
        { depth: 0, pp: 100, tg: 50 },
        { depth: 4096, pp: 90, tg: 45 }
      ]
    });
    const shallower = makeResult({ id: "b", measurements: [{ depth: 0, pp: 100, tg: 50 }] });

    expect(compareResultPreference(deeper, shallower)).toBeLessThan(0);
  });

  test("as a final tiebreak, prefers the most recent date", () => {
    const newer = makeResult({ id: "a", date: "2026-06-01" });
    const older = makeResult({ id: "b", date: "2026-01-01" });

    expect(compareResultPreference(newer, older)).toBeLessThan(0);
  });

  test("resolveConfigSelection picks the comparator-preferred result among distinct-runtime duplicates for the same hardware/model/quant", () => {
    const wellSourced = makeResult({
      id: "comparator-hw__comparator-model__4bit__runtime-well-sourced",
      status: "community",
      evidence: { rawUrl: "https://example.com/raw" },
      runtime: { name: "TestRuntime", version: "1.0", backend: "CPU", flags: "well-sourced", cache: "prefix" }
    });
    const handTyped = makeResult({
      id: "comparator-hw__comparator-model__4bit__runtime-hand-typed",
      status: "community",
      runtime: { name: "TestRuntime", version: "1.0", backend: "CPU", flags: "hand-typed", cache: "prefix" }
    });

    const resolved = resolveConfigSelection([handTyped, wellSourced], { hardwareId: "comparator-hw" });

    expect(resolved.resultId).toBe(wellSourced.id);
  });
});
