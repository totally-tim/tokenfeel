import { afterEach, describe, expect, it, vi } from "vitest";
import type { BenchmarkResult } from "../types";
import type { StaticCatalog, StaticBenchmarkResult } from "./staticCatalog";

const summaryResult = {
  id: "hardware__model__quant__runtime",
  detailChunk: "chunk-000.json"
} as StaticBenchmarkResult;

const catalog = {
  results: [summaryResult]
} as StaticCatalog;

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" }
  });
}

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
