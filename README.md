# Tokenfeel

Tokenfeel is a static benchmark playground for comparing how local LLM
generation feels across hardware, model, quantization, runtime, and scenario
configurations.

It does not run inference. The app applies repo-backed benchmark data to fixed
scenario scripts, then plays the session back at the measured prefill and decode
speed. The point is to make benchmark numbers tangible: prompt prefill, thinking
tokens, tool waits, decode cadence, cache reuse, and race gaps are visible in
real time.

## What It Compares

- Hardware configurations such as DGX Spark, Strix Halo, Apple Silicon, and RTX.
- Model metadata and precision/quant variants.
- Runtime and backend choices such as oMLX, llama.cpp, vLLM, CUDA, Vulkan, MLX,
  and related serving modes.
- Deterministic workload scenarios:
  - chatbot conversation
  - agent bugfix loop
  - repo-wide refactor loop
  - reasoning-heavy question

## How It Works

The repository is the database:

```text
data/hardware/   hardware metadata
data/models/     model metadata
data/results/    benchmark rows with source evidence
scenarios/       deterministic scripted workloads
src/sim/         timing model
src/pages/       app routes
```

At dev/build time, `scripts/build-static-catalog.ts` validates the repo data and
generates a compact static catalog under `public/catalog/`. Generated catalog
files are intentionally ignored and rebuilt locally or in CI.

## Local Development

```bash
npm ci
npm run dev
```

Useful checks:

```bash
npm run validate:data
npm test
npm run build
```

The dev server binds to `127.0.0.1` by default. To choose a port:

```bash
npm run dev -- --port 4181
```

## Data Quality

Every result row should be source-backed. Prefer raw benchmark output, public
leaderboard rows with stable IDs, model cards, forum posts with exact commands,
or repo artifacts.

Result files should include:

- hardware, model, quant, runtime, backend, flags, and cache capability
- sorted depth measurements with `pp` and `tg`
- source URL and raw evidence
- benchmark metadata when available
- topology metadata when available
- conservative trust status: `community`, `verified`, `flagged`, or
  `illustrative`

Run this before opening a data PR:

```bash
npm run validate:data
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the benchmark submission flow.

## Importing Benchmark Data

The oMLX importer can fetch and convert upstream rows:

```bash
npm run import:omlx
```

The llama-bench converter can turn raw benchmark output into a result file:

```bash
npm run convert:llama-bench -- path/to/output.txt \
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

## Simulation Notes

- Prefill uses measured TTFT when available, otherwise
  `prompt_tokens / pp(depth)` plus overhead.
- Decode uses `1 / tg(depth)` per generated token.
- Prefix cache behavior is modeled from runtime capability and scenario
  cache-bust events.
- Race lanes run the same deterministic script.
- The UI should never treat projected time as final elapsed time.

## Public Release Notes

The checked-in data is intentionally auditable. The raw oMLX JSONL import is
kept because many result files cite it as raw provenance. Generated build output
and generated static catalog chunks are ignored.

## License

Source code is MIT licensed. Benchmark/catalog data and scenario scripts are not
covered by that blanket code license; see [LICENSE.md](LICENSE.md).
