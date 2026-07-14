# AGENTS.md - Tokenfeel

## Scope

These instructions apply to the entire repository.

Tokenfeel is a static React/Vite webapp and repo-backed benchmark catalog. It
does not run inference. It simulates how local LLM generation feels by applying
published or contributed prefill/decode benchmark data to fixed scenario scripts.

The central rule: protect the credibility of the data and the fidelity of the
simulation. A prettier UI is not an improvement if the benchmark source, timing
math, or comparison semantics become less honest.

## Project Map

- `src/pages/` contains route-level experiences:
  - `LandingPage.tsx`
  - `PlaygroundPage.tsx`
  - `RacePage.tsx`
  - `ConfigsPage.tsx`
  - `MethodPage.tsx`
  - `ContributePage.tsx`
- `src/components/` contains shared UI pieces such as navigation, status badges,
  simulator display, phase legend, and visualizations.
- `src/sim/timing.ts` owns simulation timeline math.
- `src/hooks/usePlayback.ts` owns wall-clock playback state.
- `src/lib/` contains pure helpers for catalog access, comparison quality,
  streaming, race output, routing, share URLs, phase progress, and quality checks.
- `src/data/schemas.ts` is the zod contract for repo data.
- `data/hardware/`, `data/models/`, and `data/results/` are the catalog source of
  truth.
- `scenarios/*/script.json` defines deterministic scripts used by Playground and
  Race.
- `scripts/build-static-catalog.ts` generates static catalog chunks under
  `public/catalog/`.
- `design.md` is the code-facing design-system source of truth.
- `mockup.pen` is the Pencil mockup source of truth. Inspect it with Pencil MCP
  only. Do not read or parse `.pen` files directly.
- `CONTRIBUTING.md` documents benchmark contribution expectations.

## Default Workflow

1. Start with `git status --short` so you know what is already dirty. Do not
   revert user changes unless explicitly asked.
2. Read the local context before editing: `package.json`, `design.md`, relevant
   page/component/helper files, relevant tests, and relevant data schemas.
3. Use `rg` or `rg --files` for search.
4. Keep edits scoped. Prefer improving the existing path over adding parallel
   legacy-compatible paths.
5. For non-trivial work in Codex, keep goal mode and a short plan updated.
6. Before file edits, state what you are about to change and why.
7. Verify with repo-native commands and browser checks before calling work done.

## Package And Dependency Rules

- Do not add or update JavaScript dependencies unless the existing stack cannot
  reasonably solve the task.
- Before any install/update, enforce the 48-hour package freshness guard:

  ```bash
  npm config set min-release-age=2
  ```

  (npm's unit is whole days, not a duration string — `2d` is silently dropped
  as an invalid config value and the gate runs unset. Verify with
  `npm config get before`; `npm config get min-release-age` always reads back
  `null`.)

- Do not lower or bypass the age gate. If a package is too new, report the
  conflict.
- Prefer existing dependencies, especially React, Vite, Vitest, zod, Tailwind,
  and `lucide-react`.
- Use `npm --userconfig=/dev/null ...` for local repo scripts when avoiding
  machine-level npm config surprises is useful.

## Commands

Use these commands from the repo root:

```bash
npm --userconfig=/dev/null run validate:data
npm --userconfig=/dev/null run test
npm --userconfig=/dev/null run build
npm --userconfig=/dev/null run dev -- --port <free-port>
```

Additional scripts:

```bash
npm --userconfig=/dev/null run prune:data
npm --userconfig=/dev/null run convert:llama-bench -- <args>
npm --userconfig=/dev/null run import:omlx
```

Run `validate:data` whenever catalog data, scenarios, schemas, import scripts,
or quality logic changes. Run `test` and `build` for any non-trivial code or UI
change.

## Browser And Visual Verification

Visual e2e is mandatory for UI work and strongly preferred for simulation work.

- Start a dev server on a free port. If an existing port serves stale output,
  start a fresh server on a new port and report the URL.
- Use the in-app browser when available. Playwright-driven visual checks are
  acceptable and expected.
- Check at least:
  - Landing
  - Playground
  - Race
  - Configs
- For substantial UI work, verify desktop and narrow/mobile widths.
- Check for console errors, horizontal overflow, text overlap, layout shift, and
  stale generated assets.
- For Race, actually start playback. Verify Start/Stop behavior, central race
  clock, lane phase display, transcript/streaming visibility, completion state,
  and share URL behavior.
- For Playground, verify prefill and decode phases look and feel distinct.
- For Configs, verify filters/tables/graphs remain usable with the full catalog.

## Cross-Model Review

Before calling non-trivial work complete, run Claude adversarial review with the
headless CLI:

```bash
claude -p "Adversarially review the changes in this Tokenfeel repo. Read and run the relevant tests/build. Be skeptical about data provenance, simulation timing, UI regressions, and unhappy paths. List concrete bugs by severity."
```

Be patient. Do not abort a slow but running review. Resolve real findings and
rerun after fix rounds. If Claude is unavailable, report that as a verification
gap.

