#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resultSchema } from "../src/data/schemas";
import type { BenchmarkMeasurement, BenchmarkResult } from "../src/types";

interface ParsedArgs {
  inputPath?: string;
  outputPath?: string;
  force: boolean;
  flags: Record<string, string>;
}

interface RawMetric {
  kind: "pp" | "tg";
  depth: number;
  tokens?: number;
  value: number;
  stddev?: number;
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
    [--flags "..."] [--cache prefix|none] [--output data/results/file.json] [--force]

The converter parses pp*/tg* rows into sorted depth measurements and preserves raw rows under evidence.rawRows.
--force is required to overwrite an existing --output file.`;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { flags: {}, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--output") {
      args.outputPath = argv[index + 1];
      index += 1;
    } else if (item === "--force") {
      args.force = true;
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

function metricFromLabel(label: string, value: number, raw: string, stddev?: number): RawMetric | undefined {
  const metricMatch = label.match(/\b(pp|tg)\s*[-_ ]?(\d+)?/i);
  if (!metricMatch) return undefined;
  return {
    kind: metricMatch[1].toLowerCase() as "pp" | "tg",
    depth: inferDepth(label),
    tokens: metricMatch[2] ? Number(metricMatch[2]) : undefined,
    value,
    stddev,
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
    // Only accept string values for the label candidates -- a non-string
    // field (e.g. a nested object in a malformed export) must not silently
    // stringify to "[object Object]" and pass as a label.
    const label =
      [record.test, record.name, record.label, record.benchmark].find(
        (candidate): candidate is string => typeof candidate === "string"
      ) ?? "";
    const metricValue =
      asNumber(record.tps) ??
      asNumber(record["t/s"]) ??
      asNumber(record.tokens_per_second) ??
      asNumber(record.avg_ts) ??
      asNumber(record.value);
    // llama-bench's own JSON output emits a stddev alongside each avg_ts row
    // (e.g. `stddev_ts`); other exporters use looser naming, so check a few.
    const metricStddev =
      asNumber(record.stddev_ts) ??
      asNumber(record.ts_stddev) ??
      asNumber(record.tps_stddev) ??
      asNumber(record.stddev);

    if (label && metricValue !== undefined) {
      const metric = metricFromLabel(label, metricValue, JSON.stringify(record), metricStddev);
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

      // llama-bench's real markdown output emits the value cell as
      // "<avg> ± <stddev>" (e.g. "3234.20 ± 12.34 t/s"); pull both numbers
      // from whichever cell carries them rather than only the last bare
      // number, so submitted stddev survives the text-format conversion.
      const valueCells = candidates
        .map((cell) => ({
          cell,
          withStddev: cell.match(/(\d+(?:,\d{3})*(?:\.\d+)?)\s*±\s*(\d+(?:,\d{3})*(?:\.\d+)?)/),
          plain: cell.match(/(?:^|\s)(\d+(?:,\d{3})*(?:\.\d+)?)(?:\s*(?:t\/s|tok\/s))?(?:\s|$)/i)
        }))
        .filter((entry) => entry.withStddev || entry.plain);
      // An "<avg> ± <stddev>" cell is an unambiguous measurement signal, so it
      // wins over any trailing bare number (e.g. a thread-count or run-count
      // column after the value cell) even if it isn't the last matching cell.
      const stddevCells = valueCells.filter((entry) => entry.withStddev);
      const selectedCell = stddevCells.length > 0 ? stddevCells.at(-1) : valueCells.at(-1);

      const value = selectedCell ? asNumber(selectedCell.withStddev?.[1] ?? selectedCell.plain?.[1]) : undefined;
      const stddev = selectedCell?.withStddev ? asNumber(selectedCell.withStddev[2]) : undefined;

      const metric = value !== undefined ? metricFromLabel(label, value, line, stddev) : undefined;
      return metric ? [metric] : [];
    });
}

export function parseLlamaBenchMeasurements(text: string): { measurements: BenchmarkMeasurement[]; rawRows: string[] } {
  let metrics: RawMetric[];
  try {
    metrics = parseJsonMetrics(JSON.parse(text));
  } catch {
    metrics = parseTextMetrics(text);
  }

  const byDepth = new Map<number, Partial<BenchmarkMeasurement> & { rawRows: string[] }>();
  for (const metric of metrics) {
    const item = byDepth.get(metric.depth) ?? { depth: metric.depth, rawRows: [] };
    item[metric.kind] = metric.value;
    item[`${metric.kind}Label`] = metric.tokens
      ? `${metric.kind}${metric.tokens}${metric.depth ? ` @ d${metric.depth}` : ""}`
      : metric.label;
    item[`${metric.kind}Stddev`] = metric.stddev;
    item.rawRows.push(metric.raw);
    byDepth.set(metric.depth, item);
  }

  const measurements = [...byDepth.values()]
    .filter(
      (item): item is BenchmarkMeasurement & { rawRows: string[] } => item.pp !== undefined && item.tg !== undefined
    )
    .sort((left, right) => left.depth - right.depth)
    .map(({ rawRows: _rawRows, ...measurement }) => measurement);

  return {
    measurements,
    rawRows: metrics.map((metric) => metric.raw)
  };
}

function runtimeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
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

  const validated = resultSchema.safeParse(result);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Built result failed schema validation: ${issues}`);
  }

  const output = `${JSON.stringify(result, null, 2)}\n`;

  if (args.outputPath) {
    if (!args.force && fs.existsSync(args.outputPath)) {
      throw new Error(`Refusing to overwrite existing file ${args.outputPath} without --force`);
    }
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
