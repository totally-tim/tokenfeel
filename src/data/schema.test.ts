import { describe, expect, it } from "vitest";
import { catalogSchema, scenarioEventSchema, staticCatalogSchema } from "./schemas";
import { analyzeCatalogQuality, readPrunedCatalogFromDisk } from "../../scripts/validate-data";

const catalog = readPrunedCatalogFromDisk();
const { results, scenarios } = catalog;

describe("seed data", () => {
  it("contains source-grounded benchmark results with usable pp/tg measurements", () => {
    const parsed = catalog;

    expect(parsed.results.length).toBeGreaterThanOrEqual(19);
    expect(parsed.hardware.length).toBeGreaterThanOrEqual(4);
    expect(parsed.models.length).toBeGreaterThanOrEqual(3);
    expect(parsed.scenarios.length).toBeGreaterThanOrEqual(3);

    for (const result of parsed.results) {
      expect(result.measurements.length).toBeGreaterThanOrEqual(1);
      expect(result.source.url).toMatch(/^https:\/\//);
      expect(result.source.title.length).toBeGreaterThan(4);
      expect(result.measurements.every((m) => m.pp > 0 && m.tg > 0)).toBe(true);
    }
  });

  it("includes multi-node and custom GPU seed rows from repository data files", () => {
    const ids = new Set(catalog.results.map((result) => result.id));

    expect(ids.has("dgx-spark-dual-qsfp__gpt-oss-120b__mxfp4__vllm")).toBe(true);
    expect(ids.has("dgx-spark-dual-qsfp__deepseek-v4-flash__fp4-fp8-mixed__vllm-dspark")).toBe(true);
    expect(ids.has("dgx-spark-dual-qsfp__deepseek-v4-flash__fp8__vllm-mtp")).toBe(true);
    expect(ids.has("dgx-spark-quad-qsfp__gpt-oss-120b__mxfp4__vllm")).toBe(true);
    expect(ids.has("rtx-4090-24gb__qwen3.6-35b-a3b__q4_k_xl__llamacpp-cuda")).toBe(true);
    expect(ids.has("m4-max-128gb__gpt-oss-120b__mxfp4__llamacpp-metal")).toBe(true);
  });

  it("only exposes scenario/result combinations that can produce timelines", () => {
    expect(results.length).toBeGreaterThan(0);
    expect(scenarios.length).toBeGreaterThan(0);

    const pairKeys = new Set(results.map((result) => `${result.hardware}:${result.model}:${result.quant}`));

    expect(pairKeys.has("dgx-spark:test-qwen3-coder-30b-a3b:q8_0")).toBe(true);
    expect(scenarios.some((scenario) => scenario.id === "agent-bugfix")).toBe(true);
  });
});

function validCatalogWithResult(overrides: Record<string, unknown> = {}) {
  return {
    hardware: [
      {
        id: "test-hardware",
        name: "Test Hardware",
        shortName: "Test HW",
        vendor: "Tokenfeel",
        memory: "128 GB",
        accelerator: "Test accelerator",
        notes: "Synthetic schema test hardware."
      }
    ],
    models: [
      {
        id: "test-model",
        name: "Test Model",
        family: "Test",
        params: "1B",
        license: "Test",
        notes: "Synthetic schema test model."
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
          flags: "",
          cache: "prefix"
        },
        measurements: [
          {
            depth: 0,
            pp: 100,
            tg: 50,
            source: {
              url: "https://example.com/benchmark/depth-0",
              upstreamId: "upstream-row-0",
              createdAt: "2026-01-02T03:04:05Z",
              ttftMs: 123.4,
              peakMemoryGb: 12.5
            }
          },
          { depth: 4096, pp: 90, tg: 45 }
        ],
        source: {
          kind: "llama-bench",
          title: "Synthetic schema benchmark",
          url: "https://example.com/benchmark"
        },
        submitter: "Tokenfeel",
        date: "2026-01-01",
        status: "community",
        ...overrides
      }
    ],
    scenarios: [
      {
        id: "test-scenario",
        title: "Test scenario",
        type: "chatbot",
        systemPromptTokens: 0,
        events: [{ id: "u1", role: "user", text: "hello", tokens: 1 }]
      }
    ]
  };
}

