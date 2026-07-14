import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCatalogFromDisk } from "./validate-data";
import type { ParsedCatalog } from "../src/data/schemas";
import { pruneCatalogForSimulation } from "../src/lib/catalogQuality";
import type { BenchmarkResult } from "../src/types";
import type { StaticBenchmarkResult, StaticCatalog } from "../src/data/staticCatalog";

const detailChunkCount = 128;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface StaticCatalogPayload {
  index: StaticCatalog;
  detailChunks: Record<string, BenchmarkResult[]>;
}

function stableResultHash(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return hash % detailChunkCount;
}

function detailChunkForResult(id: string): string {
  return `chunk-${String(stableResultHash(id)).padStart(3, "0")}.json`;
}

function compactResult(result: BenchmarkResult, detailChunk: string): StaticBenchmarkResult {
  return {
    id: result.id,
    hardware: result.hardware,
    model: result.model,
    quant: result.quant,
    runtime: result.runtime,
    measurements: result.measurements.map((measurement) => ({
      depth: measurement.depth,
      pp: measurement.pp,
      tg: measurement.tg,
      ppLabel: measurement.ppLabel,
      tgLabel: measurement.tgLabel
    })),
    evidence: result.evidence
      ? {
          rawUrl: result.evidence.rawUrl,
          rawFormat: result.evidence.rawFormat,
          checksum: result.evidence.checksum,
          retrievedAt: result.evidence.retrievedAt,
          upstreamId: result.evidence.upstreamId,
          parserVersion: result.evidence.parserVersion,
          archiveUrl: result.evidence.archiveUrl
        }
      : undefined,
    benchmark: result.benchmark
      ? {
          tool: result.benchmark.tool,
          command: result.benchmark.command,
          profile: result.benchmark.profile,
          runs: result.benchmark.runs,
          warmup: result.benchmark.warmup,
          ppTokens: result.benchmark.ppTokens,
          tgTokens: result.benchmark.tgTokens,
          concurrency: result.benchmark.concurrency,
          latencyMode: result.benchmark.latencyMode
        }
      : undefined,
    topology: result.topology,
    source: {
      kind: result.source.kind,
      title: result.source.title,
      url: result.source.url,
      license: result.source.license,
      notes: result.source.notes
    },
    submitter: result.submitter,
    date: result.date,
    status: result.status,
    overheadMs: result.overheadMs,
    notes: result.notes,
    detailChunk,
    hasSourceRaw: Boolean(result.source.raw) || Boolean(result.evidence?.rawUrl)
  };
}

function stripUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// Deriving generatedAt from the input data (rather than wall-clock "now")
// means an unchanged catalog produces a byte-identical index.json across
// builds, so a CDN/browser cache keyed on content doesn't invalidate for no
// reason. `date` is a required field on every result, so there is always at
// least one candidate; evidence.retrievedAt (when present) is more precise
// and wins when it's later.
function latestGeneratedAt(catalog: ParsedCatalog): string {
  let latestMs = 0;
  for (const result of catalog.results) {
    for (const candidate of [result.evidence?.retrievedAt, result.date]) {
      if (!candidate) continue;
      const ms = Date.parse(candidate);
      if (!Number.isNaN(ms) && ms > latestMs) latestMs = ms;
    }
  }
  return new Date(latestMs).toISOString();
}

export function buildStaticCatalogPayload(catalog: ParsedCatalog): StaticCatalogPayload {
  const detailChunks: Record<string, BenchmarkResult[]> = {};

  const results = catalog.results.map((result) => {
    const detailChunk = detailChunkForResult(result.id);
    detailChunks[detailChunk] ??= [];
    detailChunks[detailChunk].push(result);
    return compactResult(result, detailChunk);
  });

  return stripUndefined({
    index: {
      version: 1,
      generatedAt: latestGeneratedAt(catalog),
      resultCount: catalog.results.length,
      hardware: catalog.hardware,
      models: catalog.models,
      results,
      scenarios: catalog.scenarios
    },
    detailChunks
  });
}

export async function writeStaticCatalog(catalog: ParsedCatalog, outputDir = path.join(root, "public", "catalog")) {
  const payload = buildStaticCatalogPayload(catalog);
  // Write to a sibling temp dir and swap it in with renames rather than
  // rm-then-repopulate in place: a live dev/preview server reading
  // public/catalog/ concurrently must never observe a directory that's been
  // emptied but not yet refilled (see n20).
  // Sweep any temp/backup dirs orphaned by a previously killed build first:
  // they are not gitignored and vite copies everything under public/ into
  // dist/, so a leftover public/catalog.tmp-<pid>/ would otherwise ship (n20).
  const parentDir = path.dirname(outputDir);
  const baseName = path.basename(outputDir);
  const siblings = await fs.readdir(parentDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  await Promise.all(
    siblings
      .filter((name) => name.startsWith(`${baseName}.tmp-`) || name.startsWith(`${baseName}.old-`))
      .map((name) => fs.rm(path.join(parentDir, name), { recursive: true, force: true }))
  );

  const tempDir = `${outputDir}.tmp-${process.pid}`;
  const chunksDir = path.join(tempDir, "chunks");

  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.mkdir(chunksDir, { recursive: true });
  await fs.writeFile(path.join(tempDir, "index.json"), `${JSON.stringify(payload.index)}\n`);

  await Promise.all(
    Object.entries(payload.detailChunks).map(([fileName, results]) =>
      fs.writeFile(path.join(chunksDir, fileName), `${JSON.stringify(results)}\n`)
    )
  );

  const backupDir = `${outputDir}.old-${process.pid}`;
  let hadExisting = true;
  try {
    await fs.rename(outputDir, backupDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    hadExisting = false;
  }
  await fs.rename(tempDir, outputDir);
  if (hadExisting) await fs.rm(backupDir, { recursive: true, force: true });

  return {
    resultCount: payload.index.resultCount,
    chunkCount: Object.keys(payload.detailChunks).length,
    outputDir
  };
}

async function main() {
  const result = await writeStaticCatalog(pruneCatalogForSimulation(readCatalogFromDisk()));
  console.log(
    `generated static catalog with ${result.resultCount} results in ${result.chunkCount} chunks at ${path.relative(root, result.outputDir)}`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
