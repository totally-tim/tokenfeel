import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCatalogFromDisk } from "./validate-data";
import { pruneCatalogForSimulation } from "../src/lib/catalogQuality";
import type { Catalog } from "../src/types";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type CatalogBucket = "hardware" | "models" | "results";

export interface CatalogPrunePlan {
  keep: Record<CatalogBucket, string[]>;
  remove: Record<CatalogBucket, string[]>;
}

export interface CatalogDataDirs {
  hardware: string;
  models: string;
  results: string;
}

export interface PruneOptions {
  dryRun?: boolean;
}

export interface PruneReport {
  dryRun: boolean;
  deletedFiles: string[];
  retained: Record<CatalogBucket, number>;
  removed: Record<CatalogBucket, number>;
}

function sortedIds(ids: Iterable<string>): string[] {
  return [...ids].sort((a, b) => a.localeCompare(b));
}

function diffIds(sourceIds: Iterable<string>, keepIds: Set<string>): string[] {
  return sortedIds([...sourceIds].filter((id) => !keepIds.has(id)));
}

export function planCatalogPrune(catalog: Catalog): CatalogPrunePlan {
  const pruned = pruneCatalogForSimulation(catalog);
  const keep = {
    hardware: sortedIds(pruned.hardware.map((item) => item.id)),
    models: sortedIds(pruned.models.map((item) => item.id)),
    results: sortedIds(pruned.results.map((item) => item.id))
  };

  return {
    keep,
    remove: {
      hardware: diffIds(
        catalog.hardware.map((item) => item.id),
        new Set(keep.hardware)
      ),
      models: diffIds(
        catalog.models.map((item) => item.id),
        new Set(keep.models)
      ),
      results: diffIds(
        catalog.results.map((item) => item.id),
        new Set(keep.results)
      )
    }
  };
}

async function deleteUnusedFiles(dir: string, ids: Set<string>, dryRun: boolean): Promise<string[]> {
  const deletedFiles: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(dir, entry.name);
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as { id?: string };
    if (!parsed.id || !ids.has(parsed.id)) continue;

    deletedFiles.push(filePath);
    if (dryRun) continue;
    await fs.rm(filePath);
  }

  return deletedFiles;
}

export async function pruneCatalogFiles(
  plan: CatalogPrunePlan,
  dirs: CatalogDataDirs,
  options: PruneOptions = {}
): Promise<PruneReport> {
  const dryRun = options.dryRun ?? false;
  const [hardware, models, results] = await Promise.all([
    deleteUnusedFiles(dirs.hardware, new Set(plan.remove.hardware), dryRun),
    deleteUnusedFiles(dirs.models, new Set(plan.remove.models), dryRun),
    deleteUnusedFiles(dirs.results, new Set(plan.remove.results), dryRun)
  ]);

  return {
    dryRun,
    deletedFiles: [...hardware, ...models, ...results].sort((a, b) => a.localeCompare(b)),
    retained: {
      hardware: plan.keep.hardware.length,
      models: plan.keep.models.length,
      results: plan.keep.results.length
    },
    removed: {
      hardware: plan.remove.hardware.length,
      models: plan.remove.models.length,
      results: plan.remove.results.length
    }
  };
}

function dataDirs(): CatalogDataDirs {
  return {
    hardware: path.join(root, "data", "hardware"),
    models: path.join(root, "data", "models"),
    results: path.join(root, "data", "results")
  };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const plan = planCatalogPrune(readCatalogFromDisk());
  const report = await pruneCatalogFiles(plan, dataDirs(), { dryRun });
  const action = dryRun ? "would prune" : "pruned";

  console.log(
    `${action} ${report.removed.results} results, ${report.removed.models} models, ${report.removed.hardware} hardware configs`
  );
  console.log(
    `retaining ${report.retained.results} results, ${report.retained.models} models, ${report.retained.hardware} hardware configs`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
