import { z } from "zod";
import { runtimeKey } from "../lib/configMatrix";

const idSchema = z.string().min(2).regex(/^[a-z0-9][a-z0-9._-]*$/);
const isoDateTimeSchema = z.string().datetime({ offset: true });
const metadataSchema = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]));

export const hardwareSchema = z.object({
  id: idSchema,
  name: z.string().min(2),
  shortName: z.string().min(2),
  vendor: z.string().min(2),
  memory: z.string().min(2),
  accelerator: z.string().min(2),
  notes: z.string().min(2)
});

export const modelSchema = z.object({
  id: idSchema,
  name: z.string().min(2),
  family: z.string().min(2),
  params: z.string().min(1),
  activeParams: z.string().optional(),
  license: z.string().min(2),
  notes: z.string().min(2)
});

export const measurementSourceSchema = z
  .object({
    url: z.string().url(),
    upstreamId: z.string().min(1),
    createdAt: isoDateTimeSchema.optional(),
    ttftMs: z.number().nonnegative().optional(),
    peakMemoryGb: z.number().positive().optional()
  })
  .strict();

export const measurementSchema = z.object({
  depth: z.number().int().nonnegative(),
  pp: z.number().positive(),
  tg: z.number().positive(),
  ppLabel: z.string().optional(),
  tgLabel: z.string().optional(),
  ppStddev: z.number().nonnegative().optional(),
  tgStddev: z.number().nonnegative().optional(),
  source: measurementSourceSchema.optional()
});

export const runtimeSchema = z.object({
  name: z.string().min(2),
  version: z.string().min(1),
  backend: z.string().min(2),
  flags: z.string(),
  cache: z.enum(["prefix", "none"])
});

export const benchmarkEvidenceSchema = z
  .object({
    rawUrl: z.string().url().optional(),
    rawFormat: z.string().min(2).optional(),
    checksum: z.string().min(3).optional(),
    retrievedAt: isoDateTimeSchema.optional(),
    upstreamId: z.string().min(1).optional(),
    parserVersion: z.string().min(1).optional(),
    rawRows: z.array(z.string()).optional(),
    upstreamUrls: z.array(z.string().url()).optional(),
    archiveUrl: z.string().url().optional()
  })
  .strict();

export const benchmarkMetadataSchema = z
  .object({
    metadata: metadataSchema.optional(),
    tool: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    profile: z.string().min(1).optional(),
    runs: z.number().int().positive().optional(),
    warmup: z.number().int().nonnegative().optional(),
    outputFormat: z.string().min(1).optional(),
    tokenizer: z.string().min(1).optional(),
    ppTokens: z.number().int().positive().optional(),
    tgTokens: z.number().int().positive().optional(),
    concurrency: z.number().int().positive().optional(),
    latencyMode: z.string().min(1).optional()
  })
  .strict();

export const topologySchema = z
  .object({
    nodeCount: z.number().int().positive().optional(),
    acceleratorCount: z.number().int().positive().optional(),
    interconnect: z.string().min(1).optional(),
    distributedRuntime: z.string().min(1).optional(),
    tensorParallel: z.number().int().positive().optional(),
    containerImage: z.string().min(1).optional(),
    os: z.string().min(1).optional(),
    kernel: z.string().min(1).optional(),
    driver: z.string().min(1).optional(),
    cuda: z.string().min(1).optional(),
    runtimeVersions: z.record(z.string().min(1)).optional()
  })
  .strict();

export const resultSchema = z.object({
  id: idSchema,
  hardware: idSchema,
  model: idSchema,
  quant: idSchema,
  runtime: runtimeSchema,
  measurements: z.array(measurementSchema).min(1),
  evidence: benchmarkEvidenceSchema.optional(),
  benchmark: benchmarkMetadataSchema.optional(),
  topology: topologySchema.optional(),
  source: z.object({
    kind: z.enum([
      "llama-bench",
      "llama-benchy",
      "writeup",
      "leaderboard",
      "raw-json",
      "community-benchmark"
    ]),
    title: z.string().min(5),
    url: z.string().url(),
    raw: z.string().optional(),
    license: z.string().optional(),
    notes: z.string().optional()
  }),
  submitter: z.string().min(2),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(["community", "verified", "flagged", "illustrative"]),
  overheadMs: z.number().nonnegative().optional(),
  notes: z.string().optional()
});

export const researchMetricSchema = z.object({
  name: idSchema,
  value: z.number().positive(),
  unit: z.string().min(2),
  scope: z.string().min(2).optional()
});

