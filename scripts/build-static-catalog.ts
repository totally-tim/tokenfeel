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
    detailChunk
  };
}

function stripUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
      generatedAt: new Date().toISOString(),
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
  const chunksDir = path.join(outputDir, "chunks");

  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(chunksDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, "index.json"), `${JSON.stringify(payload.index)}\n`);

  await Promise.all(
    Object.entries(payload.detailChunks).map(([fileName, results]) =>
      fs.writeFile(path.join(chunksDir, fileName), `${JSON.stringify(results)}\n`)
    )
  );

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
