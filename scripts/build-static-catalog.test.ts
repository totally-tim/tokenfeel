import { describe, expect, test } from "vitest";
import type { ParsedCatalog } from "../src/data/schemas";
import { buildStaticCatalogPayload } from "./build-static-catalog";

function fixtureCatalog(): ParsedCatalog {
  return {
    hardware: [
      {
        id: "test-hardware",
        name: "Test Hardware",
        shortName: "Test HW",
        vendor: "Tokenfeel",
        memory: "128 GB",
        accelerator: "Test accelerator",
        notes: "Synthetic hardware"
      }
    ],
    models: [
      {
        id: "test-model",
        name: "Test Model",
        family: "Test",
        params: "7B",
        license: "MIT",
        notes: "Synthetic model"
      }
    ],
    results: [
      {
        id: "test-hardware__test-model__q4_k_m__llamacpp-cuda",
        hardware: "test-hardware",
        model: "test-model",
        quant: "q4_k_m",
        runtime: {
          name: "llama.cpp",
          version: "b1",
          backend: "CUDA",
          flags: "-fa",
          cache: "prefix"
        },
        measurements: [
          { depth: 0, pp: 1000, tg: 80 },
          { depth: 8192, pp: 700, tg: 55 }
        ],
        evidence: {
          rawUrl: "https://example.com/raw.txt",
          rawRows: ["very large raw row that belongs in detail chunks only"]
        },
        benchmark: {
          command: "./llama-bench -m test.gguf",
          metadata: { host: "lab-a" }
        },
        source: {
          kind: "llama-bench",
          title: "Synthetic source",
          url: "https://example.com/source",
          raw: "large attached raw benchmark text"
        },
        submitter: "Tokenfeel",
        date: "2026-01-01",
        status: "verified"
      }
    ],
    scenarios: [
      {
        id: "agent-bugfix",
        title: "Agent bugfix",
        type: "agent",
        systemPromptTokens: 1000,
        events: [{ id: "u1", role: "user", text: "fix bug", tokens: 12 }]
      }
    ]
  };
}

describe("buildStaticCatalogPayload", () => {
  test("keeps the runtime index compact while detail chunks retain full provenance", () => {
    const payload = buildStaticCatalogPayload(fixtureCatalog());
    const summary = payload.index.results[0];
    const detail = payload.detailChunks[summary.detailChunk]?.[0];

    expect(summary).toMatchObject({
      id: "test-hardware__test-model__q4_k_m__llamacpp-cuda",
      hardware: "test-hardware",
      model: "test-model",
      status: "verified"
    });
    expect(summary.evidence?.rawUrl).toBe("https://example.com/raw.txt");
    expect(summary.evidence).not.toHaveProperty("rawRows");
    expect(summary.source).not.toHaveProperty("raw");
    expect(summary.benchmark).not.toHaveProperty("metadata");
    expect(summary.detailChunk).toMatch(/^chunk-\d+\.json$/);
    expect(summary.hasSourceRaw).toBe(true);

    expect(detail?.source.raw).toBe("large attached raw benchmark text");
    expect(detail?.evidence?.rawRows).toEqual(["very large raw row that belongs in detail chunks only"]);
    expect(detail?.benchmark?.metadata).toEqual({ host: "lab-a" });
  });

  test("sets hasSourceRaw false when a result has neither source.raw nor evidence.rawUrl", () => {
    const catalog = fixtureCatalog();
    catalog.results[0].source.raw = undefined;
    catalog.results[0].evidence = undefined;

    const payload = buildStaticCatalogPayload(catalog);
    expect(payload.index.results[0].hasSourceRaw).toBe(false);
  });

  test("derives generatedAt from the latest result date/evidence.retrievedAt instead of wall-clock time", () => {
    const catalog = fixtureCatalog();
    catalog.results[0].date = "2026-03-15";
    catalog.results[0].evidence = { retrievedAt: "2026-03-20T10:00:00Z" };

    const payload = buildStaticCatalogPayload(catalog);
    expect(payload.index.generatedAt).toBe("2026-03-20T10:00:00.000Z");

    // Re-running against the same input produces byte-identical output.
    expect(buildStaticCatalogPayload(catalog).index.generatedAt).toBe(payload.index.generatedAt);
  });
});
