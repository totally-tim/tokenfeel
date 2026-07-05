import { describe, expect, it } from "vitest";
import { catalog, results, scenarios, validateCatalog } from "./index";
import { catalogSchema } from "./schemas";
import { analyzeCatalogQuality } from "../../scripts/validate-data";

describe("seed data", () => {
  it("contains source-grounded benchmark results with usable pp/tg measurements", () => {
    const parsed = validateCatalog(catalog);

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
    expect(ids.has("rtx-4090__qwen3.6-35b-a3b__q4_k_xl__llamacpp-cuda")).toBe(true);
    expect(ids.has("m4-max__gpt-oss-120b__mxfp4__llamacpp-metal")).toBe(true);
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

  it("reports suspicious pp and tg increases as quality warnings", () => {
    const parsed = catalogSchema.parse(
      validCatalogWithResult({
        measurements: [
          { depth: 0, pp: 100, tg: 50 },
          { depth: 4096, pp: 112, tg: 58 }
        ]
      })
    );

    expect(analyzeCatalogQuality(parsed).warnings).toEqual([
      'test-hardware__test-model__q4_k_m__llamacpp-cuda pp increases 12.0% from depth 0 to 4096',
      'test-hardware__test-model__q4_k_m__llamacpp-cuda tg increases 16.0% from depth 0 to 4096'
    ]);
  });
});
