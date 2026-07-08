import { describe, expect, test } from "vitest";
import type { BenchmarkResult, Catalog, ScenarioScript } from "../types";
import { readPrunedCatalogFromDisk } from "../../scripts/validate-data";
import {
  DEFAULT_LEFT_CONFIG,
  DEFAULT_RIGHT_CONFIG,
  compactResultLabel,
  computeScenarioSeconds,
  createCatalogLookups,
  defaultLeftResultId,
  defaultRightResultId,
  defaultScenario,
  getResult,
  getScenario,
  rankedResults,
  resultMeta,
  scenarioOptions
} from "./catalog";

const realCatalog = readPrunedCatalogFromDisk();

const fastResult: BenchmarkResult = {
  id: "hw-fast__model-a__4bit__runtime-fast",
  hardware: "hw-fast",
  model: "model-a",
  quant: "4bit",
  runtime: { name: "llama.cpp", version: "b1", backend: "CUDA", flags: "-fa 1", cache: "prefix" },
  measurements: [
    { depth: 0, pp: 4000, tg: 100 },
    { depth: 8192, pp: 3000, tg: 80 }
  ],
  source: { kind: "raw-json", title: "Synthetic fast fixture", url: "https://example.com/fast" },
  submitter: "tests",
  date: "2026-01-01",
  status: "community"
};

const slowResult: BenchmarkResult = {
  id: "hw-slow__model-b__8bit__runtime-slow",
  hardware: "hw-slow",
  model: "model-b",
  quant: "8bit",
  runtime: { name: "oMLX", version: "0.3", backend: "MLX", flags: "api", cache: "none" },
  measurements: [{ depth: 0, pp: 500, tg: 10 }],
  source: { kind: "raw-json", title: "Synthetic slow fixture", url: "https://example.com/slow" },
  submitter: "tests",
  date: "2026-01-01",
  status: "community"
};

const chatbotScenario: ScenarioScript = {
  id: "fixture-chatbot",
  title: "Fixture chatbot",
  type: "chatbot",
  systemPromptTokens: 500,
  events: [
    { id: "u1", role: "user", text: "Hello", tokens: 20 },
    { id: "a1", role: "assistant", text: "Hi there", tokens: 30 }
  ]
};

const agentScenario: ScenarioScript = {
  id: "fixture-agent",
  title: "Fixture agent",
  type: "agent",
  systemPromptTokens: 4000,
  events: [
    { id: "u1", role: "user", text: "Fix it", tokens: 50 },
    { id: "tool1", role: "tool_call", text: "read_file()", tokens: 20 },
    { id: "result1", role: "tool_result", text: "contents", tokens: 100, toolLatencyMs: 250 }
  ]
};

const reasoningScenario: ScenarioScript = {
  id: "fixture-reasoning",
  title: "Fixture reasoning",
  type: "reasoning",
  systemPromptTokens: 200,
  events: [{ id: "u1", role: "user", text: "Think", tokens: 300 }]
};

function testCatalog(results: BenchmarkResult[] = [fastResult, slowResult]): Catalog {
  return {
    hardware: [
      { id: "hw-fast", name: "Fast Hardware", shortName: "Fast HW", vendor: "Vendor", memory: "64GB", accelerator: "GPU", notes: "n" },
      { id: "hw-slow", name: "Slow Hardware", shortName: "Slow HW", vendor: "Vendor", memory: "16GB", accelerator: "GPU", notes: "n" }
    ],
    models: [
      { id: "model-a", name: "Model A", family: "Family", params: "7B", license: "test", notes: "n" },
      { id: "model-b", name: "Model B", family: "Family", params: "3B", license: "test", notes: "n" }
    ],
    results,
    scenarios: [chatbotScenario, agentScenario, reasoningScenario]
  };
}

describe("createCatalogLookups", () => {
  test("resolves hardware, model, result, and scenario by id", () => {
    const lookups = createCatalogLookups(testCatalog());

    expect(lookups.hardwareById("hw-fast")?.name).toBe("Fast Hardware");
    expect(lookups.modelById("model-b")?.name).toBe("Model B");
    expect(lookups.resultById(fastResult.id)?.id).toBe(fastResult.id);
    expect(lookups.scenarioById("fixture-chatbot")?.title).toBe("Fixture chatbot");
  });

  test("returns undefined for unknown ids instead of throwing", () => {
    const lookups = createCatalogLookups(testCatalog());

    expect(lookups.hardwareById("nope")).toBeUndefined();
    expect(lookups.modelById("nope")).toBeUndefined();
    expect(lookups.resultById("nope")).toBeUndefined();
    expect(lookups.scenarioById("nope")).toBeUndefined();
  });
});

describe("getResult / getScenario", () => {
  test("returns the matching entity", () => {
    const catalog = testCatalog();

    expect(getResult(catalog, fastResult.id).id).toBe(fastResult.id);
    expect(getScenario(catalog, "fixture-agent").id).toBe("fixture-agent");
  });

  test("throws a clear error for unknown ids instead of returning undefined", () => {
    const catalog = testCatalog();

    expect(() => getResult(catalog, "unknown-result")).toThrow("Unknown result: unknown-result");
    expect(() => getScenario(catalog, "unknown-scenario")).toThrow("Unknown scenario: unknown-scenario");
  });
});