## Data Catalog Rules

Catalog data is product logic. Treat every row as a claim.

- Never invent benchmark numbers.
- Every `data/results/*.json` file must have source-backed provenance.
- Result IDs must follow the `hardware__model__quant__runtime-ish` shape and the
  third segment must match `quant`.
- Keep `measurements` sorted by `depth` with no duplicate depths.
- Keep source URLs public when possible.
- Preserve raw evidence through `source.raw`, `evidence.rawRows`,
  `evidence.rawUrl`, `evidence.upstreamUrls`, or attached artifacts.
- Capture benchmark metadata when available: tool, version/commit, command,
  profile, runs, warmup, pp/tg token sizes, concurrency, latency mode, tokenizer.
- Capture topology when available: node count, accelerator count, interconnect,
  tensor parallelism, distributed runtime, container, OS, driver, CUDA/runtime
  versions.
- Use `community` for normal submissions, `verified` only when maintainer
  reproduced it or imported it verbatim from a trusted source, `flagged` for
  disputed rows, and `illustrative` for synthetic/demo rows.
- Distinguish model identity from runtime behavior. For example, speculative
  decoding modules, server flags, cache behavior, and distributed topology usually
  belong in runtime/benchmark/topology metadata, not as a fake separate model.
- If a comparison is confounded by quant, runtime, benchmark version, context
  profile, concurrency, or topology, label it honestly in UI and notes.

## Importing Online Results

When adding externally sourced configs/results:

1. Browse the current source. Do not rely on memory for unstable benchmark claims.
2. Prefer primary sources: raw benchmark output, model cards, official docs,
   maintainer forum posts, leaderboard rows with raw evidence, or repo artifacts.
3. Capture exact values and units. Be explicit about whether values are pp, tg,
   TTFT, end-to-end time, concurrency throughput, or single-stream speed.
4. Record caveats in `notes` when the data is not apples-to-apples.
5. Add tests if the new data exposes a schema, quality, or comparison edge case.
6. Run `validate:data`, `test`, and `build`.
7. Cite the sources in the final response.

## Pruning Data

Do not delete catalog rows just because they look odd. Prune only when there is a
clear reason:

- The row is duplicate or superseded by a better-sourced equivalent.
- The source is missing, inaccessible, or contradicts the row.
- The row fails schema/quality checks and cannot be repaired from evidence.
- The model/hardware/runtime identity is clearly wrong.
- The row is synthetic or illustrative but appears in product surfaces as real
  benchmark data.
- The row harms comparison UX because it is not meaningfully usable and lacks
  provenance to improve it.

When pruning, prefer small batches with a written rationale, run
`validate:data`, and verify Configs/Race still expose useful choices.

## Simulation Rules

The simulator must make benchmark timing understandable without pretending to be
live inference.

- `src/sim/timing.ts` is the authoritative timing model.
- Use prefill rate (`pp`) for prompt/tool-result processing and decode rate
  (`tg`) for assistant, thinking, and tool-call token generation.
- Preserve context growth across scenario events.
- Preserve cache semantics:
  - runtime cache mode comes from `result.runtime.cache`
  - scenario `cacheBust` events can reduce the retained prefix
  - cache overrides must be explicit in UI
- Do not show projected/fake elapsed time as final elapsed time.
- A lane only gets a final elapsed time when its timeline completes.
- If TTFT source data is present, use it carefully and test depth semantics.
  Some benchmark tools report TTFT for `depth + ppTokens`, not plain `depth`.
- Use `requestAnimationFrame`/wall-clock driven playback. Do not model streaming
  with fragile token-by-token intervals that drift under tab throttling.
- Thinking tokens should stream according to decode timing, not appear in large
  jumps unless the simulated speed actually implies that.
- Tool latency is scenario data, not a benchmark property.

Add focused tests for timing changes. Important existing areas include
`src/sim/timing.test.ts`, `src/lib/phaseProgress.test.ts`,
`src/lib/streaming.test.ts`, `src/lib/raceSession.test.ts`, and
`src/lib/catalogQuality.test.ts`.

## Scenario Rules

- Scenarios are deterministic. Race lanes must run the same script.
- Token counts are ground truth; display text is illustrative.
- Use realistic token budgets for the target workload. Avoid tiny scripts that
  hide prefill, cache, and long-context behavior.
- Keep roles within the schema: `user`, `assistant`, `tool_call`,
  `tool_result`, `thinking`, and `cache_bust`.
- Agent scenarios should include large tool results and cache-bust patterns when
  the purpose is to reveal real agent-loop cost.
- Reasoning scenarios should include visible thinking tokens when comparing
  reasoning-heavy workloads.

## UI And Design Rules

Follow `design.md` unless the user explicitly changes the design direction.
Tokenfeel should feel platform-neutral and native-inspired: quiet glass surfaces,
source-list rails, toolbar commands, segmented controls, popovers/sheets for
secondary tasks, restrained shadows, and high readability.

