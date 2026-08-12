#!/usr/bin/env tsx

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchmarkMeasurement, HardwareConfig, ModelMetadata } from "../src/types";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteUrl = "https://spark-arena.com";
const snapshotIndexUrl = `${siteUrl}/static/snapshot/index`;
const snapshotTestUrl = `${siteUrl}/static/snapshot/test`;
const leaderboardUrl = `${siteUrl}/leaderboard`;
const parserVersion = "tokenfeel-spark-arena-snapshot/1";
const generatedNotePrefix = "Generated from the Spark Arena DGX Spark leaderboard import.";

const rawDir = path.join(root, "data", "upstream");
const snapshotPath = path.join(rawDir, "spark-arena-snapshot.json");
const rawLogsPath = path.join(rawDir, "spark-arena-raw-logs.jsonl");
const metaPath = path.join(rawDir, "spark-arena.meta.json");

const hardwareDir = path.join(root, "data", "hardware");
const modelDir = path.join(root, "data", "models");
const resultDir = path.join(root, "data", "results");

// Tokenfeel simulates how one conversation feels, so only the single-stream
// (c1) sweeps are comparable to the rest of the catalog. Higher-concurrency
// Spark Arena tests measure aggregate server throughput, which would read as
// a much "faster" machine for a workload nobody is actually waiting on.
const concurrencyLabel = "(c1)";
const prefillTestPrefix = "pp2048";
const decodeTestPrefix = "tg128";

// Spark Arena reports its own cluster size per submission. These are the
// Tokenfeel hardware ids each maps onto; anything else is skipped rather than
// invented, because a cluster size with no hardware definition would silently
// become a different machine.
const hardwareIdByClusterSize = new Map<number, string>([
  [1, "dgx-spark"],
  [2, "dgx-spark-dual-qsfp"],
  [4, "dgx-spark-quad-qsfp"],
  [8, "dgx-spark-octa-qsfp"]
]);

// Only generated when a submission actually needs it, so the catalog never
// grows a hardware entry with no rows behind it.
const generatedHardware = new Map<string, HardwareConfig>([
  [
    "dgx-spark-octa-qsfp",
    {
      id: "dgx-spark-octa-qsfp",
      name: "NVIDIA DGX Spark Octa QSFP Cluster",
      shortName: "8x DGX Spark",
      vendor: "NVIDIA",
      memory: "1TB unified aggregate",
      accelerator: "8x GB10 over QSFP / ConnectX-7 fabric",
      // Must carry the generated prefix: the write guard treats anything else
      // as hand-authored, which would freeze this entry at its first version
      // and exempt it from the cleanup sweep below.
      notes: `${generatedNotePrefix} Eight DGX Spark systems connected over QSFP for distributed vLLM inference. Cluster size is community-reported Spark Arena leaderboard metadata; the raw llama-benchy logs do not themselves record node count.`
    }
  ]
]);

// validate-data.ts treats any pp/tg increase above this ratio as a hard issue
// once past the cold-start transition, because throughput should decay as
// context grows. Community cluster runs are noisy enough that some sweeps
// breach it, and those submissions are dropped here rather than allowlisted --
// the repo deliberately moved away from mass allowlisting.
const maxRateIncreaseRatio = 0.1;
const minSharedDepths = 3;

// NVIDIA quotes DGX Spark at "1 petaFLOP of AI performance" (FP4, with
// sparsity) per GB10. Using that headline figure -- rather than the roughly
// 2x lower dense number -- keeps this a hard physical ceiling rather than an
// efficiency opinion: no implementation, at any precision, can prefill faster
// than the accelerator can issue the arithmetic.
const gb10PeakFlops = 1e15;
// A transformer forward pass costs roughly 2 FLOPs per active parameter per
// token, so peak tok/s = (nodes * peakFlops) / (2 * activeParams).
const flopsPerActiveParamPerToken = 2;
// Mirrors PUBLIC_SIMULATION_MIN_DEPTH in src/lib/catalogQuality.ts: a sweep
// that never reaches 8k context gets pruned from the simulator anyway.
const minMaxDepth = 8192;

interface Args {
  skipFetch: boolean;
  delayMs: number;
  maxRetries: number;
}

export interface SnapshotEntry {
  modelName: string;
  modelFullPath: string;
  modelUrl?: string;
  runtime: string;
  clusterSize: number;
  tokensPerSec: number;
  benchmarkId: string;
  quantization: string;
  submittedAt: string;
  recipeType?: string;
  userId?: string;
  // Prompt-processing time and client-perceived time to first token, in ms.
  estPpt?: number | null;
  e2eTtft?: number | null;
}

interface SnapshotTest {
  testName: string;
  entries: SnapshotEntry[];
}

interface SnapshotCache {
  index: { generatedAt: string; metadata?: Record<string, unknown> };
  tests: SnapshotTest[];
}

interface RawLogRecord {
  benchmarkId: string;
  url: string;
  text: string;
}

export interface Candidate {
  benchmarkId: string;
  meta: SnapshotEntry;
  prefill: Map<number, number>;
  decode: Map<number, number>;
  // e2eTtft - estPpt per prefill depth: the client-side cost on top of raw
  // prompt processing.
  clientOverheadMs: Map<number, number>;
}

interface ExistingJson {
  id: string;
  notes?: string;
  status?: string;
  evidence?: { parserVersion?: string };
}

/**
 * A row this importer generated and that nobody has reviewed since. Ownership
 * must be proven, never assumed: the repo reserves "verified" for
 * maintainer-reproduced data, so a curated hand-authored row legitimately stays
 * "community" and carries no parser marker at all. Reading a missing marker as
 * "probably ours" is what let a refresh overwrite three of them.
 */
export function isOwnedByThisParser(value: ExistingJson): boolean {
  return value.evidence?.parserVersion === parserVersion && value.status === "community";
}

function parseArgs(argv: string[]): Args {
  const args: Args = { skipFetch: false, delayMs: 1500, maxRetries: 4 };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--skip-fetch") args.skipFetch = true;
    else if (item === "--delay-ms") args.delayMs = Number(argv[(index += 1)]);
    else if (item === "--max-retries") args.maxRetries = Number(argv[(index += 1)]);
    else if (item === "--help") {
      console.log(usage());
      process.exit(0);
    }
  }
  if (!Number.isFinite(args.delayMs) || args.delayMs < 0) throw new Error("--delay-ms must be a non-negative number");
  if (!Number.isInteger(args.maxRetries) || args.maxRetries < 1) throw new Error("--max-retries must be >= 1");
  return args;
}