describe("compactResultLabel / resultMeta", () => {
  test("combines hardware short name and model name", () => {
    expect(compactResultLabel(testCatalog(), fastResult)).toBe("Fast HW · Model A");
  });

  test("falls back to raw ids when hardware/model are not in the catalog", () => {
    const orphanResult: BenchmarkResult = { ...fastResult, hardware: "ghost-hw", model: "ghost-model" };
    expect(compactResultLabel(testCatalog(), orphanResult)).toBe("ghost-hw · ghost-model");
  });

  test("summarizes memory, backend, and cache mode", () => {
    expect(resultMeta(testCatalog(), fastResult)).toBe("64GB · CUDA · prefix cache");
  });

  test("falls back to 'memory unknown' when hardware is missing", () => {
    const orphanResult: BenchmarkResult = { ...fastResult, hardware: "ghost-hw" };
    expect(resultMeta(testCatalog(), orphanResult)).toBe("memory unknown · CUDA · prefix cache");
  });
});

describe("defaultScenario", () => {
  test("resolves the repo-wide-refactor scenario by its fixed id", () => {
    const catalog = testCatalog();
    catalog.scenarios.push({ ...agentScenario, id: "repo-wide-refactor" });

    expect(defaultScenario(catalog).id).toBe("repo-wide-refactor");
  });

  test("throws when the pinned default scenario id is missing from the catalog", () => {
    expect(() => defaultScenario(testCatalog())).toThrow("Unknown scenario: repo-wide-refactor");
  });
});

describe("computeScenarioSeconds", () => {
  test("returns a positive, finite wall-clock time for a real scenario", () => {
    const seconds = computeScenarioSeconds(fastResult, agentScenario);

    expect(Number.isFinite(seconds)).toBe(true);
    expect(seconds).toBeGreaterThan(0);
  });

  test("a faster benchmark result completes the same scenario in less time", () => {
    const fastSeconds = computeScenarioSeconds(fastResult, agentScenario);
    const slowSeconds = computeScenarioSeconds(slowResult, agentScenario);

    expect(fastSeconds).toBeLessThan(slowSeconds);
  });
});

describe("rankedResults", () => {
  test("ranks results fastest-scenario-time first", () => {
    const ranked = rankedResults(testCatalog(), agentScenario);

    expect(ranked.map((row) => row.result.id)).toEqual([fastResult.id, slowResult.id]);
    expect(ranked[0].seconds).toBeLessThan(ranked[1].seconds);
  });

  test("attaches resolved hardware/model and a timeline summary per row", () => {
    const [row] = rankedResults(testCatalog(), agentScenario);

    expect(row.hardware?.id).toBe("hw-fast");
    expect(row.model?.id).toBe("model-a");
    expect(row.summary.wallTimeMs).toBeGreaterThan(0);
  });

  test("defaults to the catalog's default scenario when none is passed", () => {
    const catalog = testCatalog();
    catalog.scenarios.push({ ...agentScenario, id: "repo-wide-refactor" });

    expect(() => rankedResults(catalog)).not.toThrow();
  });
});

describe("scenarioOptions", () => {
  test("summarizes agent scenarios with system prompt size and tool event count", () => {
    const [, agentOption] = scenarioOptions(testCatalog());

    expect(agentOption.value).toBe("fixture-agent");
    expect(agentOption.sub).toContain("tool events");
  });

  test("summarizes chatbot scenarios with assistant turn count", () => {
    const [chatbotOption] = scenarioOptions(testCatalog());

    expect(chatbotOption.value).toBe("fixture-chatbot");
    expect(chatbotOption.sub).toContain("turns");
  });

  test("summarizes other scenario types (e.g. reasoning) with a token budget", () => {
    const [, , reasoningOption] = scenarioOptions(testCatalog());

    expect(reasoningOption.value).toBe("fixture-reasoning");
    expect(reasoningOption.sub).toMatch(/k tokens/);
  });
});

describe("pinned default configs (against the real repo catalog)", () => {
  test("DEFAULT_LEFT_CONFIG and DEFAULT_RIGHT_CONFIG resolve to distinct results", () => {
    const leftId = defaultLeftResultId(realCatalog);
    const rightId = defaultRightResultId(realCatalog);

    expect(leftId).toBeTruthy();
    expect(rightId).toBeTruthy();
    expect(leftId).not.toBe(rightId);
  });

  test("throws a clear error if a pinned default no longer matches any catalog result", () => {
    // Build a catalog that has everything defaultLeftResultId needs except a
    // result actually matching DEFAULT_LEFT_CONFIG's hardware/model/quant --
    // resolveConfigSelection would otherwise silently degrade to whatever
    // "first available" result exists instead of failing loudly.
    const staleCatalog = testCatalog([{ ...fastResult, hardware: "unrelated-hw", model: "unrelated-model", quant: "unrelated" }]);
    staleCatalog.hardware.push({
      id: "unrelated-hw",
      name: "Unrelated",
      shortName: "Unrelated",
      vendor: "Vendor",
      memory: "1GB",
      accelerator: "GPU",
      notes: "n"
    });
    staleCatalog.models.push({ id: "unrelated-model", name: "Unrelated", family: "F", params: "1B", license: "test", notes: "n" });

    expect(DEFAULT_LEFT_CONFIG.hardwareId).not.toBe("unrelated-hw");
    expect(() => defaultLeftResultId(staleCatalog)).toThrow(/no longer matches any catalog result/);
  });
});
