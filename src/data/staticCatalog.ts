import type { BenchmarkResult, Catalog } from "../types";

export interface StaticBenchmarkResult extends BenchmarkResult {
  detailChunk: string;
}

export interface StaticCatalog extends Omit<Catalog, "results"> {
  version: 1;
  generatedAt: string;
  resultCount: number;
  results: StaticBenchmarkResult[];
}

let catalogPromise: Promise<StaticCatalog> | undefined;
const detailChunkCache = new Map<string, Promise<BenchmarkResult[]>>();

function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL ?? "";
  const normalizedBase = base.endsWith("/") || base === "" ? base : `${base}/`;
  return `${normalizedBase}${path.replace(/^\/+/, "")}`;
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(assetUrl(path));
  if (!response.ok) {
    throw new Error(`Failed to load ${path}: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export function loadStaticCatalog(): Promise<StaticCatalog> {
  catalogPromise ??= fetchJson<StaticCatalog>("catalog/index.json");
  return catalogPromise;
}

export async function loadResultDetail(catalog: StaticCatalog, resultId: string): Promise<BenchmarkResult> {
  const summary = catalog.results.find((result) => result.id === resultId);
  if (!summary) {
    throw new Error(`Unknown result: ${resultId}`);
  }

  let chunkPromise = detailChunkCache.get(summary.detailChunk);
  if (!chunkPromise) {
    chunkPromise = fetchJson<BenchmarkResult[]>(`catalog/chunks/${summary.detailChunk}`).catch((error: unknown) => {
      detailChunkCache.delete(summary.detailChunk);
      throw error;
    });
    detailChunkCache.set(summary.detailChunk, chunkPromise);
  }

  const chunk = await chunkPromise;
  return chunk.find((result) => result.id === resultId) ?? summary;
}