describe("catalog schema hardening", () => {
  it("accepts optional benchmark provenance, metadata, and topology fields", () => {
    const parsed = catalogSchema.parse(
      validCatalogWithResult({
        evidence: {
          rawUrl: "https://example.com/raw.json",
          rawFormat: "llama-bench-jsonl",
          checksum: "sha256:abc123",
          retrievedAt: "2026-01-02T03:04:05Z",
          upstreamId: "upstream-row-1",
          parserVersion: "tokenfeel-llama-bench/1",
          rawRows: ["| pp2048 | 100 |"],
          upstreamUrls: ["https://example.com/benchmark/depth-0"],
          archiveUrl: "https://web.archive.org/web/20260102030405/https://example.com/raw.json"
        },
        benchmark: {
          metadata: { host: "lab-a" },
          tool: "llama-bench",
          command: "./llama-bench -m model.gguf",
          profile: "pp2048/tg128",
          runs: 3,
          warmup: 1,
          outputFormat: "markdown-table",
          tokenizer: "gguf",
          ppTokens: 2048,
          tgTokens: 128,
          concurrency: 1,
          latencyMode: "steady-state"
        },
        topology: {
          nodeCount: 2,
          acceleratorCount: 4,
          interconnect: "QSFP",
          distributedRuntime: "vLLM",
          tensorParallel: 4,
          containerImage: "nvcr.io/example/tokenfeel:latest",
          os: "Ubuntu 24.04",
          kernel: "6.8.0",
          driver: "570.0",
          cuda: "12.8",
          runtimeVersions: { nccl: "2.26.2" }
        }
      })
    );

    expect(parsed.results[0].evidence?.parserVersion).toBe("tokenfeel-llama-bench/1");
    expect(parsed.results[0].benchmark?.ppTokens).toBe(2048);
    expect(parsed.results[0].topology?.nodeCount).toBe(2);
  });

  it("accepts optional ppStddev/tgStddev, and validates fine when they're absent", () => {
    const withStddev = catalogSchema.parse(
      validCatalogWithResult({
        measurements: [
          { depth: 0, pp: 100, tg: 50, ppStddev: 1.2, tgStddev: 0.8 },
          { depth: 4096, pp: 90, tg: 45 }
        ]
      })
    );

    expect(withStddev.results[0].measurements[0].ppStddev).toBeCloseTo(1.2);
    expect(withStddev.results[0].measurements[0].tgStddev).toBeCloseTo(0.8);
    expect(withStddev.results[0].measurements[1].ppStddev).toBeUndefined();
    expect(withStddev.results[0].measurements[1].tgStddev).toBeUndefined();
  });

  it("rejects a negative ppStddev/tgStddev", () => {
    expect(() =>
      catalogSchema.parse(
        validCatalogWithResult({
          measurements: [
            { depth: 0, pp: 100, tg: 50, ppStddev: -1 },
            { depth: 4096, pp: 90, tg: 45 }
          ]
        })
      )
    ).toThrow();
  });

  it("rejects duplicate measurement depths", () => {
    expect(() =>
      catalogSchema.parse(
        validCatalogWithResult({
          measurements: [
            { depth: 0, pp: 100, tg: 50 },
            { depth: 0, pp: 90, tg: 45 }
          ]
        })
      )
    ).toThrow(/Duplicate measurement depth/);
  });

  it("rejects future-dated results", () => {
    expect(() =>
      catalogSchema.parse(
        validCatalogWithResult({
          date: "2999-01-01"
        })
      )
    ).toThrow(/future date/);
  });

  it("rejects result ids that do not follow the four-part benchmark shape", () => {
    expect(() =>
      catalogSchema.parse(
        validCatalogWithResult({
          id: "test-hardware__test-model__wrong-quant"
        })
      )
    ).toThrow(/hardware__model__quant__runtime-ish/);
  });

  it("reports pp/tg increases beyond 10% as hard quality issues", () => {
    const parsed = catalogSchema.parse(
      validCatalogWithResult({
        measurements: [
          { depth: 0, pp: 100, tg: 50 },
          { depth: 4096, pp: 112, tg: 58 }
        ]
      })
    );

    const quality = analyzeCatalogQuality(parsed);
    expect(quality.issues).toEqual([
      'test-hardware__test-model__q4_k_m__llamacpp-cuda pp increases 12.0% from depth 0 to 4096',
      'test-hardware__test-model__q4_k_m__llamacpp-cuda tg increases 16.0% from depth 0 to 4096'
    ]);
    expect(quality.warnings).toEqual([]);
  });

  it("reports pp/tg increases of 10% or less as soft quality warnings, not issues", () => {
    const parsed = catalogSchema.parse(
      validCatalogWithResult({
        measurements: [
          { depth: 0, pp: 100, tg: 50 },
          { depth: 4096, pp: 108, tg: 50 }
        ]
      })
    );

    const quality = analyzeCatalogQuality(parsed);
    expect(quality.warnings).toEqual([
      'test-hardware__test-model__q4_k_m__llamacpp-cuda pp increases 8.0% from depth 0 to 4096'
    ]);
    expect(quality.issues).toEqual([]);
  });

  it("does not flag pp/tg decreases or flat runs", () => {
    const parsed = catalogSchema.parse(
      validCatalogWithResult({
        measurements: [
          { depth: 0, pp: 100, tg: 50 },
          { depth: 4096, pp: 90, tg: 50 }
        ]
      })
    );

    const quality = analyzeCatalogQuality(parsed);
    expect(quality.warnings).toEqual([]);
    expect(quality.issues).toEqual([]);
  });

  it("exempts allowlisted result ids from hard issues, demoting them to explained warnings", () => {
    const parsed = catalogSchema.parse(
      validCatalogWithResult({
        measurements: [
          { depth: 0, pp: 100, tg: 50 },
          { depth: 4096, pp: 112, tg: 58 }
        ]
      })
    );

    const quality = analyzeCatalogQuality(parsed, [
      { id: "test-hardware__test-model__q4_k_m__llamacpp-cuda", reason: "known cold-start warm-up artifact" }
    ]);
    expect(quality.issues).toEqual([]);
    expect(quality.warnings).toHaveLength(2);
    expect(quality.warnings[0]).toContain("known cold-start warm-up artifact");
  });
});