function usage(): string {
  return `Usage:
  tsx scripts/import-spark-arena.ts [--skip-fetch] [--delay-ms 1500] [--max-retries 4]

Fetches the Spark Arena DGX Spark leaderboard snapshot plus the raw llama-benchy
log behind every selected submission, then regenerates the matching
data/hardware, data/models, and data/results rows.

--skip-fetch rebuilds purely from the cached files in data/upstream/.

The raw-log cache only holds the submissions that won grouping when it was
fetched, so a change to model canonicalisation, quant resolution, or the
grouping key can select a submission whose log was never cached. That surfaces
as "no value in raw log" cross-check failures for the newly selected rows; the
fix is a real run without --skip-fetch, not a change to the cross-check.`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function sha256File(filePath: string): string {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function slugify(value: string, maxLength = 72): string {
  const ascii = value
    .normalize("NFKD")
    // eslint-disable-next-line no-control-regex -- \x00-\x7F is the intended full ASCII range, not a stray control char
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

async function fetchText(url: string, args: Args): Promise<string> {
  let lastError = "";
  for (let attempt = 1; attempt <= args.maxRetries; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, { headers: { accept: "*/*" } });
    } catch (error) {
      // A transient DNS, socket, TLS, or connection-reset failure rejects the
      // promise instead of returning a status. A refresh issues dozens of
      // sequential requests, so one such blip must not abort the whole import
      // while --max-retries is on the table -- give it the same backoff an
      // HTTP failure gets.
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt >= args.maxRetries) break;
      await sleep(args.delayMs * attempt * 4);
      continue;
    }
    if (response.ok) return response.text();
    lastError = `${response.status} ${response.statusText}`;
    // Spark Arena is a small community server and rate-limits bulk reads.
    // Back off progressively instead of hammering it.
    if (response.status === 429 || response.status >= 500) {
      await sleep(args.delayMs * attempt * 4);
      continue;
    }
    break;
  }
  throw new Error(`Failed to fetch ${url}: ${lastError}`);
}

/** Test names look like "pp2048 (c1)" or "pp2048 @ d16384 (c1)". */
function depthFromTestName(testName: string): number {
  const match = testName.match(/@ d(\d+)/);
  return match ? Number(match[1]) : 0;
}

function isSelectedTest(testName: string): boolean {
  if (!testName.endsWith(concurrencyLabel)) return false;
  return testName.startsWith(prefillTestPrefix) || testName.startsWith(decodeTestPrefix);
}

async function fetchSnapshot(args: Args): Promise<SnapshotCache> {
  const indexText = await fetchText(snapshotIndexUrl, args);
  const index = JSON.parse(indexText) as {
    generatedAt: string;
    metadata?: Record<string, unknown>;
    tests: Array<{ testName: string }>;
  };
  const wanted = index.tests
    .map((test) => test.testName)
    .filter(isSelectedTest)
    .sort();

  const tests: SnapshotTest[] = [];
  for (const testName of wanted) {
    const url = `${snapshotTestUrl}?test=${encodeURIComponent(testName)}`;
    const test = JSON.parse(await fetchText(url, args)) as SnapshotTest;
    tests.push({ testName, entries: test.entries ?? [] });
    await sleep(args.delayMs);
  }

  return { index: { generatedAt: index.generatedAt, metadata: index.metadata }, tests };
}

function buildCandidates(snapshot: SnapshotCache): Map<string, Candidate> {
  const candidates = new Map<string, Candidate>();
  for (const test of snapshot.tests) {
    const depth = depthFromTestName(test.testName);
    const isPrefill = test.testName.startsWith(prefillTestPrefix);
    for (const entry of test.entries) {
      if (!entry.benchmarkId || !Number.isFinite(entry.tokensPerSec) || entry.tokensPerSec <= 0) continue;
      let candidate = candidates.get(entry.benchmarkId);
      if (!candidate) {
        candidate = {
          benchmarkId: entry.benchmarkId,
          meta: entry,
          prefill: new Map(),
          decode: new Map(),
          clientOverheadMs: new Map()
        };
        candidates.set(entry.benchmarkId, candidate);
      }
      (isPrefill ? candidate.prefill : candidate.decode).set(depth, entry.tokensPerSec);
      if (isPrefill && typeof entry.e2eTtft === "number" && typeof entry.estPpt === "number") {
        candidate.clientOverheadMs.set(depth, entry.e2eTtft - entry.estPpt);
      }
    }
  }
  return candidates;
}

interface UsableSweep {
  depths: number[];
  prefill: number[];
  decode: number[];
}

/**
 * A submission is only usable when prefill and decode were both measured at
 * the same depths (the timing model needs a pp/tg pair per depth), the sweep
 * is long enough to be a curve rather than a point, and it decays the way a
 * real depth sweep does.
 */
export function usableSweep(candidate: Candidate): UsableSweep | undefined {
  const depths = [...candidate.prefill.keys()].filter((depth) => candidate.decode.has(depth)).sort((a, b) => a - b);
  if (depths.length < minSharedDepths) return undefined;
  if (depths[depths.length - 1] < minMaxDepth) return undefined;

  const prefill = depths.map((depth) => candidate.prefill.get(depth) as number);
  const decode = depths.map((depth) => candidate.decode.get(depth) as number);

  for (let index = 1; index < depths.length; index += 1) {
    // Mirrors the cold-start exemption in validate-data.ts and
    // src/lib/catalogQuality.ts: warm-up variance lives in the first measured
    // transition, and only counts as exempt when a longer curve exists past it.
    const isFirstTransition = index === 1 && depths.length > 2;
    if (isFirstTransition) continue;
    for (const series of [prefill, decode]) {
      if ((series[index] - series[index - 1]) / series[index - 1] > maxRateIncreaseRatio) return undefined;
    }
  }

  return { depths, prefill, decode };
}

