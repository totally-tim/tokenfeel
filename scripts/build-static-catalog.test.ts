import { describe, expect, test } from "vitest";
import { staticCatalogSchema, type ParsedCatalog } from "../src/data/schemas";
import { rankedResults } from "../src/lib/catalog";
import { buildTimeline, summarizeTimeline } from "../src/sim/timing";
import type { BenchmarkResult, ScenarioScript, Timeline } from "../src/types";
import { buildStaticCatalogPayload } from "./build-static-catalog";
import { readPrunedCatalogFromDisk } from "./validate-data";

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
          {
            depth: 0,
            pp: 1000,
            tg: 80,
            source: {
              url: "https://example.com/rows/0",
              upstreamId: "row-0",
              createdAt: "2026-01-01T00:00:00Z",
              ttftMs: 5000,
              peakMemoryGb: 12.5
            }
          },
          {
            depth: 8192,
            pp: 700,
            tg: 55,
            source: {
              url: "https://example.com/rows/8192",
              upstreamId: "row-8192",
              createdAt: "2026-01-01T00:00:00Z",
              ttftMs: 40000,
              peakMemoryGb: 14
            }
          }
        ],
        evidence: {
          rawUrl: "https://example.com/raw.txt",
          rawRows: ["very large raw row that belongs in detail chunks only"]
        },
        benchmark: {
          command: "./llama-bench -m test.gguf",
          ppTokens: 512,
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

  test("keeps measured TTFT on compact rows so timelines match the full row", () => {
    const catalog = fixtureCatalog();
    const payload = buildStaticCatalogPayload(catalog);
    const summary = payload.index.results[0];
    const full = catalog.results[0];
    const scenario = catalog.scenarios[0];

    expect(staticCatalogSchema.safeParse(payload.index).success).toBe(true);
    expect(summary.measurements.map((measurement) => measurement.source)).toEqual([
      { url: "https://example.com/rows/0", upstreamId: "row-0", ttftMs: 5000 },
      { url: "https://example.com/rows/8192", upstreamId: "row-8192", ttftMs: 40000 }
    ]);

    const timelineFor = (result: BenchmarkResult) => buildTimeline({ result, scenario, cacheMode: "runtime" });
    const compactTimeline = timelineFor(summary);
    const fullTimeline = timelineFor(full);
    expect(summarizeTimeline(compactTimeline)).toEqual(summarizeTimeline(fullTimeline));
    expect(compactTimeline.events.map((event) => event.ttftMs)).toEqual(
      fullTimeline.events.map((event) => event.ttftMs)
    );

    // With ppTokens 512 the 1,012-token cold prompt sits between the TTFT
    // readings at 512 and 8,704 total tokens, so the measured anchor (about
    // 7.1s) is far from the pp integral plus the 80ms default overhead
    // (about 1.1s) that a row without source.ttftMs falls back to.
    const withoutTtft = timelineFor({
      ...summary,
      measurements: summary.measurements.map(({ source: _source, ...measurement }) => measurement)
    });
    expect(compactTimeline.events[0].ttftMs).toBeGreaterThan(7000);
    expect(withoutTtft.events[0].ttftMs).toBeLessThan(1200);
  });
});

describe("static catalog timing parity with the full catalog", () => {
  test("every real result ranks and plays back with the same canonical timing from compact rows", () => {
    const catalog = readPrunedCatalogFromDisk();
    const { index } = buildStaticCatalogPayload(catalog);
    const fullById = new Map(catalog.results.map((result) => [result.id, result]));
    const timelineFor = (result: BenchmarkResult, scenario: ScenarioScript) =>
      buildTimeline({ result, scenario, cacheMode: "runtime" });
    const canonicalTiming = (timeline: Timeline) =>
      JSON.stringify(timeline.events.map((event) => [event.ttftMs, event.prefillMs, event.decodeMs, event.endMs]));

    const mismatches: string[] = [];
    for (const scenario of catalog.scenarios) {
      for (const row of rankedResults(index, scenario)) {
        const fullTimeline = timelineFor(fullById.get(row.result.id)!, scenario);
        const fullSeconds = summarizeTimeline(fullTimeline).wallTimeMs / 1000;
        if (
          row.seconds !== fullSeconds ||
          canonicalTiming(timelineFor(row.result, scenario)) !== canonicalTiming(fullTimeline)
        ) {
          mismatches.push(`${row.result.id} / ${scenario.id}: ranked ${row.seconds}s, full ${fullSeconds}s`);
        }
      }
    }

    expect(mismatches).toEqual([]);
  });
});
