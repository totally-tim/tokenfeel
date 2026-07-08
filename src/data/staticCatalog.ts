import type { z } from "zod";
import { resultSchema, staticCatalogSchema } from "./schemas";
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

function formatZodIssues(error: z.ZodError): string {
  const shown = error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  const remaining = error.issues.length - 5;
  return remaining > 0 ? `${shown}; ...and ${remaining} more` : shown;
}

// The build-time zod gate (scripts/build-static-catalog.ts, via
// readCatalogFromDisk) is the only thing that validates data/*.json today.
// Everything downstream of that -- a stale service-worker/CDN cache, a
// hand-edited public/catalog/ file, a truncated fetch, a future build script
// bug -- reaches buildTimeline() with nothing re-checking it unless we
// validate again here, at the one place all of that data actually enters the
// running app. staticCatalogSchema mirrors catalogSchema's shape/cross-
// reference checks (see src/data/schemas.ts) but skips the verified/raw-
// evidence rule, which does not apply to this intentionally-compacted view.
function parseStaticCatalog(raw: unknown): StaticCatalog {
  const parsed = staticCatalogSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Static catalog failed validation (catalog/index.json): ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

// Detail chunks carry the full BenchmarkResult shape (including source.raw),
// so they're checked against the same resultSchema used for the
// source-of-truth data -- no need for the compacted-view carve-out above.
//
// A chunk is hash-bucketed across ~46 unrelated results (see
// detailChunkForResult in scripts/build-static-catalog.ts), so one corrupt
// row must not take down every other result sharing the chunk: invalid rows
// are logged and dropped rather than failing the whole chunk. If the row a
// caller actually asked for turns out to be one of the dropped ones,
// loadResultDetail falls back to the compacted summary it already has.
function parseDetailChunk(raw: unknown, chunkName: string): BenchmarkResult[] {
  if (!Array.isArray(raw)) {
    throw new Error(`Catalog detail chunk ${chunkName} failed validation: expected an array`);
  }
  const results: BenchmarkResult[] = [];
  for (const [index, row] of raw.entries()) {
    const parsed = resultSchema.safeParse(row);
    if (!parsed.success) {
      console.error(`Catalog detail chunk ${chunkName}[${index}] failed validation: ${formatZodIssues(parsed.error)}`);
      continue;
    }
    results.push(parsed.data);
  }
  return results;
}

export function loadStaticCatalog(): Promise<StaticCatalog> {
  catalogPromise ??= fetchJson<unknown>("catalog/index.json")
    .then(parseStaticCatalog)
    .catch((error: unknown) => {
      catalogPromise = undefined;
      throw error;
    });
  return catalogPromise;
}

export async function loadResultDetail(catalog: StaticCatalog, resultId: string): Promise<BenchmarkResult> {
  const summary = catalog.results.find((result) => result.id === resultId);
  if (!summary) {
    throw new Error(`Unknown result: ${resultId}`);
  }

  let chunkPromise = detailChunkCache.get(summary.detailChunk);
  if (!chunkPromise) {
    chunkPromise = fetchJson<unknown>(`catalog/chunks/${summary.detailChunk}`)
      .then((raw) => parseDetailChunk(raw, summary.detailChunk))
      .catch((error: unknown) => {
        detailChunkCache.delete(summary.detailChunk);
        throw error;
      });
    detailChunkCache.set(summary.detailChunk, chunkPromise);
  }

  const chunk = await chunkPromise;
  return chunk.find((result) => result.id === resultId) ?? summary;
}
