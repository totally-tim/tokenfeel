# Tokenfeel (working title)

An open source, static web playground that lets you _feel_ what local LLM inference is like on hardware you don't own. Pick a hardware config, a model, a quant and a runtime, pick a real-world scenario, hit play, and watch a simulated session stream at exactly the speed the real thing would. Race two configs side by side to settle "should I buy the Spark or the Strix Halo" arguments with your eyes instead of a spreadsheet.

Other working names to consider: `tokfeel`, `feelthetokens`, `inference.gg`, `tokrace`.

---

## 1. Problem

Leaderboards like Spark Arena, BridgeBench and the Strix Halo Toolboxes benchmarks publish pp/tg numbers per model and quant. These are accurate but abstract. Nobody can intuit what "pp2048 = 1,850 t/s, tg128 = 21 t/s" feels like in an agentic coding loop where the context is 30k tokens by turn six. Buyers overweight decode speed and get blindsided by prefill on long contexts, or vice versa. The data exists; the _experience_ doesn't.

## 2. Core idea

Pure-math simulation from published benchmark numbers. No inference runs anywhere. The site takes measured prefill and decode rates (ideally at several context depths), feeds them through a timing model, and streams pre-written scenario text into the UI at the computed pace. Real time by default, honest to the millisecond.

The repo is the database. All hardware configs, benchmark results and scenario scripts live as JSON/Markdown in the repo. Community members submit results via pull request. GitHub Pages hosts the built site. Zero backend, zero hosting cost, zero ops.

## 3. Simulation engine

### 3.1 Inputs per (hardware, model, quant, runtime) result

- `pp`: prefill throughput in tok/s, ideally at multiple depths (e.g. pp512, pp2048, pp8192, pp16384)
- `tg`: decode throughput in tok/s, ideally at multiple depths (tg at d0, d4096, d8192, d16384...)
- Optional: fixed startup overhead per request (sampler init, etc.), defaults to a small constant

A single pp512/tg128 pair (the llama-bench default) is a valid minimum submission. Depth sweeps unlock the interesting behavior.

### 3.2 Timing model

For each generation request in a scenario:

```
TTFT      = new_prompt_tokens / pp(context_depth) + overhead
per-token = 1 / tg(current_context_depth)
```

- Rates between measured depths are linearly interpolated; beyond the last data point, extrapolate conservatively (flat or gentle decay, flagged in the UI as extrapolated).
- Context depth grows across turns: prior prompts + prior outputs + tool results.

### 3.2.1 Prompt caching (first-class, not a footnote)

Caching is half the "feel" difference between configs, so it gets modeled properly instead of a naive on/off:

- **Prefix cache hit**: only tokens after the longest cached prefix are prefilled. A clean append-only conversation prefills just the new user turn.
- **Cache bust events**: scenario scripts can include events that invalidate part of the cache (system prompt edit, context truncation/compaction, tool result reordering). Agent scenarios use these deliberately, because real agent harnesses bust their caches constantly and that's exactly the pain people don't see in tg numbers.
- **Runtime capability**: the result file declares cache behavior (`"cache": "prefix" | "none"`), since runtimes differ (llama.cpp prefix reuse, MLX prompt cache, vLLM APC). The simulator uses whatever the submitted runtime actually supports; the UI toggle then lets you override to compare hypotheticals.
- **UI**: during playback the context meter shows cached vs. re-prefilled tokens per turn in two colors, and the finish breakdown reports "tokens prefilled total vs. tokens that would have been prefilled without cache." That one number is the education.

Default: cache on, honest to the runtime's real capability.

### 3.3 What is NOT modeled (v1)

Batching, speculative decoding, KV quantization effects beyond what's baked into the submitted numbers, thermal throttling over long sessions, network latency. Listed on a "what this simulates" page so nobody accuses the site of lying.

## 4. Scenarios

A scenario is a **script**: an ordered list of events with fixed token counts. The text is display-only; the token counts are the ground truth. Identical script = fair comparison.

