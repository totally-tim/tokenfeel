#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchmarkMeasurement, BenchmarkResult } from "../src/types";

interface ParsedArgs {
  inputPath?: string;
  outputPath?: string;
  flags: Record<string, string>;
}

interface RawMetric {
  kind: "pp" | "tg";
  depth: number;
  tokens?: number;
  value: number;
  label: string;
  raw: string;
}

const requiredFlags = [
  "hardware",
  "model",
  "quant",
  "runtime",
  "backend",
  "version",
  "source-url",
  "source-title",
  "submitter"
];

function usage(): string {
  return `Usage:
  tokenfeel-convert <llama-bench-output> \\
    --hardware dgx-spark \\
    --model qwen3-coder-next \\
    --quant int4 \\
    --runtime vLLM \\
    --backend CUDA \\
    --version 0.9.2 \\
    --source-url https://example.com/raw-log \\
    --source-title "Raw llama-bench run" \\
    --submitter github-handle \\
    [--flags "..."] [--cache prefix|none] [--output data/results/file.json]

The converter parses pp*/tg* rows into sorted depth measurements and preserves raw rows under evidence.rawRows.`;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { flags: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--output") {
      args.outputPath = argv[index + 1];
      index += 1;
    } else if (item.startsWith("--")) {
      args.flags[item.slice(2)] = argv[index + 1] ?? "";
      index += 1;
    } else if (!args.inputPath) {
      args.inputPath = item;
    }
  }
  return args;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function inferDepth(label: string, fallback = 0): number {
  const depthMatch =
    label.match(/@\s*d(?:epth)?\s*=?\s*(\d+)/i) ??
    label.match(/\bd(?:epth)?\s*=?\s*(\d+)/i) ??
    label.match(/\bctx\s*=?\s*(\d+)/i);
  return depthMatch ? Number(depthMatch[1]) : fallback;
}

function metricFromLabel(label: string, value: number, raw: string): RawMetric | undefined {
  const metricMatch = label.match(/\b(pp|tg)\s*[-_ ]?(\d+)?/i);
  if (!metricMatch) return undefined;
  return {
    kind: metricMatch[1].toLowerCase() as "pp" | "tg",
    depth: inferDepth(label),
    tokens: metricMatch[2] ? Number(metricMatch[2]) : undefined,
    value,
    label: metricMatch[0],
    raw
  };
}

function parseJsonMetrics(input: unknown): RawMetric[] {
  const rows: RawMetric[] = [];

  function visit(value: unknown) {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;

    const record = value as Record<string, unknown>;
    const label = String(record.test ?? record.name ?? record.label ?? record.benchmark ?? "");
    const metricValue =
      asNumber(record.tps) ??
      asNumber(record["t/s"]) ??
      asNumber(record.tokens_per_second) ??
      asNumber(record.avg_ts) ??
      asNumber(record.value);

    if (label && metricValue) {
      const metric = metricFromLabel(label, metricValue, JSON.stringify(record));
      if (metric) {
        const depth = asNumber(record.depth) ?? asNumber(record.ctx) ?? inferDepth(label);
        rows.push({ ...metric, depth });
      }
    }

    for (const child of Object.values(record)) {
      if (child && typeof child === "object") visit(child);
    }
  }

  visit(input);
  return rows;
}

function parseTextMetrics(text: string): RawMetric[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\b(pp|tg)\s*[-_ ]?\d*/i.test(line))
    .flatMap((line) => {
      const cells = line
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean);
      const candidates = cells.length >= 2 ? cells : [line];
      const label = candidates.find((cell) => /\b(pp|tg)\s*[-_ ]?\d*/i.test(cell)) ?? line;
      const numericCells = candidates
        .map((cell) => cell.match(/(?:^|\s)(\d+(?:,\d{3})*(?:\.\d+)?)(?:\s*(?:t\/s|tok\/s))?(?:\s|$)/i)?.[1])
        .filter(Boolean);
      const value = asNumber(numericCells.at(-1));
      const metric = value ? metricFromLabel(label, value, line) : undefined;
      return metric ? [metric] : [];
    });
}

