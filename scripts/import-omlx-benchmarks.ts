#!/usr/bin/env tsx

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiUrl = "https://omlx.ai/api/benchmarks";
const sourceIndexUrl = "https://omlx.ai/benchmarks";
const sourceDetailBaseUrl = "https://omlx.ai/benchmarks";
const parserVersion = "tokenfeel-omlx-api/1";
const generatedNotePrefix = "Generated from the oMLX community benchmark API import.";
const rawDir = path.join(root, "data", "upstream");
const rawJsonlPath = path.join(rawDir, "omlx-benchmarks.jsonl");
const rawMetaPath = path.join(rawDir, "omlx-benchmarks.meta.json");
const fetchLimit = 100;

interface OmlxBatchingResult {
  batch_size: number;
  tg_tps: number;
  speedup: number;
}

interface OmlxRow {
  id: string;
  created_at: string;
  chip_name: string;
  chip_variant: string;
  memory_gb: number;
  gpu_cores: number | null;
  omlx_version: string;
  os_version: string;
  model_name: string;
  model_variant: string;
  quantization: string;
  context_length: number;
  pp_tps: number;
  tg_tps: number;
  ttft_ms: number | null;
  peak_memory_gb: number | null;
  batching_results: OmlxBatchingResult[] | null;
}

interface ApiPage {
  data: OmlxRow[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

interface Args {
  skipFetch: boolean;
  resume: boolean;
  maxPages?: number;
  delayMs: number;
  concurrency: number;
}

interface ExistingJson {
  id: string;
  notes?: string;
  evidence?: {
    parserVersion?: string;
  };
}

interface HardwareMetadata {
  id: string;
  name: string;
  shortName: string;
  vendor: string;
  memory: string;
  accelerator: string;
  notes: string;
}

interface ModelMetadata {
  id: string;
  name: string;
  family: string;
  params: string;
  activeParams?: string;
  license: string;
  notes: string;
}

interface Group {
  hardware: HardwareMetadata;
  model: ModelMetadata;
  quant: string;
  quantLabel: string;
  omlxVersions: Set<string>;
  osVersions: Set<string>;
  rows: number;
  selectedByDepth: Map<number, OmlxRow>;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    skipFetch: false,
    resume: false,
    delayMs: 100,
    concurrency: 4
  };

  for (const arg of argv) {
    if (arg === "--skip-fetch") {
      args.skipFetch = true;
    } else if (arg === "--resume") {
      args.resume = true;
    } else if (arg.startsWith("--max-pages=")) {
      args.maxPages = Number.parseInt(arg.slice("--max-pages=".length), 10);
    } else if (arg.startsWith("--delay-ms=")) {
      args.delayMs = Number.parseInt(arg.slice("--delay-ms=".length), 10);
    } else if (arg.startsWith("--concurrency=")) {
      args.concurrency = Number.parseInt(arg.slice("--concurrency=".length), 10);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (args.maxPages !== undefined && (!Number.isInteger(args.maxPages) || args.maxPages < 1)) {
    throw new Error("--max-pages must be a positive integer");
  }

  if (!Number.isInteger(args.delayMs) || args.delayMs < 0) {
    throw new Error("--delay-ms must be a non-negative integer");
  }

  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 12) {
    throw new Error("--concurrency must be an integer from 1 to 12");
  }

  return args;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detailUrl(id: string): string {
  return `${sourceDetailBaseUrl}/${id}`;
}

function isoFromApiDate(value: string): string {
  return `${value.replace(" ", "T")}Z`;
}

function timeValue(value: string): number {
  const timestamp = Date.parse(isoFromApiDate(value));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function numberOrUndefined(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return `sha256:${hash.digest("hex")}`;
}

function slugify(value: string, maxLength = 72): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/_+/g, "-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");

  const slug = ascii.length >= 2 ? ascii : `item-${sha256(value).slice(0, 8)}`;
  if (slug.length <= maxLength) return slug;
  return `${slug.slice(0, maxLength - 9).replace(/[-._]+$/g, "")}-${sha256(value).slice(0, 8)}`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

function hardwareKey(row: OmlxRow): string {
  return [row.chip_name, row.chip_variant ?? "", row.memory_gb, row.gpu_cores ?? ""].join("|");
}

function knownHardwareId(row: OmlxRow): string | undefined {
  const known = new Map<string, string>([
    ["M1|Max|64|32", "m1-max-64gb"],
    ["M2|Max|32|30", "m2-max-32gb"],
    ["M3|Ultra|96|60", "m3-ultra-96gb"],
    ["M4|Pro|64|20", "m4-pro-64gb"],
    ["M4|Max|128|40", "m4-max-128gb"]
  ]);
  return known.get(hardwareKey(row));
}

function hardwareFromRow(row: OmlxRow): HardwareMetadata {
  const chipBase = [row.chip_name, row.chip_variant].filter(Boolean).join(" ");
  const coreLabel = row.gpu_cores ? ` (${row.gpu_cores}c)` : "";
  const shortName = `${chipBase}${coreLabel}`;
  const id =
    knownHardwareId(row) ??
    slugify([chipBase, row.gpu_cores ? `${row.gpu_cores}c` : "", `${row.memory_gb}gb`].filter(Boolean).join("-"));

  return {
    id,
    name: `Apple ${shortName} ${row.memory_gb}GB`,
    shortName,
    vendor: "Apple",
    memory: `${row.memory_gb}GB unified`,
    accelerator: `${chipBase}${row.gpu_cores ? ` ${row.gpu_cores}-core GPU` : " GPU"}`,
    notes: `${generatedNotePrefix} Source hardware fields: chip=${row.chip_name}, variant=${row.chip_variant || "base"}, gpu_cores=${row.gpu_cores ?? "unknown"}.`
  };
}

function modelName(row: OmlxRow): string {
  return [row.model_name, row.model_variant].filter(Boolean).join(" ").trim();
}

function inferFamily(name: string): string {
  const lower = name.toLowerCase();
  if (lower.startsWith("qwen")) return "Qwen";
  if (lower.startsWith("gemma")) return "Gemma";
  if (lower.startsWith("llama")) return "Llama";
  if (lower.startsWith("mistral")) return "Mistral";
  if (lower.startsWith("mixtral")) return "Mixtral";
  if (lower.startsWith("deepseek")) return "DeepSeek";
  if (lower.startsWith("glm")) return "GLM";
  if (lower.startsWith("phi")) return "Phi";
  if (lower.startsWith("gpt-oss")) return "gpt-oss";

  const firstToken = name.split(/[-_\s/]+/).find(Boolean);
  return firstToken && firstToken.length >= 2 ? firstToken : "Unknown";
}

function inferParams(name: string): string {
  const match = name.match(/(\d+(?:\.\d+)?)\s*b\b/i) ?? name.match(/(\d+(?:\.\d+)?)b/i);
  return match ? `${match[1]}B` : "unknown";
}

function inferActiveParams(name: string): string | undefined {
  const match = name.match(/\bA(\d+(?:\.\d+)?)B\b/i);
  return match ? `${match[1]}B` : undefined;
}

function modelFromRow(row: OmlxRow): ModelMetadata {
  const name = modelName(row);
  const activeParams = inferActiveParams(name);
  return {
    id: slugify(name, 64),
    name,
    family: inferFamily(name),
    params: inferParams(name),
    ...(activeParams ? { activeParams } : {}),
    license: "See upstream model card",
    notes: `${generatedNotePrefix} Model metadata inferred from the upstream oMLX model name.`
  };
}

function quantFromRow(row: OmlxRow): string {
  return slugify(row.quantization || "unknown", 40);
}

function runtimeSlug(row: OmlxRow): string {
  return slugify(`omlx-api`, 56);
}

function rowIsUsableForCatalog(row: OmlxRow): boolean {
  return (
    typeof row.id === "string" &&
    row.id.length > 0 &&
    typeof row.chip_name === "string" &&
    row.chip_name.length > 0 &&
    typeof row.memory_gb === "number" &&
    Number.isFinite(row.memory_gb) &&
    row.memory_gb > 0 &&
    modelName(row).length > 1 &&
    typeof row.context_length === "number" &&
    Number.isInteger(row.context_length) &&
    row.context_length >= 0 &&
    typeof row.pp_tps === "number" &&
    Number.isFinite(row.pp_tps) &&
    row.pp_tps > 0 &&
    typeof row.tg_tps === "number" &&
    Number.isFinite(row.tg_tps) &&
    row.tg_tps > 0
  );
}

async function fetchApiPage(page: number): Promise<ApiPage> {
  const url = new URL(apiUrl);
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", String(fetchLimit));
  url.searchParams.set("sort", "created_at");
  url.searchParams.set("order", "asc");

  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "Tokenfeel benchmark importer (source-linked community data import)"
      }
    });

