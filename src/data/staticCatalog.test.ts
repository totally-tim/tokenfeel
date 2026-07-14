import { afterEach, describe, expect, it, vi } from "vitest";
import type { BenchmarkResult } from "../types";
import type { StaticCatalog, StaticBenchmarkResult } from "./staticCatalog";

const summaryResult = {
  id: "hardware__model__quant__runtime",
  detailChunk: "chunk-000.json",
  hasSourceRaw: false
} as StaticBenchmarkResult;

const catalog = {
  results: [summaryResult]
} as StaticCatalog;

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" }
  });
}

const validHardware = [
  { id: "hw", name: "Hardware", shortName: "HW", vendor: "Vendor", memory: "64GB", accelerator: "GPU", notes: "synthetic fixture" }
];
const validModels = [
  { id: "model", name: "Model", family: "Family", params: "7B", license: "test", notes: "synthetic fixture" }
];
const validScenarios = [
  { id: "scenario", title: "Scenario", type: "chatbot", systemPromptTokens: 10, events: [{ id: "u1", role: "user", text: "hi", tokens: 5 }] }
];

function validResult(overrides: Record<string, unknown> = {}) {
  return {
    id: "hw__model__4bit__runtime",
    hardware: "hw",
    model: "model",
    quant: "4bit",
    runtime: { name: "runtime", version: "1.0", backend: "backend", flags: "", cache: "prefix" },
    measurements: [{ depth: 0, pp: 100, tg: 50 }],
    source: { kind: "raw-json", title: "Synthetic fixture", url: "https://example.test/source" },
    submitter: "test",
    date: "2026-01-01",
    status: "community",
    detailChunk: "chunk-000.json",
    hasSourceRaw: false,
    ...overrides
  };
}

function validIndexPayload(resultOverrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    generatedAt: "2026-01-01T00:00:00Z",
    resultCount: 1,
    hardware: validHardware,
    models: validModels,
    scenarios: validScenarios,
    results: [validResult(resultOverrides)]
  };
}

describe("static catalog runtime re-validation (A2)", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("resolves with the catalog when the fetched index is well-formed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(validIndexPayload())));

    const { loadStaticCatalog } = await import("./staticCatalog");
    const catalog = await loadStaticCatalog();

    expect(catalog.results).toHaveLength(1);
    expect(catalog.results[0].id).toBe("hw__model__4bit__runtime");
  });

  it("rejects loudly, instead of silently propagating bad data, when the fetched index fails schema validation", async () => {
    const malformed = { ...validIndexPayload(), hardware: [] }; // hardware must be non-empty
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(malformed)));

    const { loadStaticCatalog } = await import("./staticCatalog");

    await expect(loadStaticCatalog()).rejects.toThrow(/Static catalog failed validation/);
  });

  it("rejects when a result in the fetched index references unknown hardware (corrupted/stale chunk)", async () => {
    const malformed = validIndexPayload({ hardware: "ghost-hardware" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(malformed)));

    const { loadStaticCatalog } = await import("./staticCatalog");

    await expect(loadStaticCatalog()).rejects.toThrow(/Static catalog failed validation/);
  });

  it("drops only the invalid row from a chunk instead of failing every result that shares it", async () => {
    // A detail chunk is hash-bucketed across ~46 unrelated results, so one
    // corrupt row must not take down its neighbors' detail lookups too.
    const goodRow = validResult({ id: "hw__model__4bit__runtime" });
    const otherSummary = { ...goodRow, id: "hw__model__8bit__other", quant: "8bit" };
    const payload = { ...validIndexPayload(), resultCount: 2, results: [goodRow, otherSummary] };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(payload))
      .mockResolvedValueOnce(jsonResponse([goodRow, { id: "not-a-real-result" }]));
    vi.stubGlobal("fetch", fetchMock);

    const { loadStaticCatalog, loadResultDetail } = await import("./staticCatalog");
    const catalog = await loadStaticCatalog();

    const detail = await loadResultDetail(catalog, "hw__model__4bit__runtime");
    expect(detail.measurements).toEqual(goodRow.measurements);

    // The invalid row is dropped rather than surfaced -- the caller falls
    // back to the compacted summary it already had instead of an error.
    const fallback = await loadResultDetail(catalog, "hw__model__8bit__other");
    expect(fallback).toEqual(catalog.results.find((result) => result.id === "hw__model__8bit__other"));
  });
});

describe("static catalog detail loading", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("does not keep a failed detail chunk promise in cache", async () => {
    const fullResult: BenchmarkResult = {
      id: summaryResult.id,
      hardware: "hardware",
      model: "model",
      quant: "4bit",
      runtime: {
        name: "runtime",
        version: "1.0.0",
        backend: "backend",
        flags: "",
        cache: "prefix"
      },
      measurements: [{ depth: 1, pp: 1, tg: 1 }],
      source: {
        kind: "raw-json",
        title: "Full detail",
        url: "https://example.test/detail.json",
        raw: "full evidence"
      },
      submitter: "test",
      date: "2026-01-01",
      status: "community"
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 500, statusText: "Internal Server Error" }))
      .mockResolvedValueOnce(jsonResponse([fullResult]));
    vi.stubGlobal("fetch", fetchMock);

    const { loadResultDetail } = await import("./staticCatalog");

    await expect(loadResultDetail(catalog, summaryResult.id)).rejects.toThrow("Failed to load");
    await expect(loadResultDetail(catalog, summaryResult.id)).resolves.toMatchObject({ source: { raw: "full evidence" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
