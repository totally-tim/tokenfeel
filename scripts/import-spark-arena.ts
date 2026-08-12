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
      notes:
        "Eight DGX Spark systems connected over QSFP for distributed vLLM inference. Cluster size is community-reported Spark Arena leaderboard metadata; the raw llama-benchy logs do not themselves record node count."
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

--skip-fetch rebuilds purely from the cached files in data/upstream/.`;
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
    const response = await fetch(url, { headers: { accept: "*/*" } });
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

function billionsFromParamLabel(label: string | undefined): number | undefined {
  if (!label) return undefined;
  const match = label.match(/^(\d+(?:\.\d+)?)\s*([BM])$/i);
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
export function exceedsMemory(model: ModelMetadata, quant: string, clusterSize: number): boolean {
  const totalBillions = billionsFromParamLabel(model.params);
  const bytesPerParam = bytesPerParamByFormat.get(quant);
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

// Weight formats, longest first so "nvfp4" wins over "fp4" and "bfloat16" over
// "bf16". Order within the array is the search order, not a preference rank.
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
  "bf16",
  "awq",
  "gptq"
];

function weightFormatFromRepo(repoPath: string): string | undefined {
  // Match against the repo *name* only: an org like "Intel" or a base-model
  // path segment must not be read as a weight format.
  const name = repoPath.split("/").pop()?.toLowerCase().replace(/_/g, "-") ?? "";
  return weightFormatTokens.find((token) => new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`).test(name));
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
  const fromRepo = weightFormatFromRepo(meta.modelFullPath);
  if (fromRepo) return fromRepo;
  return slugify(meta.quantization || "unknown", 40);
}

export function modelFromEntry(meta: SnapshotEntry): ModelMetadata {
  const name = meta.modelName?.trim() || meta.modelFullPath.split("/").pop() || meta.modelFullPath;
  const activeParams = inferActiveParams(name);
  return {
    id: slugify(name, 64),
    name,
    family: inferFamily(name),
    params: inferParams(name, meta.modelFullPath),
    ...(activeParams ? { activeParams } : {}),
    license: "See upstream model card",
    notes: `${generatedNotePrefix} Model metadata inferred from the upstream repo path ${meta.modelFullPath}.`
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

  const candidates = buildCandidates(snapshot);
  const usable = new Map<string, { candidate: Candidate; sweep: UsableSweep }>();
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
    const candidateModel = modelFromEntry(candidate.meta);
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
    usable.set(candidate.benchmarkId, { candidate, sweep });
  }

  // One row per (hardware, model, quant, runtime): the result id is built from
  // exactly those four fields, so two submissions sharing them would collide.
  // Prefer the longest sweep, then the most recent submission.
  const groups = new Map<string, { candidate: Candidate; sweep: UsableSweep }>();
  for (const item of usable.values()) {
    const model = modelFromEntry(item.candidate.meta);
    const key = [
      hardwareIdByClusterSize.get(item.candidate.meta.clusterSize),
      model.id,
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
  const retrievedAt = args.skipFetch && previousMeta?.retrievedAt ? previousMeta.retrievedAt : new Date().toISOString();

  const hardwareItems = new Map<string, HardwareConfig>();
  const modelItems = new Map<string, ModelMetadata>();
  const results: Array<Record<string, unknown>> = [];
  let crossChecked = 0;
  const crossCheckFailures: string[] = [];

  for (const { candidate, sweep } of groups.values()) {
    const hardwareId = hardwareIdByClusterSize.get(candidate.meta.clusterSize) as string;
    const model = modelFromEntry(candidate.meta);
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
        flags: `llama-benchy ${prefillTestPrefix}/${decodeTestPrefix} c1; Spark Arena submission ${candidate.benchmarkId}`,
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
      notes: `${generatedNotePrefix} Single-stream (c1) ${prefillTestPrefix}/${decodeTestPrefix} sweep; higher-concurrency Spark Arena tests are intentionally not imported.`
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
    writeJson(path.join(modelDir, `${model.id}.json`), model);
    writtenModels += 1;
  }

  for (const result of results) {
    writeJson(path.join(resultDir, `${result.id as string}.json`), result);
  }

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
    `Spark Arena import: ${results.length} results, ${writtenModels} models, ${writtenHardware} hardware entries written.`
  );
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
