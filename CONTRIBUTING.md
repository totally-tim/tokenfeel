# Contributing Benchmark Results

Tokenfeel is a static app with the repository as the database. Submit benchmark data by pull request.

## Local Checks

```bash
npm ci
npm run validate:data
npm test
npm run build
```

## Minimum Result Evidence

Every `data/results/*.json` row needs:

- `id` in `hardware__model__quant__runtime` shape.
- Hardware, model, quant, runtime, backend, flags, and cache capability.
- Sorted `measurements` with positive `depth`, `pp`, and `tg`.
- A public `source.url`.
- Raw output through `source.raw`, `evidence.rawUrl`, or an attached PR artifact.
- Submitter, date, and `status: "community"` by default.

Use optional `evidence`, `benchmark`, and `topology` fields when available. They make a row easier to verify and easier to compare apples-to-apples.

## Recommended Benchmark Metadata

Capture these whenever possible:

- Benchmark tool, version or commit, exact command, output format, runs, warmup runs.
- pp/tg token sizes, measured depths, tokenizer, latency mode, concurrency.
- Node count, accelerator count, interconnect, tensor parallelism, container image.
- OS, kernel, driver, CUDA/runtime versions.
- Optional: `ppStddev`/`tgStddev` per measurement. `llama-bench` emits stddev
  alongside its throughput numbers, and the converter picks it up
  automatically when present. Supplying it widens the app's displayed
  uncertainty range to reflect that variance instead of leaving it at the
  default; it's never required.

## Confidence Tiers and Ranges

Every depth in a submission's curve is tagged with how well-supported its
rate is, from strongest to weakest:

1. **measured** — an exact submitted depth.
2. **interpolated** — between two measured depths.
3. **extrapolated-fitted** — beyond the last measured depth, with a trend
   fit from two or more submitted points.
4. **extrapolated-unsupported** — beyond the only measured point in a
   single-point submission, or before a submission's first measured depth no
   matter how many points it has (a trend is never fit backward across a
   wholly unmeasured gap); shown as "no depth data" rather than a trend.

The more of a run that falls in tiers 3 and 4, the more its displayed
wall-time range depends on curve shape rather than a single flat number, and
`ppStddev`/`tgStddev` widen it further on top of that. This is not always a
narrowing effect: a single-point submission stays flat-clamped past its one
point, so its range width comes only from stddev, while a two-or-more-point
submission gets a fitted trend for depths past the last measurement — if
that trend is genuinely degrading, the fitted estimate diverges from the
flat optimistic bound more the steeper the slope and the farther past the
last measured depth you go, which can make the range _wider_ than a
single-point submission's, not narrower. Submit enough depths to capture the
real shape of the curve; don't assume adding points automatically tightens
your result's range. Race mode compares those ranges, not point estimates —
if two configs' ranges overlap, it reports "too close to call from this
data" instead of forcing a winner.

## Trust Levels

- `community`: default for public submissions.
- `verified`: maintainer reproduced it or imported it from a trusted upstream with raw evidence.
- `flagged`: keep visible with warning while a dispute is open.
- `illustrative`: synthetic or demo-only rows; do not use for ranking claims.

## Converter

The converter is intentionally conservative:

```bash
npm run convert:llama-bench -- path/to/llama-bench-output.txt \
  --hardware dgx-spark \
  --model qwen3-coder-next \
  --quant int4 \
  --runtime vLLM \
  --backend CUDA \
  --version 0.9.2 \
  --source-url https://example.com/raw-log \
  --source-title "Raw llama-bench run" \
  --submitter github-handle \
  --output data/results/dgx-spark__qwen3-coder-next__int4__vllm.json
```

Review the generated result before opening a PR. The converter preserves raw rows under `evidence.rawRows`.