- Do not make copy Mac-only. Tokenfeel compares all kinds of configurations.
- Converge to one design system in `src/styles.css`; avoid one-off visual
  overrides and stale visual patterns.
- Use `lucide-react` icons where an icon is useful.
- Prefer compact controls, clear labels, and dense but readable workbench layouts.
- Do not add decorative orbs, bokeh blobs, card clutter, or marketing-style hero
  compositions to app workspaces.
- Do not put cards inside cards.
- Do not use visible instructional text to explain ordinary UI controls.
- Use responsive constraints so text, buttons, picker popovers, transcript blocks,
  graphs, and lane panels do not overlap or shift unexpectedly.
- Search/picker popovers must not push the whole app sideways or create
  horizontal overflow.
- Keep accessibility basics intact: buttons are buttons, focus states are visible,
  labels describe controls, and color is not the only state indicator.

## Race Page Rules

Race is the most important product surface. Be especially strict here.

- Keep a single page-level share command. Do not reintroduce duplicate bottom
  share/result banners.
- Do not reintroduce persistent bottom result banners.
- Start should become Stop while the race is active. Stop resets the race to the
  beginning.
- Do not show a green Restart button as the active-running control.
- The central race clock counts up while the race is active.
- A lane shows elapsed time only after that lane completes.
- Unfinished lanes should use their main area for useful live state: current
  phase, throughput, prefill/decode/tool-wait progress, transcript, thinking, or
  diagnostics.
- Avoid making `Running` or `Finished` badges the dominant visual element.
- Progressive disclosure in config selection should let users start from model,
  hardware, runtime, or quant.
- Prefer apples-to-apples suggestions: same model, similar runtime, comparable
  quant, different hardware. Dissimilar comparisons must remain possible but
  should not be the default suggestion path.
- If a pair is confounded, say so. Use labels such as configuration comparison or
  related comparison instead of overstating a clean runtime/hardware race.

## Configs Page Rules

- Configs is an index view, not a raw dump.
- Filters, search, summary surfaces, charts, and table rows must remain usable
  with the full catalog.
- Graphs must have readable axes, labels, and density. If a graph cannot support
  the data volume, replace it with a more useful view instead of shrinking marks
  until it becomes decorative.
- Source links and trust/status badges should stay close to the data they explain.
- If data pruning or quality warnings change counts, verify summaries and filters.

## Playground Rules

- Playground should make one configuration feel inspectable.
- Prefill, decode, thinking, and tool wait must be visually distinct.
- Transcript readability matters more than decorative panels.
- Diagnostics should be compact and useful: cache ledger, phase map, depth curve,
  source/provenance, and timing breakdown.
- Progress bars must represent the active phase accurately. Do not use full-run
  progress where the label claims phase progress.

## Styling Rules

- Keep most visual system work in `src/styles.css`.
- Use stable dimensions for toolbars, segmented controls, picker panels, graphs,
  lane headers, transcript rows, and progress bars.
- Do not scale font sizes with viewport width.
- Letter spacing should remain `0` for normal text; small mono labels may use
  positive spacing sparingly.
- Keep palettes balanced and restrained. Avoid letting the app collapse into a
  single hue theme.
- Text must fit inside its parent at desktop and mobile widths.

## Code Rules

- Prefer pure helpers in `src/lib/` for logic that can be tested without the DOM.
- Keep React pages focused on composition and state orchestration.
- Use zod schemas and typed data contracts instead of ad hoc string parsing.
- Add abstractions only when they remove real duplication or clarify a boundary.
- Add succinct comments only where the code is non-obvious.
- Keep files ASCII unless the existing file clearly uses non-ASCII for a reason.
- Do not log emojis or decorative symbols.
- Do not hand-edit generated files under `public/catalog/`, `dist/`, or
  `tsconfig.tsbuildinfo`.

## Testing Guidance

Use focused tests for the behavior you change:

- Data/schema changes: `src/data/schema.test.ts`, `src/data/staticCatalog.test.ts`,
  `src/lib/catalogQuality.test.ts`.
- Timing/playback changes: `src/sim/timing.test.ts`,
  `src/lib/phaseProgress.test.ts`, `src/lib/streaming.test.ts`,
  `src/lib/raceSession.test.ts`.
- Selection/comparison changes: `src/lib/configMatrix.test.ts`,
  `src/lib/pickerOptions.test.ts`, `src/lib/raceComparison.test.ts`,
  `src/lib/raceShare.test.ts`.
- Contribution flow changes: `src/lib/contributionAgentPrompt.test.ts`.

For UI-only changes, browser verification is still required even when unit tests
do not change.

## Final Response Checklist

When finishing work, report:

- Review findings or residual risks first.
- Key implementation changes.
- Files changed.
- Exact commands run and whether they passed.
- Browser/dev-server URL if one is running.
- Source links if external data was used.
- Any verification gaps, especially if Claude or browser checks could not run.

Do not push, merge, open PRs, label issues, or post public comments unless the
user explicitly asks.
