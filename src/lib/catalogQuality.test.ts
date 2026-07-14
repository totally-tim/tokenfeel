import { describe, expect, test } from "vitest";
import type { BenchmarkResult, Catalog } from "../types";
import { baselineMeasurement, catalogQualityIssues, pruneCatalogForSimulation } from "./catalogQuality";

const baseResult = {
  id: "m4__qwen3.5-9b__4bit__omlx-api",
  hardware: "m4",
  model: "qwen3.5-9b",
  quant: "4bit",
  runtime: { name: "oMLX", version: "0.3", backend: "MLX", flags: "api", cache: "prefix" },
  measurements: [
    { depth: 1024, pp: 1000, tg: 50, source: { url: "https://example.com/1", upstreamId: "1", ttftMs: 1024 } },
    { depth: 8192, pp: 900, tg: 45, source: { url: "https://example.com/2", upstreamId: "2", ttftMs: 9102 } }
  ],
  source: { kind: "community-benchmark", title: "Synthetic benchmark", url: "https://example.com/source" },
  submitter: "tests",
  date: "2026-01-01",
  status: "community"
} satisfies BenchmarkResult;

function result(overrides: Partial<BenchmarkResult>): BenchmarkResult {
  return { ...baseResult, ...overrides };
}

function catalog(results: BenchmarkResult[]): Catalog {
  return {
    hardware: [
      {
        id: "m4",
        name: "M4",
        shortName: "M4",
        vendor: "Apple",
        memory: "64GB",
        accelerator: "GPU",
        notes: "Synthetic hardware"
      },
      {
        id: "orphan-hardware",
        name: "Orphan",
        shortName: "Orphan",
        vendor: "Apple",
        memory: "8GB",
        accelerator: "GPU",
        notes: "Unreferenced"
      }
    ],
    models: [
      { id: "qwen3.5-9b", name: "Qwen3.5 9B", family: "Qwen", params: "9B", license: "test", notes: "Synthetic model" },
      {
        id: "0123456789abcdef0123456789abcdef01234567",
        name: "0123456789abcdef0123456789abcdef01234567",
        family: "Unknown",
        params: "unknown",
        license: "test",
        notes: "Hash model"
      },
      { id: "orphan-model", name: "Orphan", family: "Other", params: "1B", license: "test", notes: "Unreferenced" }
    ],
    results,
    scenarios: [
      {
        id: "s1",
        title: "Scenario",
        type: "chatbot",
        systemPromptTokens: 100,
        events: [{ id: "u1", role: "user", text: "Hello", tokens: 10 }]
      }
    ]
  };
}

