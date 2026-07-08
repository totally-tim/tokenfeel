import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { catalogSchema, researchItemsSchema } from "../src/data/schemas";
import type { ParsedCatalog } from "../src/data/schemas";
import { DEFAULT_LEFT_CONFIG, DEFAULT_RIGHT_CONFIG, defaultLeftResultId, defaultRightResultId } from "../src/lib/catalog";
import { pruneCatalogForSimulation } from "../src/lib/catalogQuality";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const suspiciousIncreaseRatio = 0.1;
const qualityAllowlistPath = path.join(root, "data", "quality-allowlist.json");

export interface CatalogQualityReport {
  warnings: string[];
  issues: string[];
}

export interface QualityAllowlistEntry {
  id: string;
  reason: string;
}

export function readQualityAllowlist(): QualityAllowlistEntry[] {
  if (!fs.existsSync(qualityAllowlistPath)) return [];
  return JSON.parse(fs.readFileSync(qualityAllowlistPath, "utf8")) as QualityAllowlistEntry[];
}

function readJsonFiles<T>(dir: string): T[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => JSON.parse(fs.readFileSync(path.join(dir, entry.name), "utf8")) as T);
}

function readScenarioFiles() {
  return fs
    .readdirSync(path.join(root, "scenarios"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const scriptPath = path.join(root, "scenarios", entry.name, "script.json");
      return JSON.parse(fs.readFileSync(scriptPath, "utf8"));
    });
}

function readResearchItems() {
  const researchDir = path.join(root, "data", "research");
  if (!fs.existsSync(researchDir)) return [];
  return readJsonFiles<unknown>(researchDir).flatMap((item) => researchItemsSchema.parse(item));
}

// Non-positive rates and duplicate/unsorted measurement depths within one
// sweep are enforced by catalogSchema's superRefine (see schemas.ts) and
// can never reach a ParsedCatalog here -- not re-checked in this function.
// Likewise, result id/hardware/model mismatches (D2), true
// (hardware, model, quant, runtimeKey) duplicate collisions (D3), and
// verified-without-evidence rows (D5) are hard schema validation issues
// raised during catalogSchema.parse, before this function ever runs.
export function analyzeCatalogQuality(catalog: ParsedCatalog, allowlist: QualityAllowlistEntry[] = []): CatalogQualityReport {
  const warnings: string[] = [];
  const issues: string[] = [];
  const allowlistReasonById = new Map(allowlist.map((entry) => [entry.id, entry.reason]));

  for (const result of catalog.results) {
    for (let index = 1; index < result.measurements.length; index += 1) {
      const previous = result.measurements[index - 1];
      const current = result.measurements[index];

      for (const metric of ["pp", "tg"] as const) {
        const increaseRatio = (current[metric] - previous[metric]) / previous[metric];
        if (increaseRatio <= 0) continue;

        const message = `${result.id} ${metric} increases ${(increaseRatio * 100).toFixed(1)}% from depth ${previous.depth} to ${current.depth}`;
        const allowlistReason = allowlistReasonById.get(result.id);
        if (increaseRatio <= suspiciousIncreaseRatio) {
          warnings.push(message);
        } else if (allowlistReason) {
          warnings.push(`${message} (allowlisted: ${allowlistReason})`);
        } else {
          issues.push(message);
        }
      }
    }
  }

  return { warnings, issues };
}

export function readCatalogFromDisk() {
  return catalogSchema.parse({
    hardware: readJsonFiles(path.join(root, "data", "hardware")),
    models: readJsonFiles(path.join(root, "data", "models")),
    results: readJsonFiles(path.join(root, "data", "results")),
    scenarios: readScenarioFiles()
  });
}

// The same catalog the production build ships (scripts/build-static-catalog.ts
// feeds readCatalogFromDisk() straight into pruneCatalogForSimulation). This
// is the single "real catalog" fixture tests should use instead of
// re-implementing catalog assembly -- see src/lib/catalog.test.ts,
// src/lib/configMatrix.test.ts, and src/data/schema.test.ts.
export function readPrunedCatalogFromDisk(): ParsedCatalog {
  return pruneCatalogForSimulation(readCatalogFromDisk());
}

function main() {
  const parsed = readCatalogFromDisk();
  const research = readResearchItems();
  const allowlist = readQualityAllowlist();

  const resultIds = new Set(parsed.results.map((result) => result.id));
  for (const entry of allowlist) {
    if (!resultIds.has(entry.id)) {
      console.warn(`warning: quality-allowlist.json references unknown result id "${entry.id}"`);
    }
  }

  const quality = analyzeCatalogQuality(parsed, allowlist);

  for (const pinned of [
    { name: "DEFAULT_LEFT_CONFIG", config: DEFAULT_LEFT_CONFIG, resolve: defaultLeftResultId },
    { name: "DEFAULT_RIGHT_CONFIG", config: DEFAULT_RIGHT_CONFIG, resolve: defaultRightResultId }
  ]) {
    try {
      pinned.resolve(parsed);
    } catch (error) {
      quality.issues.push(
        `${pinned.name} (hardware=${pinned.config.hardwareId}, model=${pinned.config.modelId}, quant=${pinned.config.quant}) no longer resolves against the catalog: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  for (const warning of quality.warnings) {
    console.warn(`warning: ${warning}`);
  }

  for (const issue of quality.issues) {
    console.error(`issue: ${issue}`);
  }

  if (quality.issues.length > 0) {
    process.exitCode = 1;
  }

  console.log(
    `validated ${parsed.hardware.length} hardware configs, ${parsed.models.length} models, ${parsed.results.length} results, ${parsed.scenarios.length} scenarios, ${research.length} research items`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
