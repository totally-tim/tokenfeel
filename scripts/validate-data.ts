import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { catalogSchema, researchItemsSchema } from "../src/data/schemas";
import type { ParsedCatalog } from "../src/data/schemas";
import {
  DEFAULT_LEFT_CONFIG,
  DEFAULT_RIGHT_CONFIG,
  defaultLeftResultId,
  defaultRightResultId
} from "../src/lib/catalog";
import { hasAnyRawEvidence, pruneCatalogForSimulation } from "../src/lib/catalogQuality";

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

function parseJsonFile(filePath: string): unknown {
  const text = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }
}

function readJsonFiles<T>(dir: string): T[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => parseJsonFile(path.join(dir, entry.name)) as T);
}

function readScenarioFiles() {
  return fs
    .readdirSync(path.join(root, "scenarios"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => parseJsonFile(path.join(root, "scenarios", entry.name, "script.json")));
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
export function analyzeCatalogQuality(
  catalog: ParsedCatalog,
  allowlist: QualityAllowlistEntry[] = []
): CatalogQualityReport {
  const warnings: string[] = [];
  const issues: string[] = [];
  const allowlistReasonById = new Map(allowlist.map((entry) => [entry.id, entry.reason]));

  for (const result of catalog.results) {
    // Raw-evidence provenance is hard-enforced only for "verified" rows (see
    // checkCatalogCrossReferences in schemas.ts). A "community" row with no
    // raw evidence at all is not disqualifying -- lots of legitimate
    // community submissions never attach it -- but it's worth flagging so a
    // reviewer can go find/attach it, hence a warning rather than an issue.
    if (result.status === "community" && !hasAnyRawEvidence(result)) {
      warnings.push(
        `${result.id} is status "community" with no raw evidence (source.raw, evidence.rawUrl, evidence.rawRows, evidence.upstreamUrls, or evidence.archiveUrl)`
      );
    }

    for (let index = 1; index < result.measurements.length; index += 1) {
      const previous = result.measurements[index - 1];
      const current = result.measurements[index];
      // The very first measured-depth transition is where JIT/cold-start
      // warm-up variance in the underlying benchmark tool actually lives --
      // the first data point is frequently an artificially slow cold run,
      // so an apparent rate increase specifically here is expected noise,
      // not a sign of a grouping/import bug. Every later transition has no
      // such excuse and is held to the real threshold below. Only applies
      // when a longer curve exists beyond it (length > 2): a bare 2-point
      // submission's only transition has no later data confirming the
      // anomaly is confined to a cold start, so it gets no exemption.
      const isFirstTransition = index === 1 && result.measurements.length > 2;

      for (const metric of ["pp", "tg"] as const) {
        const increaseRatio = (current[metric] - previous[metric]) / previous[metric];
        if (increaseRatio <= 0) continue;

        const message = `${result.id} ${metric} increases ${(increaseRatio * 100).toFixed(1)}% from depth ${previous.depth} to ${current.depth}`;

        if (increaseRatio <= suspiciousIncreaseRatio) {
          warnings.push(message);
          continue;
        }

        if (isFirstTransition) {
          warnings.push(`${message} (first-depth warm-up, not a hard issue)`);
          continue;
        }

        const allowlistReason = allowlistReasonById.get(result.id);
        if (allowlistReason) {
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
