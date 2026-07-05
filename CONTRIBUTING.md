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