describe("catalog quality", () => {
  test("flags result rows that are not useful for the public simulation catalog", () => {
    expect(catalogQualityIssues(result({ quant: "unknown" }))).toContain("unknown-quant");
    expect(catalogQualityIssues(result({ model: "0123456789abcdef0123456789abcdef01234567" }))).toContain(
      "hash-model-id"
    );
    expect(catalogQualityIssues(result({ measurements: [{ depth: 4096, pp: 1000, tg: 50 }] }))).toContain(
      "low-context-under-8k"
    );
    expect(
      catalogQualityIssues(
        result({
          measurements: [
            {
              depth: 4096,
              pp: 1000,
              tg: 50,
              source: { url: "https://example.com/bad", upstreamId: "bad", ttftMs: 100_000 }
            }
          ]
        })
      )
    ).toContain("ttft-pp-mismatch");
  });

  test("flags model ids carrying a test-/tbd-/demo- seed prefix, not just the exact-match placeholder set (C4)", () => {
    expect(catalogQualityIssues(result({ model: "test-qwen3-coder-30b-a3b" }))).toContain("placeholder-model-id");
    expect(catalogQualityIssues(result({ model: "tbd-some-model" }))).toContain("placeholder-model-id");
    expect(catalogQualityIssues(result({ model: "demo-model" }))).toContain("placeholder-model-id");
    expect(catalogQualityIssues(result({ model: "qwen3.5-9b" }))).not.toContain("placeholder-model-id");
  });

  test("still checks TTFT against ppTokens-derived duration at depth 0 instead of skipping entirely (C5)", () => {
    const outlierAtZeroDepth = catalogQualityIssues(
      result({
        benchmark: { ppTokens: 2048 },
        measurements: [
          {
            depth: 0,
            pp: 2000,
            tg: 50,
            // Expected TTFT for 2048 tokens at pp=2000 is ~1024ms; 100,000ms
            // is a wild outlier that must still be caught at depth 0.
            source: { url: "https://example.com/zero-depth", upstreamId: "zero-depth", ttftMs: 100_000 }
          }
        ]
      })
    );
    expect(outlierAtZeroDepth).toContain("ttft-pp-mismatch");

    const plausibleAtZeroDepth = catalogQualityIssues(
      result({
        benchmark: { ppTokens: 2048 },
        measurements: [
          {
            depth: 0,
            pp: 2000,
            tg: 50,
            source: { url: "https://example.com/zero-depth-ok", upstreamId: "zero-depth-ok", ttftMs: 1024 }
          }
        ]
      })
    );
    expect(plausibleAtZeroDepth).not.toContain("ttft-pp-mismatch");

    // No depth and no ppTokens signal at all -- nothing to check against.
    const noSignal = catalogQualityIssues(
      result({
        measurements: [
          {
            depth: 0,
            pp: 2000,
            tg: 50,
            source: { url: "https://example.com/no-signal", upstreamId: "no-signal", ttftMs: 100_000 }
          }
        ]
      })
    );
    expect(noSignal).not.toContain("ttft-pp-mismatch");
  });

  test("accepts llama-benchy TTFT that includes the current prompt chunk", () => {
    const issues = catalogQualityIssues(
      result({
        benchmark: { ppTokens: 2048 },
        measurements: [
          {
            depth: 2048,
            pp: 2114,
            tg: 34.8,
            source: { url: "https://example.com/d2048", upstreamId: "d2048", ttftMs: 2079 }
          }
        ]
      })
    );

    expect(issues).not.toContain("ttft-pp-mismatch");
  });

  test("exempts a first-transition rate spike from severe-rate-spike when a longer curve confirms it's cold-start noise", () => {
    const coldStart = result({
      measurements: [
        { depth: 1024, pp: 1200, tg: 28.9 },
        { depth: 4096, pp: 1400, tg: 81.6 },
        { depth: 8192, pp: 1450, tg: 74.9 },
        { depth: 16384, pp: 1420, tg: 63.3 }
      ]
    });

    expect(catalogQualityIssues(coldStart)).not.toContain("severe-rate-spike");
  });

  test("still flags a first-transition spike as severe-rate-spike on a bare 2-point curve", () => {
    const bareSpike = result({
      measurements: [
        { depth: 1024, pp: 1200, tg: 28.9 },
        { depth: 4096, pp: 1400, tg: 81.6 }
      ]
    });

    expect(catalogQualityIssues(bareSpike)).toContain("severe-rate-spike");
  });

  test("still flags a severe spike past the first transition", () => {
    const lateSpike = result({
      measurements: [
        { depth: 1024, pp: 1200, tg: 30 },
        { depth: 4096, pp: 1210, tg: 31 },
        { depth: 8192, pp: 1220, tg: 70 }
      ]
    });

    expect(catalogQualityIssues(lateSpike)).toContain("severe-rate-spike");
  });

  test("prunes bad results and orphaned metadata from the app-facing simulation catalog", () => {
    const good = result({ id: "m4__qwen3.5-9b__4bit__omlx-api" });
    const bad = result({ id: "m4__qwen3.5-9b__unknown__omlx-api", quant: "unknown" });
    const pruned = pruneCatalogForSimulation(catalog([good, bad]));

    expect(pruned.results.map((item) => item.id)).toEqual([good.id]);
    expect(pruned.hardware.map((item) => item.id)).toEqual(["m4"]);
    expect(pruned.models.map((item) => item.id)).toEqual(["qwen3.5-9b"]);
  });
});

describe("baselineMeasurement", () => {
  test("returns the lowest-depth measurement when already sorted ascending", () => {
    expect(baselineMeasurement(result({}))?.depth).toBe(1024);
  });

  test("re-sorts defensively when measurements are not ascending by depth", () => {
    const unsorted = result({
      measurements: [
        { depth: 8192, pp: 900, tg: 45 },
        { depth: 1024, pp: 1000, tg: 50 },
        { depth: 4096, pp: 950, tg: 48 }
      ]
    });

    expect(baselineMeasurement(unsorted)?.depth).toBe(1024);
  });

  test("returns undefined instead of throwing when there are no measurements", () => {
    expect(baselineMeasurement(result({ measurements: [] }))).toBeUndefined();
  });

  test("does not mutate the original measurements array", () => {
    const original = [
      { depth: 8192, pp: 900, tg: 45 },
      { depth: 1024, pp: 1000, tg: 50 }
    ];
    const unsorted = result({ measurements: [...original] });

    baselineMeasurement(unsorted);

    expect(unsorted.measurements.map((measurement) => measurement.depth)).toEqual([8192, 1024]);
  });
});