export const researchItemSchema = z.object({
  id: idSchema,
  category: z.enum(["serving-throughput", "benchmark-candidate"]),
  hardware: z.string().min(2),
  model: z.string().min(2),
  precision: z.string().min(2).optional(),
  runtime: z.string().min(2),
  workload: z.string().min(2),
  metrics: z.array(researchMetricSchema).min(1),
  source: z.object({
    title: z.string().min(5),
    url: z.string().url(),
    raw: z.string().url().optional(),
    notes: z.string().optional()
  }),
  importDecision: z.enum(["not-imported-to-simulator", "needs-serving-schema", "candidate"]),
  notes: z.string().min(2)
});

export const researchItemsSchema = z.array(researchItemSchema);

export const scenarioEventSchema = z.object({
  id: idSchema,
  role: z.enum(["user", "assistant", "tool_call", "tool_result", "thinking", "cache_bust"]),
  text: z.string(),
  tokens: z.number().int().nonnegative(),
  toolLatencyMs: z.number().nonnegative().optional(),
  cacheBust: z
    .object({
      retainedPrefixTokens: z.number().int().nonnegative(),
      reason: z.string().optional()
    })
    .optional()
});

export const scenarioSchema = z.object({
  id: idSchema,
  title: z.string().min(3),
  type: z.enum(["chatbot", "agent", "reasoning", "rag"]),
  systemPromptTokens: z.number().int().nonnegative(),
  description: z.string().optional(),
  events: z.array(scenarioEventSchema).min(1)
});

export const catalogSchema = z
  .object({
    hardware: z.array(hardwareSchema).min(1),
    models: z.array(modelSchema).min(1),
    results: z.array(resultSchema).min(1),
    scenarios: z.array(scenarioSchema).min(1)
  })
  .superRefine((catalog, ctx) => {
    function checkUniqueIds(items: Array<{ id: string }>, path: string) {
      const seen = new Set<string>();
      for (const item of items) {
        if (seen.has(item.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate id "${item.id}" in ${path}`,
            path: [path, item.id]
          });
        }
        seen.add(item.id);
      }
    }

    checkUniqueIds(catalog.hardware, "hardware");
    checkUniqueIds(catalog.models, "models");
    checkUniqueIds(catalog.results, "results");
    checkUniqueIds(catalog.scenarios, "scenarios");

    function checkUniqueConfigs(results: typeof catalog.results) {
      const seenByConfig = new Map<string, string>();
      for (const result of results) {
        const configKey = [result.hardware, result.model, result.quant, runtimeKey(result)].join("::");
        const firstId = seenByConfig.get(configKey);
        if (firstId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Result "${result.id}" is a true duplicate (same hardware, model, quant, and runtime config) of "${firstId}" -- resolve by hand, do not auto-pick a winner`,
            path: ["results", result.id, "runtimeKey"]
          });
        } else {
          seenByConfig.set(configKey, result.id);
        }
      }
    }

    checkUniqueConfigs(catalog.results);

    const hardwareIds = new Set(catalog.hardware.map((hardware) => hardware.id));
    const modelIds = new Set(catalog.models.map((model) => model.id));

    for (const result of catalog.results) {
      if (!hardwareIds.has(result.hardware)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown hardware "${result.hardware}" in ${result.id}`,
          path: ["results", result.id, "hardware"]
        });
      }

      if (!modelIds.has(result.model)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown model "${result.model}" in ${result.id}`,
          path: ["results", result.id, "model"]
        });
      }

      const sortedDepths = [...result.measurements].sort((a, b) => a.depth - b.depth);
      if (sortedDepths.some((point, index) => point.depth !== result.measurements[index].depth)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Measurements must be sorted by depth in ${result.id}`,
          path: ["results", result.id, "measurements"]
        });
      }

      const seenDepths = new Set<number>();
      for (const measurement of result.measurements) {
        if (seenDepths.has(measurement.depth)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate measurement depth ${measurement.depth} in ${result.id}`,
            path: ["results", result.id, "measurements"]
          });
        }
        seenDepths.add(measurement.depth);
      }

      const resultIdParts = result.id.split("__");
      if (
        resultIdParts.length !== 4 ||
        resultIdParts.some((part) => part.length === 0) ||
        resultIdParts[0] !== result.hardware ||
        resultIdParts[1] !== result.model ||
        resultIdParts[2] !== result.quant
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Result id "${result.id}" must use hardware__model__quant__runtime-ish shape matching hardware "${result.hardware}", model "${result.model}", and quant "${result.quant}"`,
          path: ["results", result.id, "id"]
        });
      }

      if (result.date > new Date().toISOString().slice(0, 10)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Result ${result.id} has a future date ${result.date}`,
          path: ["results", result.id, "date"]
        });
      }

      if (result.status === "verified" && !result.source.raw && !result.evidence?.rawUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Result ${result.id} is status "verified" but has no raw evidence (source.raw or evidence.rawUrl)`,
          path: ["results", result.id, "status"]
        });
      }
    }
  });

export type ParsedCatalog = z.infer<typeof catalogSchema>;