export function billionsFromParamLabel(label: string | undefined): number | undefined {
  if (!label) return undefined;
  // Active-parameter labels appear both as "3B" and -- following the
  // checkpoint-naming convention -- as "A3B". Both gates fall back to "not
  // enough information, allow" when this returns undefined, so refusing to
  // read the second form would let the roofline gate fail open purely because
  // of how a label was styled. That is exactly how the 937k t/s Qwen3.6-35B-A3B
  // submission would reach the catalog.
  const match = label.trim().match(/^A?(\d+(?:\.\d+)?)\s*([BM])$/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return match[2].toUpperCase() === "M" ? value / 1000 : value;
}

/**
 * Rejects sweeps whose prefill rate exceeds what the hardware could physically
 * issue, which is the only way to catch a submission that reports the right
 * shape of curve built on a wrong unit or a bad aggregation. Spark Arena has
 * such rows: one claims ~937k tok/s prefill for a 3B-active model on a single
 * GB10, about 5.6x past the theoretical ceiling.
 *
 * Only applied when the *active* parameter count is actually known. Falling
 * back to the total would make this reject legitimate MoE runs: gpt-oss-120b
 * discloses no active count, so a 120B-derived ceiling of 4167 t/s sits far
 * below its real limit and a genuinely fast run would look impossible.
 * Skipping the unknown case keeps this a true statement about physics rather
 * than a tuned threshold, so it needs no fudge factor.
 */
export function exceedsRoofline(model: ModelMetadata, clusterSize: number, peakPrefill: number): boolean {
  const activeBillions = billionsFromParamLabel(model.activeParams);
  if (activeBillions === undefined) return false;
  const ceiling = (clusterSize * gb10PeakFlops) / (flopsPerActiveParamPerToken * activeBillions * 1e9);
  return peakPrefill > ceiling;
}

// Bytes of weight storage per parameter, by the weight format resolved from
// the repo name. Only formats that actually appear upstream are listed.
const bytesPerParamByFormat = new Map<string, number>([
  ["bfloat16", 2],
  ["float16", 2],
  ["bf16", 2],
  ["fp16", 2],
  ["fp8", 1],
  ["mxfp8", 1],
  ["int8", 1],
  ["nvfp4", 0.5],
  ["mxfp4", 0.5],
  ["fp4", 0.5],
  ["int4", 0.5],
  ["awq", 0.5],
  ["gptq", 0.5],
  ["w4a16", 0.5]
]);

const gb10MemoryBytes = 128 * 1e9;

/**
 * Rejects rows whose weights could not fit the machine they claim to have run
 * on. This catches a different failure than the roofline -- a wrong *parameter
 * count* rather than a wrong rate.
 *
 * Deliberately generous: it compares against the full unified memory and
 * ignores KV cache, activations, and runtime overhead, so it only fires on a
 * claim that is impossible before the server allocates anything else.
 */
/**
 * Bytes per parameter for a quant identity, including the hybrid ones
 * `quantFromEntry` emits (e.g. "int4-fp8"). A hybrid stores different tensors
 * in different formats, so the smallest component is used: that keeps this a
 * statement about what cannot fit under even the most favourable packing,
 * rather than an estimate of the real mix.
 */
export function bytesPerParamForQuant(quant: string): number | undefined {
  const direct = bytesPerParamByFormat.get(quant);
  if (direct !== undefined) return direct;
  const parts = quant.split("-").map((part) => bytesPerParamByFormat.get(part));
  if (parts.length < 2 || parts.some((value) => value === undefined)) return undefined;
  return Math.min(...(parts as number[]));
}

export function exceedsMemory(model: ModelMetadata, quant: string, clusterSize: number): boolean {
  const totalBillions = billionsFromParamLabel(model.params);
  const bytesPerParam = bytesPerParamForQuant(quant);
  if (totalBillions === undefined || bytesPerParam === undefined) return false;
  return totalBillions * 1e9 * bytesPerParam > clusterSize * gb10MemoryBytes;
}

function rawLogUrl(benchmarkId: string): string {
  return `${siteUrl}/api/benchmarks/${benchmarkId}/raw`;
}

function detailUrl(benchmarkId: string): string {
  return `${siteUrl}/benchmark/${benchmarkId}`;
}

/**
 * Spark Arena serves the same llama-benchy log in several shapes: a markdown
 * pipe table, a comma- or tab-separated file with explicit mean/std columns,
 * and a quoted CSV. Some exports also mangle the "±" separator into mojibake
 * ("Â±", "¬±"), so values are split on "first number, then any non-numeric
 * run, then second number" instead of on a literal separator.
 */
export function parseRawLog(text: string): Map<string, { mean: number; stddev?: number }> {
  const out = new Map<string, { mean: number; stddev?: number }>();
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return out;

  const readValue = (cell: string | undefined): { mean: number; stddev?: number } | undefined => {
    const trimmed = (cell ?? "").trim();
    if (!trimmed) return undefined;
    const match = trimmed.match(/^(-?\d+(?:\.\d+)?)(?:[^\d.-]+(-?\d+(?:\.\d+)?))?$/);
    if (!match) return undefined;
    const mean = Number(match[1]);
    if (!Number.isFinite(mean)) return undefined;
    const stddev = match[2] === undefined ? undefined : Number(match[2]);
    return { mean, stddev: Number.isFinite(stddev) ? stddev : undefined };
  };

  const header = lines[0].trim().replace(/^│/, "");
  if (header.startsWith("|")) {
    for (const line of lines) {
      const row = line.trim().replace(/^│/, "").trim();
      if (!row.startsWith("|")) continue;
      const cells = row
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim());
      if (cells.length < 3) continue;
      if (cells[0] === "model") continue;
      // Markdown alignment row, e.g. "|:---|---:|".
      if (/^[-: ]+$/.test(cells[0])) continue;
      const value = readValue(cells[2]);
      if (value) out.set(cells[1], value);
    }
    return out;
  }

  const delimiter = header.includes("\t") ? "\t" : ",";
  // A naive split on the delimiter shifts every later column when a quoted
  // field contains one (e.g. `"Acme, Inc/model"`), which silently drops the
  // measurement and its cross-check. Track quoting instead.
  const splitRow = (line: string): string[] => {
    const cells: string[] = [];
    let cell = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (quoted && line[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
        continue;
      }
      if (char === delimiter && !quoted) {
        cells.push(cell.trim());
        cell = "";
        continue;
      }
      cell += char;
    }
    cells.push(cell.trim());
    return cells;
  };

  const columns = splitRow(lines[0]);
  const testIndex = columns.findIndex((column) => column === "test_name" || column === "test");
  const meanIndex = columns.findIndex((column) => column === "t_s_mean" || column === "t/s (total)");
  const stdIndex = columns.findIndex((column) => column === "t_s_std");
  if (testIndex < 0 || meanIndex < 0) return out;

  for (const line of lines.slice(1)) {
    const cells = splitRow(line);
    const testName = cells[testIndex];
    const value = readValue(cells[meanIndex]);
    if (!testName || !value) continue;
    if (value.stddev === undefined && stdIndex >= 0) {
      const std = readValue(cells[stdIndex]);
      if (std) value.stddev = std.mean;
    }
    out.set(testName, value);
  }
  return out;
}

/**
 * Per-request client overhead on top of raw prompt processing, taken as the
 * median of (e2eTtft - estPpt) across the row's own selected prefill depths.
 *
 * Tokenfeel adds overheadMs to every prefill event, so a made-up value
 * systematically skews short and multi-turn simulations. The leaderboard
 * publishes both timings, and their difference across the selected c1 points
 * is a few milliseconds -- nothing like the 90ms an earlier hand-authored row
 * happened to carry. The median rather than the mean because a handful of
 * submissions carry multi-second outliers.
 */
function clientOverheadMs(candidate: Candidate, depths: number[]): number | undefined {
  const samples = depths
    .map((depth) => candidate.clientOverheadMs.get(depth))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (samples.length === 0) return undefined;
  const middle = Math.floor(samples.length / 2);
  const median = samples.length % 2 === 0 ? (samples[middle - 1] + samples[middle]) / 2 : samples[middle];
  return Math.round(median);
}

function testNameFor(prefix: string, depth: number): string {
  return depth === 0 ? `${prefix} ${concurrencyLabel}` : `${prefix} @ d${depth} ${concurrencyLabel}`;
}

