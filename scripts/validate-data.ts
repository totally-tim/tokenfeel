import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { catalogSchema, researchItemsSchema } from "../src/data/schemas";
import type { ParsedCatalog } from "../src/data/schemas";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const suspiciousIncreaseRatio = 0.1;

export interface CatalogQualityReport {
  warnings: string[];
  issues: string[];
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

export function analyzeCatalogQuality(catalog: ParsedCatalog): CatalogQualityReport {
  const warnings: string[] = [];

  for (const result of catalog.results) {
    for (let index = 1; index < result.measurements.length; index += 1) {
      const previous = result.measurements[index - 1];
      const current = result.measurements[index];

      for (const metric of ["pp", "tg"] as const) {
        const increaseRatio = (current[metric] - previous[metric]) / previous[metric];
        if (increaseRatio > suspiciousIncreaseRatio) {
          warnings.push(
            `${result.id} ${metric} increases ${(increaseRatio * 100).toFixed(1)}% from depth ${previous.depth} to ${current.depth}`
          );
        }
      }
    }
  }

  return { warnings, issues: [] };
}

export function readCatalogFromDisk() {
  return catalogSchema.parse({
    hardware: readJsonFiles(path.join(root, "data", "hardware")),
    models: readJsonFiles(path.join(root, "data", "models")),
    results: readJsonFiles(path.join(root, "data", "results")),
    scenarios: readScenarioFiles()
  });
}

function main() {
  const parsed = readCatalogFromDisk();
  const research = readResearchItems();
  const quality = analyzeCatalogQuality(parsed);

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