    if (response.ok) {
      const json = (await response.json()) as ApiPage;
      if (!Array.isArray(json.data) || !json.pagination) {
        throw new Error(`Unexpected API response shape for page ${page}`);
      }
      return json;
    }

    if (response.status === 429 || response.status >= 500) {
      const retryAfterSeconds = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
      const retryAfterMs = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 0;
      const backoffMs = Math.max(retryAfterMs, Math.min(60_000, 750 * 2 ** (attempt - 1))) + Math.floor(Math.random() * 250);
      console.warn(`page ${page} returned HTTP ${response.status}; retrying in ${backoffMs}ms`);
      await sleep(backoffMs);
      continue;
    }

    throw new Error(`HTTP ${response.status} from ${url.toString()}`);
  }

  throw new Error(`Failed to fetch page ${page} after retries`);
}

async function scrapeRawRows(args: Args) {
  fs.mkdirSync(rawDir, { recursive: true });
  const tmpPath = `${rawJsonlPath}.tmp`;
  const firstPage = await fetchApiPage(1);
  const pageCount = args.maxPages ? Math.min(args.maxPages, firstPage.pagination.pages) : firstPage.pagination.pages;
  let rowCount = 0;
  let startPage = 1;

  if (args.resume && fs.existsSync(tmpPath)) {
    rowCount = fs.readFileSync(tmpPath, "utf8").split(/\n/).filter(Boolean).length;
    if (rowCount % fetchLimit !== 0) {
      throw new Error(`Cannot resume ${tmpPath}: ${rowCount} rows is not a complete ${fetchLimit}-row page boundary`);
    }
    startPage = rowCount / fetchLimit + 1;
    console.log(`resuming from ${tmpPath}; ${rowCount} rows already fetched, next page ${startPage}`);
  } else if (fs.existsSync(tmpPath)) {
    fs.unlinkSync(tmpPath);
  }

  const stream = fs.createWriteStream(tmpPath, { encoding: "utf8", flags: args.resume ? "a" : "w" });

  function writePage(page: ApiPage) {
    for (const row of page.data) {
      stream.write(`${JSON.stringify(row)}\n`);
      rowCount += 1;
    }
  }

  if (startPage === 1) {
    writePage(firstPage);
    startPage = 2;
    console.log(`fetched page 1/${pageCount}; rows ${rowCount}/${firstPage.pagination.total}`);
  }

  for (let page = startPage; page <= pageCount; page += args.concurrency) {
    const batchPages = Array.from(
      { length: Math.min(args.concurrency, pageCount - page + 1) },
      (_, index) => page + index
    );
    const pages = await Promise.all(batchPages.map((batchPage) => fetchApiPage(batchPage)));
    pages.sort((left, right) => left.pagination.page - right.pagination.page).forEach(writePage);

    const fetchedThrough = Math.min(page + args.concurrency - 1, pageCount);
    if (fetchedThrough % 10 === 0 || fetchedThrough === pageCount) {
      console.log(`fetched page ${fetchedThrough}/${pageCount}; rows ${rowCount}/${firstPage.pagination.total}`);
    }

    if (args.delayMs > 0 && fetchedThrough < pageCount) {
      await sleep(args.delayMs);
    }
  }

  await new Promise<void>((resolve, reject) => {
    stream.end((error?: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });

  fs.renameSync(tmpPath, rawJsonlPath);
  return {
    retrievedAt: new Date().toISOString(),
    rowCount,
    apiTotal: firstPage.pagination.total,
    pageCount,
    apiPages: firstPage.pagination.pages
  };
}

function readRows(): OmlxRow[] {
  if (!fs.existsSync(rawJsonlPath)) {
    throw new Error(`Missing raw scrape file: ${rawJsonlPath}`);
  }

  return fs
    .readFileSync(rawJsonlPath, "utf8")
    .split(/\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as OmlxRow);
}

function readJsonFiles<T extends ExistingJson>(dir: string): Map<string, { filePath: string; value: T }> {
  const items = new Map<string, { filePath: string; value: T }>();
  if (!fs.existsSync(dir)) return items;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(dir, entry.name);
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
    items.set(value.id, { filePath, value });
  }

  return items;
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function removeGeneratedJsonFiles(dir: string, keepIds: Set<string>, matches: (value: ExistingJson) => boolean) {
  const existing = readJsonFiles(dir);
  for (const [id, { filePath, value }] of existing) {
    if (!keepIds.has(id) && matches(value)) {
      fs.unlinkSync(filePath);
    }
  }
}

function writeMetadataFiles<T extends ExistingJson>(
  dir: string,
  items: Map<string, T>,
  existing: Map<string, { filePath: string; value: T }>
) {
  for (const item of items.values()) {
    const current = existing.get(item.id);
    const shouldWrite = !current || current.value.notes?.startsWith(generatedNotePrefix);
    if (!shouldWrite) continue;
    writeJson(path.join(dir, `${item.id}.json`), item);
  }
}

function buildGroups(rows: OmlxRow[]) {
  const hardwareItems = new Map<string, HardwareMetadata>();
  const modelItems = new Map<string, ModelMetadata>();
  const groups = new Map<string, Group>();
  let skippedRows = 0;

  for (const row of rows) {
    if (!rowIsUsableForCatalog(row)) {
      skippedRows += 1;
      continue;
    }

    const hardware = hardwareFromRow(row);
    const model = modelFromRow(row);
    const quant = quantFromRow(row);
    const omlxVersion = row.omlx_version || "unknown";
    const osVersion = row.os_version || "unknown";
    const groupKey = [hardware.id, model.id, quant].join("|");
    let group = groups.get(groupKey);

    hardwareItems.set(hardware.id, hardware);
    modelItems.set(model.id, model);

    if (!group) {
      group = {
        hardware,
        model,
        quant,
        quantLabel: row.quantization || quant,
        omlxVersions: new Set(),
        osVersions: new Set(),
        rows: 0,
        selectedByDepth: new Map()
      };
      groups.set(groupKey, group);
    }

    group.rows += 1;
    group.omlxVersions.add(omlxVersion);
    group.osVersions.add(osVersion);
    const selected = group.selectedByDepth.get(row.context_length);
    if (!selected || timeValue(row.created_at) >= timeValue(selected.created_at)) {
      group.selectedByDepth.set(row.context_length, row);
    }
  }

  return { hardwareItems, modelItems, groups, skippedRows };
}

function resultFromGroup(group: Group) {
  const rows = [...group.selectedByDepth.values()].sort((left, right) => left.context_length - right.context_length);
  const latestRow = [...rows].sort((left, right) => timeValue(right.created_at) - timeValue(left.created_at))[0];
  const runtime = runtimeSlug(latestRow);
  const resultId = `${group.hardware.id}__${group.model.id}__${group.quant}__${runtime}`;
  const selectedUrls = rows.map((row) => detailUrl(row.id));
  const rawRows = rows.map(
    (row) =>
      `${row.id} ${isoFromApiDate(row.created_at)} ctx=${row.context_length} pp=${row.pp_tps} tg=${row.tg_tps} omlx=${row.omlx_version || "unknown"} os=${row.os_version || "unknown"} ${detailUrl(row.id)}`
  );
  const selectedOmlxVersions = [...new Set(rows.map((row) => row.omlx_version || "unknown"))].sort();
  const selectedOsVersions = [...new Set(rows.map((row) => row.os_version || "unknown"))].sort();

  return {
    id: resultId,
    hardware: group.hardware.id,
    model: group.model.id,
    quant: group.quant,
    runtime: {
      name: "oMLX",
      version: latestRow.omlx_version || "unknown",
      backend: "MLX",
      flags: "oMLX community API; latest linked row per context",
      cache: "prefix" as const
    },
    measurements: rows.map((row) => ({
      depth: row.context_length,
      pp: row.pp_tps,
      tg: row.tg_tps,
      ppLabel: `${group.quantLabel} PP`,
      tgLabel: `${group.quantLabel} TG`,
      source: {
        url: detailUrl(row.id),
        upstreamId: row.id,
        createdAt: isoFromApiDate(row.created_at),
        ...(numberOrUndefined(row.ttft_ms) === undefined ? {} : { ttftMs: row.ttft_ms as number }),
        ...(numberOrUndefined(row.peak_memory_gb) === undefined ? {} : { peakMemoryGb: row.peak_memory_gb as number })
      }
    })),
    evidence: {
      rawUrl: apiUrl,
      rawFormat: "oMLX API JSONL mirror",
      retrievedAt: new Date().toISOString(),
      upstreamId: latestRow.id,
      parserVersion,
      rawRows,
      upstreamUrls: selectedUrls
    },
    benchmark: {
      tool: "oMLX",
      outputFormat: "community API",
      latencyMode: "single-user prompt/decode",
      metadata: {
        upstream_rows_in_group: group.rows,
        selected_depths: rows.length,
        latest_upstream_id: latestRow.id,
        latest_created_at: isoFromApiDate(latestRow.created_at),
        selected_omlx_versions: selectedOmlxVersions.join(", "),
        selected_os_versions: selectedOsVersions.join(", ")
      }
    },
    topology: {
      acceleratorCount: 1,
      os: latestRow.os_version || "unknown",
      runtimeVersions: {
        omlx: latestRow.omlx_version || "unknown"
      }
    },
    source: {
      kind: "community-benchmark" as const,
      title: `oMLX ${group.model.name} on ${group.hardware.shortName} community benchmark`,
      url: detailUrl(latestRow.id),
      raw: path.relative(root, rawJsonlPath),
      license: "Apache-2.0 project; submitted benchmark data attribution required",
      notes: `Generated from ${sourceIndexUrl}. Measurements link to their selected upstream oMLX benchmark rows.`
    },
    submitter: "oMLX community",
    date: isoFromApiDate(latestRow.created_at).slice(0, 10),
    status: "community" as const,
    notes: `${generatedNotePrefix} ${group.rows} upstream row(s) were scraped for this hardware/model/quant group; the latest row at each context depth was selected for simulation. Selected depths may span oMLX or macOS versions, and each measurement links to its exact upstream row.`
  };
}

function generateCatalog(scrapeSummary?: Awaited<ReturnType<typeof scrapeRawRows>>) {
  const rows = readRows();
  const { hardwareItems, modelItems, groups, skippedRows } = buildGroups(rows);
  const results = [...groups.values()].map(resultFromGroup);
  const hardwareDir = path.join(root, "data", "hardware");
  const modelDir = path.join(root, "data", "models");
  const resultDir = path.join(root, "data", "results");

  removeGeneratedJsonFiles(hardwareDir, new Set(hardwareItems.keys()), (value) => value.notes?.startsWith(generatedNotePrefix) ?? false);
  removeGeneratedJsonFiles(modelDir, new Set(modelItems.keys()), (value) => value.notes?.startsWith(generatedNotePrefix) ?? false);
  removeGeneratedJsonFiles(resultDir, new Set(results.map((result) => result.id)), (value) => value.evidence?.parserVersion === parserVersion);

  writeMetadataFiles(hardwareDir, hardwareItems, readJsonFiles(hardwareDir));
  writeMetadataFiles(modelDir, modelItems, readJsonFiles(modelDir));

  for (const result of results) {
    writeJson(path.join(resultDir, `${result.id}.json`), result);
  }

  const meta = {
    source: sourceIndexUrl,
    api: apiUrl,
    apiQuery: `${apiUrl}?sort=created_at&order=asc&limit=${fetchLimit}`,
    parserVersion,
    retrievedAt: scrapeSummary?.retrievedAt ?? new Date().toISOString(),
    rawFile: path.relative(root, rawJsonlPath),
    rawChecksum: sha256File(rawJsonlPath),
    rawRows: rows.length,
    apiTotalRows: scrapeSummary?.apiTotal,
    fetchedPages: scrapeSummary?.pageCount,
    apiPages: scrapeSummary?.apiPages,
    generated: {
      hardware: hardwareItems.size,
      models: modelItems.size,
      results: results.length,
      skippedRows
    }
  };
  writeJson(rawMetaPath, meta);
  return meta;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scrapeSummary = args.skipFetch ? undefined : await scrapeRawRows(args);
  const meta = generateCatalog(scrapeSummary);
  console.log(
    `imported ${meta.rawRows} oMLX rows into ${meta.generated.results} Tokenfeel result curves, ${meta.generated.hardware} hardware configs, ${meta.generated.models} models`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