function inferFamily(name: string): string {
  const lower = name.toLowerCase();
  const families: Array<[string, string]> = [
    ["qwen", "Qwen"],
    ["gemma", "Gemma"],
    ["llama", "Llama"],
    ["mistral", "Mistral"],
    ["deepseek", "DeepSeek"],
    ["glm", "GLM"],
    ["phi", "Phi"],
    ["gpt-oss", "gpt-oss"],
    ["minimax", "MiniMax"],
    ["nemotron", "Nemotron"],
    ["kimi", "Kimi"],
    ["lfm", "LFM"],
    ["granite", "Granite"],
    ["seed-oss", "Seed-OSS"],
    ["ernie", "ERNIE"],
    ["trinity", "Trinity"],
    ["inkling", "Inkling"],
    ["step", "Step"]
  ];
  for (const [needle, family] of families) {
    if (lower.includes(needle)) return family;
  }
  const firstToken = name.split(/[-_\s/]+/).find(Boolean);
  return firstToken && firstToken.length >= 2 ? firstToken : "Unknown";
}

/**
 * Plenty of Spark Arena models are named for a version rather than a size
 * ("MiniMax-M3-NVFP4", "GLM-5.1-FP8", "Kimi-K2.6-NVFP4"), so nothing can be
 * inferred from the name and the row would be pruned as "unknown-model-params".
 *
 * Each entry below is the total parameter count read from the *base* model's
 * safetensors element count via the Hugging Face model API. The base model is
 * used deliberately: a packed 4-bit repo stores several weights per element,
 * so reading the quantized repo directly understates the real size by up to
 * ~8x (MiniMax-M2.5-AWQ-4bit reports 36.8B for a 229B model).
 */
const knownParamsByRepo = new Map<string, string>([
  ["cyankiwi/glm-4.7-flash-awq-4bit", "31B"], // zai-org/GLM-4.7-Flash = 31.2B
  ["quanttrio/glm-5.1-awq", "754B"], // zai-org/GLM-5.1 = 753.9B
  ["zai-org/glm-5.1-fp8", "754B"], // zai-org/GLM-5.1-FP8 = 753.9B
  ["aidendle94/glm-5.2-mxfp4-experts-gptq", "753B"], // zai-org/GLM-5.2 = 753.3B
  ["thinkingmachines/inkling-small-nvfp4", "266B"], // thinkingmachines/Inkling-Small = 266.0B
  ["nvidia/kimi-k2.6-nvfp4", "1027B"], // moonshotai/Kimi-K2.6 = 1026.9B
  ["quanttrio/minimax-m2-awq", "229B"], // MiniMaxAI/MiniMax-M2 = 228.7B
  ["cyankiwi/minimax-m2.1-awq-4bit", "229B"], // MiniMaxAI/MiniMax-M2.1 = 228.7B
  ["quanttrio/minimax-m2.5-awq", "229B"], // MiniMaxAI/MiniMax-M2.5 = 228.7B
  ["cyankiwi/minimax-m2.5-awq-4bit", "229B"], // MiniMaxAI/MiniMax-M2.5 = 228.7B
  ["intel/minimax-m2.5-int4-autoround", "229B"], // MiniMaxAI/MiniMax-M2.5 = 228.7B
  ["nvidia/minimax-m2.5-nvfp4", "229B"], // MiniMaxAI/MiniMax-M2.5 = 228.7B
  ["cyankiwi/minimax-m2.7-awq-4bit", "229B"], // MiniMaxAI/MiniMax-M2.7 = 228.7B
  ["olka-fi/minimax-m2.7-mxfp4", "229B"], // MiniMaxAI/MiniMax-M2.7 = 228.7B
  ["lukealonso/minimax-m2.7-nvfp4", "229B"], // MiniMaxAI/MiniMax-M2.7 = 228.7B
  ["minimaxai/minimax-m3-mxfp8", "427B"], // MiniMaxAI/MiniMax-M3 = 427.0B
  ["nvidia/minimax-m3-nvfp4", "427B"], // MiniMaxAI/MiniMax-M3 = 427.0B
  ["sparkarena/minimax-m3-v0-nvfp4", "427B"], // MiniMaxAI/MiniMax-M3 = 427.0B
  ["coherelabs/north-mini-code-1.0-fp8", "30B"], // CohereLabs/North-Mini-Code-1.0 = 30.5B
  ["xanunetworks/north-mini-code-1.0-nvfp4", "30B"], // CohereLabs/North-Mini-Code-1.0 = 30.5B
  ["qwen/qwen3-coder-next-fp8", "80B"], // Qwen/Qwen3-Coder-Next-FP8 = 79.7B
  ["intel/qwen3-coder-next-int4-autoround", "80B"], // Qwen/Qwen3-Coder-Next = 79.7B
  ["saricles/qwen3-coder-next-nvfp4-gb10", "80B"], // Qwen/Qwen3-Coder-Next = 79.7B
  ["arcee-ai/trinity-large-thinking-nvfp4", "399B"], // arcee-ai/Trinity-Large-Thinking = 398.6B
  // The "162B" in this repo's name is not its parameter count: the repo stores
  // 92.2B elements in unpacked dtypes (BF16/F8_E4M3/I8), and 162B of FP8
  // weights could not fit the single 128GB node it was benchmarked on. It is a
  // community-pruned derivative of deepseek-ai/DeepSeek-V4-Flash (284B), so it
  // stays a distinct model rather than being merged into it.
  ["0xsero/deepseek-v4-flash-162b", "92B"]
]);

function inferParams(name: string, repoPath: string): string {
  const known = knownParamsByRepo.get(repoPath.toLowerCase());
  if (known) return known;
  // Prefer a "35B-A3B"-style total/active pair, then any standalone "NNB".
  const total = name.match(/(\d+(?:\.\d+)?)\s*B(?:-A\d)/i) ?? name.match(/\b(\d+(?:\.\d+)?)\s*B\b/i);
  if (total) return `${total[1]}B`;
  const millions = name.match(/\b(\d+(?:\.\d+)?)\s*M\b/i);
  if (millions) return `${millions[1]}M`;
  return "unknown";
}

function inferActiveParams(name: string): string | undefined {
  const match = name.match(/\bA(\d+(?:\.\d+)?)\s*B\b/i);
  return match ? `${match[1]}B` : undefined;
}

// True weight formats -- what the tensors are actually stored as. Longest first
// so "nvfp4" wins over "fp4" and "bfloat16" over "bf16"; order is search order,
// not a preference rank.
const weightFormatTokens = [
  "bfloat16",
  "float16",
  "nvfp4",
  "mxfp8",
  "mxfp4",
  "w4a16",
  "int8",
  "int4",
  "fp16",
  "fp8",
  "fp4",
  "bf16"
];

// Quantization *methods*, kept separate from the formats above. Plenty of repos
// name only the method ("MiniMax-M2.5-AWQ"), so these still have to resolve a
// quant when nothing else does -- ten repos in the current snapshot depend on
// that. What they must never do is join a hybrid: GLM-5.2-MXFP4-Experts-GPTQ is
// MXFP4 weights produced with GPTQ, not an "mxfp4-gptq" format that exists
// nowhere, and the submitter labels it MXFP4 too.
const quantMethodTokens = ["awq", "gptq"];

