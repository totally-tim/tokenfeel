export type CacheMode = "runtime" | "on" | "off";

/**
 * Confidence tier for a rate/time estimate at a given depth, from most to
 * least trustworthy:
 * - "measured": an exact submitted benchmark depth.
 * - "interpolated": strictly between two measured depths.
 * - "extrapolated-fitted": past the last measured depth, with >= 2
 *   measurements so a least-squares trend line can be fit and extrapolated
 *   forward.
 * - "extrapolated-unsupported": beyond the measured range with no fit
 *   applied — either only a single submitted measurement exists, or the
 *   depth is before the first measured point (a trend is never run backward
 *   across an unmeasured gap, regardless of how many measurements exist
 *   elsewhere) — only a flat guess either way.
 */
export type RateConfidence =
  | "measured"
  | "interpolated"
  | "extrapolated-fitted"
  | "extrapolated-unsupported";

export type ResultStatus = "community" | "verified" | "flagged" | "illustrative";

export type SourceKind =
  | "llama-bench"
  | "llama-benchy"
  | "writeup"
  | "leaderboard"
  | "raw-json"
  | "community-benchmark";

export interface HardwareConfig {
  id: string;
  name: string;
  shortName: string;
  vendor: string;
  memory: string;
  accelerator: string;
  notes: string;
}

export interface ModelMetadata {
  id: string;
  name: string;
  family: string;
  params: string;
  activeParams?: string;
  license: string;
  notes: string;
}

export interface RuntimeMetadata {
  name: string;
  version: string;
  backend: string;
  flags: string;
  cache: "prefix" | "none";
}

export type BenchmarkMetadataValue = string | number | boolean | null;

export interface BenchmarkEvidence {
  rawUrl?: string;
  rawFormat?: string;
  checksum?: string;
  retrievedAt?: string;
  upstreamId?: string;
  parserVersion?: string;
  rawRows?: string[];
  upstreamUrls?: string[];
  archiveUrl?: string;
}

export interface BenchmarkMetadata {
  metadata?: Record<string, BenchmarkMetadataValue>;
  tool?: string;
  command?: string;
  profile?: string;
  runs?: number;
  warmup?: number;
  outputFormat?: string;
  tokenizer?: string;
  ppTokens?: number;
  tgTokens?: number;
  concurrency?: number;
  latencyMode?: string;
}

export interface BenchmarkTopology {
  nodeCount?: number;
  acceleratorCount?: number;
  interconnect?: string;
  distributedRuntime?: string;
  tensorParallel?: number;
  containerImage?: string;
  os?: string;
  kernel?: string;
  driver?: string;
  cuda?: string;
  runtimeVersions?: Record<string, string>;
}

export interface BenchmarkMeasurement {
  depth: number;
  pp: number;
  tg: number;
  ppLabel?: string;
  tgLabel?: string;
  ppStddev?: number;
  tgStddev?: number;
  source?: {
    url: string;
    upstreamId: string;
    createdAt?: string;
    ttftMs?: number;
    peakMemoryGb?: number;
  };
}

export interface BenchmarkSource {
  kind: SourceKind;
  title: string;
  url: string;
  raw?: string;
  license?: string;
  notes?: string;
}

export interface BenchmarkResult {
  id: string;
  hardware: string;
  model: string;
  quant: string;
  runtime: RuntimeMetadata;
  measurements: BenchmarkMeasurement[];
  evidence?: BenchmarkEvidence;
  benchmark?: BenchmarkMetadata;
  topology?: BenchmarkTopology;
  source: BenchmarkSource;
  submitter: string;
  date: string;
  status: ResultStatus;
  overheadMs?: number;
  notes?: string;
}

export type ScenarioType = "chatbot" | "agent" | "reasoning" | "rag";

export type ScenarioRole =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "thinking"
  | "cache_bust";

export interface CacheBust {
  retainedPrefixTokens: number;
  reason?: string;
}

export interface ScenarioEvent {
  id: string;
  role: ScenarioRole;
  text: string;
  tokens: number;
  toolLatencyMs?: number;
  cacheBust?: CacheBust;
}

export interface ScenarioScript {
  id: string;
  title: string;
  type: ScenarioType;
  systemPromptTokens: number;
  events: ScenarioEvent[];
  description?: string;
}

export interface Catalog {
  hardware: HardwareConfig[];
  models: ModelMetadata[];
  results: BenchmarkResult[];
  scenarios: ScenarioScript[];
}

export interface TimelineInput {
  result: BenchmarkResult;
  scenario: ScenarioScript;
  cacheMode: CacheMode;
  speed: number;
}

export interface TimelineEvent extends ScenarioEvent {
  index: number;
  phase: "prefill" | "tool_latency" | "decode" | "instant";
  toolLatencyMs: number;
  startMs: number;
  toolDoneMs: number;
  prefillMs: number;
  prefillDoneMs: number;
  decodeMs: number;
  endMs: number;
  ttftMs: number;
  contextBefore: number;
  contextAfter: number;
  cachedPrefixTokens: number;
  prefillTokens: number;
  withoutCachePrefillTokens: number;
  ppRate: number;
  tgRate: number;
  ppConfidence: RateConfidence;
  tgConfidence: RateConfidence;
  prefillRangeMs: { min: number; max: number };
  decodeRangeMs: { min: number; max: number };
  extrapolated: boolean;
}

export interface Timeline {
  result: BenchmarkResult;
  scenario: ScenarioScript;
  cacheMode: CacheMode;
  speed: number;
  events: TimelineEvent[];
  totalMs: number;
}

export interface TimelineSummary {
  wallTimeMs: number;
  totalTokens: number;
  generatedTokens: number;
  prefilledWithCache: number;
  prefilledWithoutCache: number;
  cacheSavedRatio: number;
  prefillMs: number;
  decodeMs: number;
  toolLatencyMs: number;
  extrapolatedEvents: number;
  avgDecodeTps: number;
}