function validStaticCatalog(resultOverrides: Record<string, unknown> = {}) {
  const base = validCatalogWithResult(resultOverrides);
  return {
    version: 1 as const,
    generatedAt: "2026-01-01T00:00:00Z",
    resultCount: base.results.length,
    hardware: base.hardware,
    models: base.models,
    scenarios: base.scenarios,
    results: base.results.map((result) => ({ ...result, detailChunk: "chunk-000.json" }))
  };
}

describe("staticCatalogSchema (runtime catalog re-validation, A2)", () => {
  it("accepts a well-formed static catalog payload", () => {
    const parsed = staticCatalogSchema.parse(validStaticCatalog());
    expect(parsed.results[0].detailChunk).toBe("chunk-000.json");
  });

  it("accepts a verified result whose only evidence is source.raw stripped away (the compacted-index shape), unlike full catalogSchema", () => {
    // build-static-catalog.ts's compactResult intentionally drops source.raw
    // from the index summary (kept only in the per-result detail chunk).
    // staticCatalogSchema must not resurrect the "verified needs raw
    // evidence" rule against data that structurally cannot carry it.
    const payload = validStaticCatalog({ status: "verified" });

    expect(() => staticCatalogSchema.parse(payload)).not.toThrow();
    expect(() => catalogSchema.parse(validCatalogWithResult({ status: "verified" }))).toThrow(
      /no raw evidence/
    );
  });

  it("rejects a payload missing the detailChunk pointer", () => {
    const payload = validStaticCatalog();
    // @ts-expect-error -- intentionally malformed for the test
    delete payload.results[0].detailChunk;

    expect(() => staticCatalogSchema.parse(payload)).toThrow();
  });

  it("rejects duplicate result ids, just like catalogSchema does", () => {
    const payload = validStaticCatalog();
    payload.results.push({ ...payload.results[0] });

    expect(() => staticCatalogSchema.parse(payload)).toThrow(/Duplicate id/);
  });

  it("rejects a result referencing unknown hardware, just like catalogSchema does", () => {
    const payload = validStaticCatalog();
    payload.results[0].hardware = "ghost-hardware";

    expect(() => staticCatalogSchema.parse(payload)).toThrow(/Unknown hardware/);
  });

  it("rejects a non-1 version tag (e.g. a stale/incompatible catalog build)", () => {
    const payload = validStaticCatalog();
    // @ts-expect-error -- intentionally malformed for the test
    payload.version = 2;

    expect(() => staticCatalogSchema.parse(payload)).toThrow();
  });
});

