import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { BenchmarkResult, Catalog } from "../src/types";
import { planCatalogPrune, pruneCatalogFiles } from "./prune-catalog";

const baseResult = {
  id: "kept-hardware__kept-model__4bit__omlx-api",
  hardware: "kept-hardware",
  model: "kept-model",
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

const tempRoots: string[] = [];

function result(overrides: Partial<BenchmarkResult>): BenchmarkResult {
  return { ...baseResult, ...overrides };
}

function fixtureCatalog(): Catalog {
  const kept = result({});
  const bad = result({
    id: "kept-hardware__bad-model__unknown__omlx-api",
    model: "bad-model",
    quant: "unknown"
  });

  return {
    hardware: [
      {
        id: "kept-hardware",
        name: "Kept Hardware",
        shortName: "Kept",
        vendor: "Tokenfeel",
        memory: "64GB",
        accelerator: "GPU",
        notes: "Synthetic hardware"
      },
      {
        id: "orphan-hardware",
        name: "Orphan Hardware",
        shortName: "Orphan",
        vendor: "Tokenfeel",
        memory: "16GB",
        accelerator: "GPU",
        notes: "No retained result references this hardware"
      }
    ],
    models: [
      { id: "kept-model", name: "Kept Model", family: "Qwen", params: "9B", license: "test", notes: "Retained" },
      {
        id: "bad-model",
        name: "Bad Model",
        family: "Qwen",
        params: "9B",
        license: "test",
        notes: "Unknown quant result"
      },
      {
        id: "orphan-model",
        name: "Orphan Model",
        family: "Qwen",
        params: "4B",
        license: "test",
        notes: "No retained result"
      }
    ],
    results: [kept, bad],
    scenarios: [
      {
        id: "scenario",
        title: "Scenario",
        type: "agent",
        systemPromptTokens: 10,
        events: [{ id: "u1", role: "user", text: "hi", tokens: 1 }]
      }
    ]
  };
}

async function makeCatalogDirs(catalog: Catalog) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tokenfeel-prune-"));
  tempRoots.push(root);
  const dirs = {
    hardware: path.join(root, "hardware"),
    models: path.join(root, "models"),
    results: path.join(root, "results")
  };
  await Promise.all(Object.values(dirs).map((dir) => fs.mkdir(dir, { recursive: true })));

  for (const hardware of catalog.hardware) {
    await fs.writeFile(path.join(dirs.hardware, `${hardware.id}.json`), `${JSON.stringify(hardware)}\n`);
  }
  for (const model of catalog.models) {
    await fs.writeFile(path.join(dirs.models, `${model.id}.json`), `${JSON.stringify(model)}\n`);
  }
  for (const item of catalog.results) {
    await fs.writeFile(path.join(dirs.results, `${item.id}.json`), `${JSON.stringify(item)}\n`);
  }

  return dirs;
}

async function jsonIds(dir: string): Promise<string[]> {
  const names = await fs.readdir(dir);
  return names.map((name) => name.replace(/\.json$/, "")).sort();
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("catalog pruning", () => {
  test("plans unused source records from the same quality gate as the public simulation catalog", () => {
    const plan = planCatalogPrune(fixtureCatalog());

    expect(plan.keep.results).toEqual(["kept-hardware__kept-model__4bit__omlx-api"]);
    expect(plan.remove.results).toEqual(["kept-hardware__bad-model__unknown__omlx-api"]);
    expect(plan.keep.hardware).toEqual(["kept-hardware"]);
    expect(plan.remove.hardware).toEqual(["orphan-hardware"]);
    expect(plan.keep.models).toEqual(["kept-model"]);
    expect(plan.remove.models).toEqual(["bad-model", "orphan-model"]);
  });

  test("deletes only unused hardware, model, and result files", async () => {
    const catalog = fixtureCatalog();
    const dirs = await makeCatalogDirs(catalog);
    const plan = planCatalogPrune(catalog);

    const dryRun = await pruneCatalogFiles(plan, dirs, { dryRun: true });
    expect(dryRun.deletedFiles.map((file) => path.basename(file)).sort()).toEqual([
      "bad-model.json",
      "kept-hardware__bad-model__unknown__omlx-api.json",
      "orphan-hardware.json",
      "orphan-model.json"
    ]);
    // Dry-run reports what it would delete but must not actually delete it.
    expect(await jsonIds(dirs.results)).toEqual([
      "kept-hardware__bad-model__unknown__omlx-api",
      "kept-hardware__kept-model__4bit__omlx-api"
    ]);

    const applied = await pruneCatalogFiles(plan, dirs);
    expect(applied.deletedFiles.map((file) => path.basename(file)).sort()).toEqual([
      "bad-model.json",
      "kept-hardware__bad-model__unknown__omlx-api.json",
      "orphan-hardware.json",
      "orphan-model.json"
    ]);
    expect(await jsonIds(dirs.hardware)).toEqual(["kept-hardware"]);
    expect(await jsonIds(dirs.models)).toEqual(["kept-model"]);
    expect(await jsonIds(dirs.results)).toEqual(["kept-hardware__kept-model__4bit__omlx-api"]);
  });
});