```jsonc
// scenarios/chatbot-trip-planning/script.json
{
  "id": "chatbot-trip-planning",
  "type": "chatbot",
  "turns": [
    { "role": "user", "text": "...", "tokens": 42 },
    { "role": "assistant", "text": "...", "tokens": 380 },
    { "role": "user", "text": "...", "tokens": 28 },
    ...
  ],
  "system_prompt_tokens": 850
}
```

Event types beyond plain turns: `tool_call` (agent emits N tokens of call, then a `tool_result` of M tokens gets injected and prefilled, with a configurable simulated tool latency), `thinking` (reasoning tokens streamed in a collapsed/dimmed block before the visible answer), `cache_bust` (invalidates the KV cache from a given token position, e.g. simulating context compaction in an agent harness).

### v1 scenario set (per your ranking)

1. **Chatbot**: 6-turn conversation, growing context, ~300-500 output tokens per turn. The "is this pleasant to talk to" test.
2. **Agentic coding loop**: system prompt ~4k tokens, 8-12 tool calls with chunky results (file reads of 1-3k tokens), short generations between. This is where prefill and cache behavior dominate and where cheap decode-optimized configs fall apart. The most eye-opening scenario.
3. **Reasoning**: single question, 1,500-3,000 thinking tokens before a 400-token answer. Watching a config grind through thinking at 12 t/s says more than any benchmark table.
4. **Long-context RAG** (v1.1): 32k tokens of documents prefilled, then Q&amp;A turns.

### Determinism vs. variety

Default: one canonical script per scenario, so any two runs anywhere are comparable and shareable. Each scenario can have alternate scripts ("variant B, C..."), selectable explicitly or via a shuffle button. In race mode, both lanes always run the same script. Variants keep the same _shape_ (similar total prefill/decode token budget) so timings stay roughly comparable across variants, but only same-script comparisons are canonical.

## 5. Race mode (the killer feature)

Two configs side by side, same script, started simultaneously.

- Live per-lane stats: elapsed time, current phase (prefilling 3,240 tokens... / generating), instantaneous tok/s, context size meter
- TTFT markers and per-turn split times, like a speedrun comparison
- Finish banner: total wall time, delta, and a one-line breakdown ("Config B spent 71% of its time in prefill")
- Fast-forward (2x/4x/8x), clearly labeled, because a full agent loop on a slow config can take 10+ real minutes. Default is 1x since real time is the whole point
- **Shareable URLs**: full race config encoded in query params. This is the virality mechanism; every "which box should I buy" Reddit thread ends with a race link
- Later: embeddable iframe widget for reviewers and blogs

Three-plus lanes: nice to have, not v1.

## 6. Data model (repo as database)

```
/data
  /hardware/          # one file per hardware config
    dgx-spark.json
    strix-halo-128gb.json
    m3-ultra-256gb.json
  /models/            # model metadata: params, family, license
    deepseek-v4-flash.json
    llama-4-scout.json
  /results/           # the benchmark numbers, the actual submissions
    dgx-spark__deepseek-v4-flash__q4km__llamacpp-vulkan.json
/scenarios
  /chatbot-trip-planning/
  /agent-bugfix/
  /reasoning-math/
```

Result file:

```jsonc
{
  "hardware": "dgx-spark",
  "model": "deepseek-v4-flash",
  "quant": "Q4_K_M",
  "runtime": { "name": "llama.cpp", "version": "b4832", "backend": "CUDA", "flags": "-fa on", "cache": "prefix" },
  "measurements": [
    { "depth": 0, "pp": 1842.3, "tg": 24.1 },
    { "depth": 8192, "pp": 1610.0, "tg": 19.8 },
    { "depth": 16384, "pp": 1385.2, "tg": 16.4 }
  ],
  "source": {
    "kind": "llama-bench", // llama-bench | llama-benchy | writeup | leaderboard
    "url": "https://...", // link to raw output, forum post or leaderboard entry
    "raw": "attached in PR"
  },
  "submitter": "github-handle",
  "date": "2026-07-04",
  "status": "community" // community | verified | flagged
}
```