export function parseLlamaBenchMeasurements(text: string): { measurements: BenchmarkMeasurement[]; rawRows: string[] } {
  let metrics: RawMetric[] = [];
  try {
    metrics = parseJsonMetrics(JSON.parse(text));
  } catch {
    metrics = parseTextMetrics(text);
  }

  const byDepth = new Map<number, Partial<BenchmarkMeasurement> & { rawRows: string[] }>();
  for (const metric of metrics) {
    const item = byDepth.get(metric.depth) ?? { depth: metric.depth, rawRows: [] };
    item[metric.kind] = metric.value;
    item[`${metric.kind}Label` as "ppLabel" | "tgLabel"] = metric.tokens
      ? `${metric.kind}${metric.tokens}${metric.depth ? ` @ d${metric.depth}` : ""}`
      : metric.label;
    item.rawRows.push(metric.raw);
    byDepth.set(metric.depth, item);
  }

  const measurements = [...byDepth.values()]
    .filter((item): item is BenchmarkMeasurement & { rawRows: string[] } => Boolean(item.pp && item.tg))
    .sort((left, right) => left.depth - right.depth)
    .map(({ rawRows: _rawRows, ...measurement }) => measurement);

  return {
    measurements,
    rawRows: metrics.map((metric) => metric.raw)
  };
}

function runtimeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function buildResult(args: ParsedArgs, parsed: ReturnType<typeof parseLlamaBenchMeasurements>): BenchmarkResult {
  for (const flag of requiredFlags) {
    if (!args.flags[flag]) {
      throw new Error(`Missing --${flag}\n\n${usage()}`);
    }
  }

  if (parsed.measurements.length === 0) {
    throw new Error("No paired pp/tg measurements found in input");
  }

  const hardware = args.flags.hardware;
  const model = args.flags.model;
  const quant = args.flags.quant;
  const runtime = args.flags.runtime;
  const backend = args.flags.backend;
  const id = args.flags.id ?? `${hardware}__${model}__${quant}__${runtimeSlug(`${runtime}-${backend}`)}`;

  return {
    id,
    hardware,
    model,
    quant,
    runtime: {
      name: runtime,
      version: args.flags.version,
      backend,
      flags: args.flags.flags ?? "",
      cache: args.flags.cache === "none" ? "none" : "prefix"
    },
    measurements: parsed.measurements,
    evidence: {
      rawUrl: args.flags["raw-url"] ?? args.flags["source-url"],
      rawFormat: args.flags["raw-format"] ?? "llama-bench",
      retrievedAt: new Date().toISOString(),
      parserVersion: "tokenfeel-convert/1",
      rawRows: parsed.rawRows
    },
    benchmark: {
      tool: args.flags.tool ?? "llama-bench",
      command: args.flags.command,
      outputFormat: args.flags["raw-format"] ?? "text",
      ppTokens: parsed.measurements[0].ppLabel?.match(/pp(\d+)/)?.[1]
        ? Number(parsed.measurements[0].ppLabel?.match(/pp(\d+)/)?.[1])
        : undefined,
      tgTokens: parsed.measurements[0].tgLabel?.match(/tg(\d+)/)?.[1]
        ? Number(parsed.measurements[0].tgLabel?.match(/tg(\d+)/)?.[1])
        : undefined,
      runs: args.flags.runs ? Number(args.flags.runs) : undefined,
      warmup: args.flags.warmup ? Number(args.flags.warmup) : undefined
    },
    source: {
      kind: args.flags.kind === "llama-benchy" ? "llama-benchy" : "llama-bench",
      title: args.flags["source-title"],
      url: args.flags["source-url"],
      raw: args.flags["raw-url"] ? undefined : "preserved in evidence.rawRows"
    },
    submitter: args.flags.submitter,
    date: args.flags.date ?? new Date().toISOString().slice(0, 10),
    status: "community",
    overheadMs: args.flags["overhead-ms"] ? Number(args.flags["overhead-ms"]) : undefined
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.inputPath) {
    console.error(usage());
    process.exit(1);
  }

  const text = fs.readFileSync(args.inputPath, "utf8");
  const parsed = parseLlamaBenchMeasurements(text);
  const result = buildResult(args, parsed);
  const output = `${JSON.stringify(result, null, 2)}\n`;

  if (args.outputPath) {
    fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
    fs.writeFileSync(args.outputPath, output);
    console.log(`wrote ${args.outputPath}`);
    return;
  }

  process.stdout.write(output);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