/**
 * All weight formats the repo name states, in the order they appear in the
 * name. Returning every match rather than the first one matters for hybrid
 * checkpoints: `Qwen3.5-122B-A10B-int4-fp8-hybrid` really does store two
 * formats, and collapsing it to whichever token happens to sit earliest in the
 * preference array would advertise it as plain `int4` and let comparison logic
 * treat it as the same quantization as a non-hybrid int4 build.
 */
export function weightFormatsFromRepo(repoPath: string): string[] {
  // Match against the repo *name* only: an org like "Intel" or a base-model
  // path segment must not be read as a weight format.
  const name = repoPath.split("/").pop()?.toLowerCase().replace(/_/g, "-") ?? "";
  const tokensIn = (tokens: string[]) => {
    const found: Array<{ token: string; index: number }> = [];
    for (const token of tokens) {
      // The boundaries keep a longer token from also matching a shorter one it
      // contains -- "nvfp4" never registers as "fp4", "mxfp8" never as "fp8".
      const match = name.match(new RegExp(`(^|[^a-z0-9])(${token})([^a-z0-9]|$)`));
      if (match) found.push({ token, index: match.index ?? 0 });
    }
    return found.sort((left, right) => left.index - right.index).map((item) => item.token);
  };

  const formats = tokensIn(weightFormatTokens);
  if (formats.length > 0) return formats;
  // No real format named, so fall back to the method label -- one only, since a
  // method is a single answer to "how were these weights made", never a hybrid.
  return tokensIn(quantMethodTokens).slice(0, 1);
}

/**
 * The leaderboard's `quantization` field is free text typed by the submitter,
 * and it lands in the result id, the dedup key, and the schema's uniqueness
 * key -- so a wrong value invents a configuration that does not exist. Two
 * real failures in the current snapshot:
 *
 *   - lukealonso/MiniMax-M2.7-NVFP4 is labelled "BFLOAT16", which would offer
 *     an NVFP4 checkpoint as a bfloat16 option.
 *   - Intel/Qwen3.5-122B-A10B-int4-AutoRound appears as both "INT4" and
 *     "AUTO-ROUND", splitting one configuration into a phantom quant
 *     comparison between two unrelated submissions.
 *
 * The repo name is the stronger signal because it is published by whoever
 * built the weights, so it wins whenever it names a format. "AutoRound" and
 * friends are quantization *methods* rather than formats and are deliberately
 * not in the token list -- they resolve to the format the repo also states.
 */
export function quantFromEntry(meta: SnapshotEntry): string {
  const fromRepo = weightFormatsFromRepo(meta.modelFullPath);
  if (fromRepo.length > 0) return fromRepo.join("-");
  return slugify(meta.quantization || "unknown", 40);
}

// Name segments that describe how the weights were stored rather than which
// model they are: the formats themselves, the bit-width qualifiers that trail
// them ("4bit"), the methods used to produce them ("AutoRound", "GPTQ"), and
// the words that mark a mixed checkpoint. Only ever applied to a name that
// actually carries a weight-format token, so a plain size or variant segment
// is never mistaken for one of these.
const quantOnlyNameSegments = new Set([
  ...weightFormatTokens,
  ...quantMethodTokens,
  "autoround",
  "prismaquant",
  "gguf",
  "quantized",
  "quant",
  "hybrid",
  "mixed",
  "experts",
  "w4a4",
  "w8a8",
  // Serving stacks sometimes appear in a checkpoint name. Runtime is its own
  // catalog axis, so leaving these in would split one model per serving stack.
  "vllm",
  "sglang",
  "sgl",
  "trtllm",
  // The accelerator a build was tuned for is hardware, which is also its own
  // axis -- and every row here runs on GB10, so the tag distinguishes nothing.
  // Without this, saricles/Qwen3-Coder-Next-NVFP4-GB10 sits apart from the
  // qwen3-coder-next base model that has rows on twenty other machines.
  "gb10"
]);

/** "4bit", "8bit", "4.75bit" -- a bit-width qualifier, never a model name. */
const bitWidthSegment = /^\d+(?:\.\d+)?bit$/;

function isQuantOrRuntimeSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  return quantOnlyNameSegments.has(lower) || bitWidthSegment.test(lower);
}

/**
 * Strips weight-format decoration from a checkpoint name so the model id names
 * the model rather than the build. `result.quant` already carries the format,
 * so leaving it in the id makes `MiniMax-M2.5-AWQ` and `MiniMax-M2.5-AWQ-4bit`
 * two different models that can never be compared against each other, and
 * turns FP8-vs-NVFP4 into a cross-model comparison instead of the same-model
 * quant comparison it actually is.
 *
 * Deliberately conservative: a name with no format token is returned untouched,
 * so a size or derivative marker survives. `DeepSeek-V4-Flash-162B` therefore
 * stays distinct from the 284B `DeepSeek-V4-Flash` it was pruned from.
 */
export function canonicalModelName(name: string): string {
  const segments = name.split(/[-\s_]+/).filter(Boolean);
  // Gate on the name actually carrying quant or runtime decoration. Stripping
  // unconditionally would let a segment that merely shares a word with the list
  // be eaten out of a name that never described a build in the first place.
  if (!segments.some(isQuantOrRuntimeSegment)) return name;
  const kept = segments.filter((segment) => !isQuantOrRuntimeSegment(segment));
  return kept.length > 0 ? kept.join("-") : name;
}

export function modelFromEntry(meta: SnapshotEntry): ModelMetadata {
  const rawName = meta.modelName?.trim() || meta.modelFullPath.split("/").pop() || meta.modelFullPath;
  const name = canonicalModelName(rawName);
  // Parameter counts are still read from the *raw* name: "A10B" and "122B" are
  // size facts that canonicalisation must not be able to eat.
  const activeParams = inferActiveParams(rawName);
  return {
    id: slugify(name, 64),
    name,
    family: inferFamily(name),
    params: inferParams(rawName, meta.modelFullPath),
    ...(activeParams ? { activeParams } : {}),
    license: "See upstream model card",
    notes: `${generatedNotePrefix} Model metadata inferred from the upstream repo path ${meta.modelFullPath}.`
  };
}

/**
 * Folds a hand-authored model record into the inferred one.
 *
 * The safety gates are only as good as the parameter count they are given, and
 * inference from a display name frequently yields "unknown" -- `DeepSeek-V4-Flash`
 * names no size, so the memory gate had nothing to check and admitted a 284B
 * model as FP8 on two 128GB nodes. When a curated record for the same id already
 * exists in the repo it is the better source, so it wins outright; a previously
 * generated record only fills gaps.
 */
/**
 * The provenance note for a generated model record. One canonical id can be
 * reached from several publisher repos once the weight format stops being part
 * of the identity -- `minimax-m2.5` is built by four of them -- so naming a
 * single repo would assert something false about the other three. Each result
 * row still records its own exact `upstream_model_path`.
 */