Schema validated with zod in CI. CI also runs plausibility checks (pp/tg within sane bounds for the hardware class, monotonic-ish depth degradation) and fails loudly with a human-readable message so contributors can self-serve.

## 7. Verification: trust + flagging

- Every submission ships with a source link and ideally raw benchmark output pasted in the PR (template enforces this)
- Default status: **community**. Shown normally, badged as community-reported
- **Verified** badge: maintainer reproduced it, or it comes verbatim from an established leaderboard (Spark Arena, Strix Halo Toolboxes) with attribution
- **Flagged**: anyone opens a GitHub issue via a "report this result" link on the config page; flagged results get a warning badge until resolved
- No accounts, no moderation backend. GitHub handles identity, discussion and history

## 8. Frontend

- TypeScript, Vite, React (or Svelte if you feel like it; nothing here needs React specifically), Tailwind
- Fully static, data bundled at build time, deployed to GitHub Pages via Actions on merge
- Streaming renderer driven by `requestAnimationFrame` against a precomputed event timeline, so playback stays accurate even under tab throttling (compute the schedule once, render against wall clock, never `setInterval` per token)
- Config picker: hardware → model → quant → runtime, only showing combos that have data; "request this combo" deep-links to a prefilled GitHub issue
- Stats overlay during playback: phase indicator, live tok/s, context meter, cache on/off toggle
- Mobile-friendly; race mode stacks vertically on small screens

## 9. Contribution flow

1. Run llama-bench (or llama-benchy) with the documented flags, ideally with depth sweeps: a copy-paste command per runtime lives in CONTRIBUTING.md
2. A tiny converter script (`npx tokenfeel-convert bench-output.json`) turns raw output into a result file
3. Open PR with the result file + raw output pasted into the PR template
4. CI validates schema and plausibility, builds a preview
5. Merge → auto-deploy

Low friction is the whole game. If step 1-3 takes more than five minutes, the data flywheel never starts.

## 10. Seeding

Three platforms are mandatory at launch, since they're the actual buying decision people are agonizing over:

- **DGX Spark**: import Spark Arena results (llama-benchy based) with attribution, plus first-party numbers from your own two units, including the TP=2 DeepSeek V4 Flash setup
- **Apple Silicon via MLX** (and llama.cpp/Metal for contrast): wide variety, not just one halo chip. Target at minimum M1 Max, M2/M3 Pro-class, M3/M4 Max, M3 Ultra, so people can find "the Mac I actually own" as a baseline before comparing against purchase candidates. r/LocalLLaMA and the mlx-lm repo discussions are full of usable numbers
- **Strix Halo**: Strix Halo Toolboxes depth-sweep benchmarks, both ROCm and Vulkan backends since they diverge

Target for launch: 8-10 hardware configs x 3-4 models each. The Mac variety does double duty as the "relatable baseline" that makes the exotic boxes interpretable.

## 11. Roadmap

- **v1**: chatbot + agent scenarios, race mode (2 lanes), cache toggle, shareable URLs, PR pipeline, seeded data
- **v1.1**: reasoning scenario, RAG scenario, scenario variants/shuffle
- **v1.2**: embeddable widget, "time to complete" summary cards on config pages (so the leaderboard view shows _seconds for the agent scenario_ instead of tok/s)
- **v2**: custom scenario builder (define your own token budget shape), batch/concurrency modeling if the community submits the data for it, energy cost per scenario (watts x time) since people love the tokens-per-joule angle

## 12. Open questions

- Name and domain
- Whether verified imports from external leaderboards should sync automatically (scheduled Action that opens PRs) or stay manual
- License: MIT for code is obvious; data probably CC-BY so leaderboards can reuse it back
- Whether tool-call latency in the agent scenario should be zero (pure inference comparison) or realistic (~200-800ms), probably a toggle defaulting to zero