describe("scenarioEventSchema cache_bust marker role (T1)", () => {
  it("rejects a standalone cache_bust-role event with nonzero tokens", () => {
    expect(() =>
      scenarioEventSchema.parse({ id: "marker1", role: "cache_bust", text: "invalidate", tokens: 500 })
    ).toThrow(/cache_bust.*nonzero tokens/);
  });

  it("accepts a standalone cache_bust-role event with zero tokens as a valid marker", () => {
    const parsed = scenarioEventSchema.parse({ id: "marker1", role: "cache_bust", text: "invalidate", tokens: 0 });
    expect(parsed.role).toBe("cache_bust");
    expect(parsed.tokens).toBe(0);
  });

  it("rejects a standalone cache_bust-role event with nonzero toolLatencyMs", () => {
    expect(() =>
      scenarioEventSchema.parse({
        id: "marker1",
        role: "cache_bust",
        text: "invalidate",
        tokens: 0,
        toolLatencyMs: 500
      })
    ).toThrow(/cache_bust.*nonzero toolLatencyMs/);
  });

  it("rejects a standalone cache_bust-role event with a cacheBust property", () => {
    expect(() =>
      scenarioEventSchema.parse({
        id: "marker1",
        role: "cache_bust",
        text: "invalidate",
        tokens: 0,
        cacheBust: { retainedPrefixTokens: 100 }
      })
    ).toThrow(/cache_bust.*cacheBust property/);
  });
});

describe("scenarioEventSchema content-density floor (thinking-token streaming realism)", () => {
  it("rejects a generated-role event whose text is far too sparse for its declared token count", () => {
    expect(() =>
      scenarioEventSchema.parse({
        id: "sparse-thinking",
        role: "thinking",
        text: "Too short for the claimed token count.",
        tokens: 5200
      })
    ).toThrow(/content-density floor/);
  });

  it("accepts a generated-role event whose text clears the density floor", () => {
    const parsed = scenarioEventSchema.parse({
      id: "dense-thinking",
      role: "thinking",
      text: "x".repeat(5200),
      tokens: 5200
    });
    expect(parsed.tokens).toBe(5200);
  });

  it("does not apply the density floor to non-generated roles", () => {
    expect(() =>
      scenarioEventSchema.parse({ id: "short-user-turn", role: "user", text: "Yes.", tokens: 5200 })
    ).not.toThrow();
    expect(() =>
      scenarioEventSchema.parse({ id: "short-tool-result", role: "tool_result", text: "OK", tokens: 5200 })
    ).not.toThrow();
  });

  it("never trips on a legitimately short generated reply", () => {
    expect(() =>
      scenarioEventSchema.parse({ id: "short-reply", role: "assistant", text: "Yes.", tokens: 3 })
    ).not.toThrow();
  });
});