export function modelNoteFor(upstreamPaths: string[]): string {
  const paths = [...new Set(upstreamPaths)].sort();
  if (paths.length <= 1) {
    return `${generatedNotePrefix} Model metadata inferred from the upstream repo path ${paths[0] ?? "unknown"}.`;
  }
  return `${generatedNotePrefix} One record per base checkpoint: the quantized builds behind it are ${paths.join(", ")}. Model metadata is inferred from those repo paths; each result row records the exact build it measured.`;
}

export function resolveModelMetadata(inferred: ModelMetadata, existing: ModelMetadata | undefined): ModelMetadata {
  if (!existing) return inferred;
  const isHandAuthored = !existing.notes?.startsWith(generatedNotePrefix);
  if (isHandAuthored) return existing;
  const activeParams = inferred.activeParams ?? existing.activeParams;
  return {
    ...inferred,
    params: inferred.params !== "unknown" ? inferred.params : existing.params,
    ...(activeParams ? { activeParams } : {})
  };
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

/**
 * Drops files this parser owns that the current snapshot no longer produces,
 * so the catalog stays a reproducible view of the cached snapshot rather than
 * the union of every historical import. Without this, a submission that has
 * disappeared upstream -- or that now fails the sweep, roofline, or memory
 * gate -- keeps its row forever.
 */
function removeGeneratedJsonFiles(dir: string, keepIds: Set<string>, owned: (value: ExistingJson) => boolean) {
  let removed = 0;
  for (const [id, { filePath, value }] of readJsonFiles<ExistingJson>(dir)) {
    if (keepIds.has(id) || !owned(value)) continue;
    fs.unlinkSync(filePath);
    removed += 1;
  }
  return removed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let snapshot: SnapshotCache;
  const rawLogs = new Map<string, RawLogRecord>();

  if (args.skipFetch) {
    if (!fs.existsSync(snapshotPath)) throw new Error(`Missing cached snapshot: ${snapshotPath}`);
    snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as SnapshotCache;
    if (fs.existsSync(rawLogsPath)) {
      for (const line of fs.readFileSync(rawLogsPath, "utf8").split(/\n/).filter(Boolean)) {
        const record = JSON.parse(line) as RawLogRecord;
        rawLogs.set(record.benchmarkId, record);
      }
    }
  } else {
    console.log(`Fetching Spark Arena snapshot from ${snapshotIndexUrl}`);
    snapshot = await fetchSnapshot(args);
    fs.mkdirSync(rawDir, { recursive: true });
    writeJson(snapshotPath, snapshot);
  }

  // Read the canonical model records before filtering, not after: the roofline
  // and memory gates are the only thing standing between an impossible upstream
  // claim and the catalog, and they need the best parameter count available
  // rather than whatever could be guessed from a display name.
  const canonicalModels = readJsonFiles<ModelMetadata & ExistingJson>(modelDir);
  const resolveModel = (meta: SnapshotEntry): ModelMetadata => {
    const inferred = modelFromEntry(meta);
    return resolveModelMetadata(inferred, canonicalModels.get(inferred.id)?.value);
  };

  const candidates = buildCandidates(snapshot);
  const usable = new Map<string, { candidate: Candidate; sweep: UsableSweep; model: ModelMetadata }>();
  const skipped = { clusterSize: 0, sweep: 0, roofline: 0, memory: 0 };
  for (const candidate of candidates.values()) {
    if (!hardwareIdByClusterSize.has(candidate.meta.clusterSize)) {
      skipped.clusterSize += 1;
      continue;
    }
    const sweep = usableSweep(candidate);
    if (!sweep) {
      skipped.sweep += 1;
      continue;
    }
    const candidateModel = resolveModel(candidate.meta);
    const candidateQuant = quantFromEntry(candidate.meta);
    if (exceedsRoofline(candidateModel, candidate.meta.clusterSize, Math.max(...sweep.prefill))) {
      console.warn(
        `skipping ${candidate.benchmarkId} (${candidate.meta.modelFullPath}, ${candidate.meta.runtime}): peak prefill ${Math.max(...sweep.prefill).toFixed(0)} t/s exceeds the GB10 roofline for ${candidate.meta.clusterSize} node(s)`
      );
      skipped.roofline += 1;
      continue;
    }
    if (exceedsMemory(candidateModel, candidateQuant, candidate.meta.clusterSize)) {
      console.warn(
        `skipping ${candidate.benchmarkId} (${candidate.meta.modelFullPath}, ${candidateQuant}): ${candidateModel.params} of weights cannot fit ${candidate.meta.clusterSize} node(s)`
      );
      skipped.memory += 1;
      continue;
    }
    usable.set(candidate.benchmarkId, { candidate, sweep, model: candidateModel });
  }

  // One row per (hardware, model, quant, runtime): the result id is built from
  // exactly those four fields, so two submissions sharing them would collide.
  // Prefer the longest sweep, then the most recent submission.
  const groups = new Map<string, { candidate: Candidate; sweep: UsableSweep; model: ModelMetadata }>();
  for (const item of usable.values()) {
    const key = [
      hardwareIdByClusterSize.get(item.candidate.meta.clusterSize),
      item.model.id,
      quantFromEntry(item.candidate.meta),
      slugify(item.candidate.meta.runtime || "unknown", 40)
    ].join("|");
    const current = groups.get(key);
    if (
      !current ||
      item.sweep.depths.length > current.sweep.depths.length ||
      (item.sweep.depths.length === current.sweep.depths.length &&
        item.candidate.meta.submittedAt > current.candidate.meta.submittedAt)
    ) {
      groups.set(key, item);
    }
  }

  if (!args.skipFetch) {
    console.log(`Fetching ${groups.size} raw llama-benchy logs`);
    const records: RawLogRecord[] = [];
    for (const item of groups.values()) {
      const url = rawLogUrl(item.candidate.benchmarkId);
      const text = await fetchText(url, args);
      records.push({ benchmarkId: item.candidate.benchmarkId, url, text });
      rawLogs.set(item.candidate.benchmarkId, { benchmarkId: item.candidate.benchmarkId, url, text });
      await sleep(args.delayMs);
    }
    records.sort((left, right) => left.benchmarkId.localeCompare(right.benchmarkId));
    fs.writeFileSync(rawLogsPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  }

  // An offline rebuild retrieved nothing, so it must not restamp evidence with
  // "now" -- that would both falsify the provenance date and turn a no-op
  // regeneration into a diff touching every row.
  const previousMeta = fs.existsSync(metaPath)
    ? (JSON.parse(fs.readFileSync(metaPath, "utf8")) as { retrievedAt?: string })
    : undefined;
  // Falling back to "now" here would let an offline rebuild claim freshly
  // retrieved provenance for a snapshot it never fetched -- the cached
  // snapshot and raw logs can both be present, so the import would otherwise
  // succeed with a retrievedAt that never happened.
  if (args.skipFetch && !previousMeta?.retrievedAt) {
    throw new Error(
      `--skip-fetch needs a cached retrieval timestamp in ${path.relative(root, metaPath)}, but none is recorded. ` +
        "An offline rebuild retrieved nothing and must not stamp evidence with the current time; run once without --skip-fetch first."
    );
  }
  const retrievedAt = args.skipFetch ? (previousMeta?.retrievedAt as string) : new Date().toISOString();

  const hardwareItems = new Map<string, HardwareConfig>();
  const modelItems = new Map<string, ModelMetadata>();
  const upstreamPathsByModel = new Map<string, Set<string>>();
  const results: Array<Record<string, unknown>> = [];
  let crossChecked = 0;
  const crossCheckFailures: string[] = [];

  for (const { candidate, sweep, model } of groups.values()) {
    const hardwareId = hardwareIdByClusterSize.get(candidate.meta.clusterSize) as string;
    const quant = quantFromEntry(candidate.meta);
    const runtimeSlug = slugify(candidate.meta.runtime || "unknown", 40);
    const raw = rawLogs.get(candidate.benchmarkId);
    const parsedRaw = raw ? parseRawLog(raw.text) : new Map<string, { mean: number; stddev?: number }>();

    const overheadMs = clientOverheadMs(candidate, sweep.depths);

    const generated = generatedHardware.get(hardwareId);
    if (generated) hardwareItems.set(hardwareId, generated);
    // One model id can be reachable from several publisher repos, and
    // knownParamsByRepo is keyed on the repo -- so whichever submission wrote
    // last would decide whether the model has a real parameter count or
    // "unknown". An unknown count prunes every row of that model out of the
    // product, so prefer a resolved one regardless of iteration order.
    const existingModel = modelItems.get(model.id);
    if (!existingModel || (existingModel.params === "unknown" && model.params !== "unknown")) {
      modelItems.set(model.id, model);
    }
    // Canonical ids mean one model record can be reached from several publisher
    // repos, so the note must not claim whichever one happened to write last is
    // *the* source. Collect them all and state them honestly below.
    const paths = upstreamPathsByModel.get(model.id) ?? new Set<string>();
    paths.add(candidate.meta.modelFullPath);
    upstreamPathsByModel.set(model.id, paths);

    const measurements: BenchmarkMeasurement[] = sweep.depths.map((depth, index) => {
      const prefillRaw = parsedRaw.get(testNameFor(prefillTestPrefix, depth));
      const decodeRaw = parsedRaw.get(testNameFor(decodeTestPrefix, depth));
      // The snapshot value is the leaderboard's own aggregate. It is checked
      // against the raw log and only the log's stddev is carried over -- the
      // measurement itself always stays the published number so the row
      // matches what the leaderboard shows.
      //
      // Every selected value must be checkable. A row advertises
      // evidence.rawUrl as its provenance, so a value the raw log does not
      // confirm (parser regression, missing cached log, genuine upstream
      // disagreement) must fail the import rather than ship as raw-backed.
      for (const [label, rawValue, snapshotValue] of [
        [testNameFor(prefillTestPrefix, depth), prefillRaw?.mean, sweep.prefill[index]],
        [testNameFor(decodeTestPrefix, depth), decodeRaw?.mean, sweep.decode[index]]
      ] as Array<[string, number | undefined, number]>) {
        if (rawValue === undefined) {
          crossCheckFailures.push(`${candidate.benchmarkId} ${label}: no value in raw log`);
          continue;
        }
        crossChecked += 1;
        if (Math.abs(rawValue - snapshotValue) / Math.max(snapshotValue, 1e-9) > 0.001) {
          crossCheckFailures.push(`${candidate.benchmarkId} ${label}: raw ${rawValue} != snapshot ${snapshotValue}`);
        }
      }

      return {
        depth,
        pp: sweep.prefill[index],
        tg: sweep.decode[index],
        ppLabel: testNameFor(prefillTestPrefix, depth),
        tgLabel: testNameFor(decodeTestPrefix, depth),
        ...(prefillRaw?.stddev === undefined ? {} : { ppStddev: prefillRaw.stddev }),
        ...(decodeRaw?.stddev === undefined ? {} : { tgStddev: decodeRaw.stddev })
      };
    });

    results.push({
      id: `${hardwareId}__${model.id}__${quant}__${runtimeSlug}`,
      hardware: hardwareId,
      model: model.id,
      quant,
      runtime: {
        name: candidate.meta.runtime || "unknown",
        version: candidate.meta.recipeType ? `spark-arena-${candidate.meta.recipeType}` : "spark-arena",
        backend: candidate.meta.clusterSize > 1 ? "CUDA (multi-node)" : "CUDA",
        // cache is the catalog-wide default rather than a per-submission
        // measurement -- Spark Arena publishes no cache field and the raw
        // llama-benchy logs record none, so this matches what every other row
        // and importer in the repo does. The row notes disclose that.
        // The submission id belongs to the evidence, not to the runtime.
        // runtimeKey() hashes the whole flags string, so putting a unique id in
        // here gave every row its own runtime: 82 keys for seven real
        // name/backend/recipe stacks, which collapsed Race's runtime-first flow
        // into "pick a runtime, get exactly one submission". It stays available
        // on evidence.upstreamId and in benchmark.metadata.
        flags: `llama-benchy ${prefillTestPrefix}/${decodeTestPrefix} c1`,
        cache: "prefix" as const
      },
      measurements,
      evidence: {
        rawUrl: rawLogUrl(candidate.benchmarkId),
        rawFormat: "llama-benchy raw benchmark log",
        retrievedAt,
        upstreamId: candidate.benchmarkId,
        parserVersion,
        upstreamUrls: [detailUrl(candidate.benchmarkId)]
      },
      benchmark: {
        tool: "llama-benchy",
        profile: candidate.meta.recipeType ?? "sparkrun",
        outputFormat: "Spark Arena leaderboard snapshot",
        latencyMode: "single-stream (c1)",
        ppTokens: 2048,
        tgTokens: 128,
        concurrency: 1,
        metadata: {
          spark_arena_cluster_size: candidate.meta.clusterSize,
          upstream_model_path: candidate.meta.modelFullPath,
          upstream_quantization: candidate.meta.quantization,
          submitted_at: candidate.meta.submittedAt
        }
      },
      topology: {
        nodeCount: candidate.meta.clusterSize,
        acceleratorCount: candidate.meta.clusterSize,
        ...(candidate.meta.clusterSize > 1
          ? { interconnect: "QSFP / ConnectX-7", distributedRuntime: candidate.meta.runtime }
          : {})
      },
      source: {
        kind: "llama-benchy" as const,
        title: `Spark Arena ${model.name} on ${candidate.meta.clusterSize}x DGX Spark`,
        url: detailUrl(candidate.benchmarkId),
        raw: rawLogUrl(candidate.benchmarkId),
        notes: `Community Spark Arena submission ${candidate.benchmarkId}. Cluster size is leaderboard metadata, not recorded in the raw log.`
      },
      submitter: "Spark Arena",
      date: candidate.meta.submittedAt.slice(0, 10),
      status: "community" as const,
      ...(overheadMs === undefined ? {} : { overheadMs }),
      notes: `${generatedNotePrefix} Single-stream (c1) ${prefillTestPrefix}/${decodeTestPrefix} sweep; higher-concurrency Spark Arena tests are intentionally not imported. Prompt-cache mode is the catalog-wide "prefix" default, not a measured property of this submission: Spark Arena publishes no cache field and the raw log records none.`
    });
  }

  if (crossCheckFailures.length > 0) {
    // Fail before writing: every row claims evidence.rawUrl as its provenance,
    // so shipping a value the raw log does not confirm would misrepresent it.
    console.error(`${crossCheckFailures.length} value(s) could not be confirmed against their raw log:`);
    for (const failure of crossCheckFailures.slice(0, 20)) console.error(`  ${failure}`);
    if (crossCheckFailures.length > 20) console.error(`  ...and ${crossCheckFailures.length - 20} more`);
    throw new Error("Raw-log cross-check failed; no rows were written.");
  }

  const existingHardware = readJsonFiles<HardwareConfig & ExistingJson>(hardwareDir);
  const existingModels = readJsonFiles<ModelMetadata & ExistingJson>(modelDir);

  let writtenHardware = 0;
  for (const hardware of hardwareItems.values()) {
    const current = existingHardware.get(hardware.id);
    // Never clobber a hand-authored definition.
    if (current && !current.value.notes?.startsWith(generatedNotePrefix)) continue;
    writeJson(path.join(hardwareDir, `${hardware.id}.json`), hardware);
    writtenHardware += 1;
  }

  let writtenModels = 0;
  for (const model of modelItems.values()) {
    const current = existingModels.get(model.id);
    if (current && !current.value.notes?.startsWith(generatedNotePrefix)) continue;
    const notes = modelNoteFor([...(upstreamPathsByModel.get(model.id) ?? [])]);
    writeJson(path.join(modelDir, `${model.id}.json`), { ...model, notes });
    writtenModels += 1;
  }

  // Sweep before writing, and only over rows still owned by this parser: a row
  // hand-reviewed to verified/flagged that has since dropped out of the import
  // set must survive, because the per-row guard below only protects rows that
  // are still in the current set.
  const removedResults = removeGeneratedJsonFiles(
    resultDir,
    new Set(results.map((result) => result.id as string)),
    isOwnedByThisParser
  );

  // Overwrite only what this parser demonstrably owns. Treating a missing
  // parserVersion as "probably ours" is what let a refresh replace three
  // hand-authored community rows -- the repo reserves "verified" for
  // maintainer-reproduced data, so an ordinary curated correction legitimately
  // stays "community" and has no parser marker at all. Absence of proof of
  // ownership is not proof of ownership.
  const existingResults = readJsonFiles<ExistingJson>(resultDir);
  let writtenResults = 0;
  let preservedResults = 0;
  for (const result of results) {
    const id = result.id as string;
    const current = existingResults.get(id);
    if (current && !isOwnedByThisParser(current.value)) {
      const reason =
        current.value.status !== "community"
          ? `status is "${current.value.status}"`
          : `evidence.parserVersion is ${current.value.evidence?.parserVersion ? `"${current.value.evidence.parserVersion}"` : "absent"}`;
      console.warn(`skipping ${id}: ${reason}, not overwriting data this importer does not own`);
      preservedResults += 1;
      continue;
    }
    writeJson(path.join(resultDir, `${id}.json`), result);
    writtenResults += 1;
  }

  // Canonicalisation orphans a generated model file whenever its last row goes
  // away. Sweep those, but key the keep-set off the rows that actually survived
  // on disk rather than off this run's groups: a reviewed row that dropped out
  // of the import set still references its model, and deleting it underneath
  // would leave a dangling reference. Hand-authored models are never swept.
  const referencedModelIds = new Set<string>();
  const referencedHardwareIds = new Set<string>();
  for (const { value } of readJsonFiles<ExistingJson & { model?: string; hardware?: string }>(resultDir).values()) {
    if (value.model) referencedModelIds.add(value.model);
    if (value.hardware) referencedHardwareIds.add(value.hardware);
  }
  const isGenerated = (value: ExistingJson) => Boolean(value.notes?.startsWith(generatedNotePrefix));
  const removedModels = removeGeneratedJsonFiles(modelDir, referencedModelIds, isGenerated);
  // Hardware needs the same cleanup: a cluster definition this importer created
  // for a submission that has since dropped out would otherwise linger and
  // inflate the hardware count on Landing with a machine no row uses.
  const removedHardware = removeGeneratedJsonFiles(hardwareDir, referencedHardwareIds, isGenerated);

  writeJson(metaPath, {
    source: leaderboardUrl,
    snapshotIndex: snapshotIndexUrl,
    snapshotTest: snapshotTestUrl,
    parserVersion,
    retrievedAt,
    snapshotGeneratedAt: snapshot.index.generatedAt,
    rawFiles: {
      snapshot: path.relative(root, snapshotPath),
      rawLogs: path.relative(root, rawLogsPath)
    },
    checksums: {
      snapshot: sha256File(snapshotPath),
      ...(fs.existsSync(rawLogsPath) ? { rawLogs: sha256File(rawLogsPath) } : {})
    },
    selection: {
      concurrency: concurrencyLabel,
      tests: `${prefillTestPrefix} / ${decodeTestPrefix}`,
      minSharedDepths,
      minMaxDepth,
      maxRateIncreaseRatio
    },
    generated: {
      candidates: candidates.size,
      skippedUnknownClusterSize: skipped.clusterSize,
      skippedUnusableSweep: skipped.sweep,
      skippedAboveRoofline: skipped.roofline,
      skippedAboveMemory: skipped.memory,
      results: results.length,
      resultsWritten: writtenResults,
      resultsPreservedNotOwned: preservedResults,
      staleResultsRemoved: removedResults,
      staleModelsRemoved: removedModels,
      staleHardwareRemoved: removedHardware,
      hardwareWritten: writtenHardware,
      modelsWritten: writtenModels
    },
    crossCheck: {
      valuesComparedAgainstRawLogs: crossChecked,
      mismatches: 0,
      note: "The import fails if any selected value is missing from or disagrees with its raw log."
    }
  });

  console.log(
    `Spark Arena import: ${writtenResults}/${results.length} results, ${writtenModels} models, ${writtenHardware} hardware entries written.`
  );
  console.log(
    `Removed ${removedResults} stale generated result(s), ${removedModels} orphaned generated model(s), and ${removedHardware} orphaned generated hardware entr(ies).`
  );
  if (preservedResults > 0) {
    console.log(`Preserved ${preservedResults} existing row(s) this importer does not own.`);
  }
  console.log(
    `Skipped ${skipped.sweep} submissions with an unusable sweep, ${skipped.roofline} above the GB10 roofline, ${skipped.memory} whose weights cannot fit, and ${skipped.clusterSize} with an unmapped cluster size.`
  );
  console.log(`Cross-checked ${crossChecked} values against raw logs; all confirmed.`);
}

// Only run when invoked directly, so the parser stays unit-testable.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
