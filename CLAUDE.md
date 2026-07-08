# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Also read AGENTS.md

`AGENTS.md` in the repo root is the detailed, authoritative rulebook for this project (data provenance rules, simulation rules, Race/Playground/Configs page rules, styling rules, testing guidance, final-response checklist). It applies to Claude Code as well — read it before non-trivial work. This file only summarizes commands and architecture so you can get oriented quickly; it does not replace AGENTS.md.

## What This Project Is

Tokenfeel is a static React/Vite webapp that simulates how local LLM inference *feels* across hardware/model/quant/runtime/scenario combinations. It does not run inference. It replays deterministic scenario scripts at the prefill/decode speed implied by repo-checked-in benchmark data. **The repository is the database** — `data/` holds the catalog, and the build generates a static JSON catalog from it.

The central rule (from AGENTS.md): protect the credibility of the data and the fidelity of the simulation. A prettier UI is not an improvement if benchmark provenance, timing math, or comparison semantics become less honest.

## Commands

Always run npm through the user-config-free invocation to avoid machine-level npm config surprises:

```bash
npm --userconfig=/dev/null run dev -- --port <free-port>   # dev server, binds 127.0.0.1
npm --userconfig=/dev/null run validate:data                # validate data/ + scenarios/ against zod schemas
npm --userconfig=/dev/null run test                         # vitest run (single run, not watch)
npm --userconfig=/dev/null run build                        # regenerate catalog, tsc -b, vite build
npm --userconfig=/dev/null run test:watch                   # vitest watch mode
```

Data tooling:

```bash
npm --userconfig=/dev/null run prune:data                       # remove catalog rows (see pruning rules in AGENTS.md)
npm --userconfig=/dev/null run convert:llama-bench -- <args>     # convert raw llama-bench output into a data/results/*.json row
npm --userconfig=/dev/null run import:omlx                       # fetch/convert upstream oMLX benchmark rows
```

Run a single test file with vitest directly, e.g. `npx vitest run src/sim/timing.test.ts`.

`npm run dev` and `npm run build` both run `tsx scripts/build-static-catalog.ts` first — this validates repo data and regenerates `public/catalog/`. Generated catalog output, `dist/`, and `tsconfig.tsbuildinfo` are build artifacts; do not hand-edit them.

Run `validate:data` whenever catalog data, scenarios, schemas, or import scripts change. Run `test` and `build` for any non-trivial code/UI change. CI (`.github/workflows/`) runs `validate:data` → `test` → `build` on every push/PR, then deploys `dist/` to GitHub Pages on `main`.

## Architecture

**Data flow:** `data/*.json` (hardware, models, results) + `scenarios/*/script.json` → validated by `src/data/schemas.ts` (zod) → `scripts/build-static-catalog.ts` compiles them into static chunks under `public/catalog/` at dev/build time → `src/data/staticCatalog.ts` fetches that catalog at runtime (outside the JS bundle, via `App.tsx`'s `loadStaticCatalog()`) → pages/components consume the typed `StaticCatalog`.

**Routing:** No router library. `src/lib/routing.ts` maps `window.location.hash` to a `PageId`; `App.tsx` switches between page components on hash change and drives navigation by setting `window.location.hash`.

**Pages** (`src/pages/`) — one file per route, each takes the loaded `catalog` as a prop:
- `LandingPage` — entry point, config summary
- `PlaygroundPage` — inspect one configuration's simulated timeline in detail
- `RacePage` — the flagship surface: two lanes race the same deterministic scenario script side by side
- `ConfigsPage` — filterable/sortable index of the full catalog
- `MethodPage`, `ContributePage` — static/informational

**Simulation core:**
- `src/sim/timing.ts` — the authoritative timing model (prefill rate `pp`, decode rate `tg`, TTFT handling, cache semantics). Treat this as product logic, not incidental code.
- `src/hooks/usePlayback.ts` — wall-clock/`requestAnimationFrame`-driven playback state (not naive token-by-token intervals, which drift under tab throttling).

**Pure logic lives in `src/lib/`**, testable without the DOM: `catalog.ts` (catalog access), `catalogQuality.ts`, `configMatrix.ts` / `pickerOptions.ts` (config selection), `raceComparison.ts` / `raceSession.ts` / `raceOutput.ts` / `raceShare.ts` (Race page logic), `streaming.ts`, `phaseProgress.ts` / `phaseCopy.ts`, `contributionAgentPrompt.ts`, `routing.ts`, `format.ts`, `projectLinks.ts`. Each has a co-located `*.test.ts`.

**Components** (`src/components/`) are shared UI: `TopNav`, `StatusBadge`, `PhaseLegend`, `SimulatorPieces`, `Visualizations`.

**Scenarios** (`scenarios/*/script.json`) are deterministic scripted workloads (chatbot, agent bugfix loop, repo-wide refactor loop, reasoning-heavy) replayed identically across Race lanes. Roles are constrained to `user`, `assistant`, `tool_call`, `tool_result`, `thinking`, `cache_bust`.

**Data catalog** (`data/hardware/`, `data/models/`, `data/results/`) — every result row is a provenance claim (source URL, raw evidence, trust status `community`/`verified`/`flagged`/`illustrative`). See AGENTS.md's "Data Catalog Rules" and CONTRIBUTING.md before touching these.

**`mockup.pen`** is the Pencil design-mockup source of truth — inspect only via the Pencil MCP tools, never Read/Grep it directly (it's an encrypted binary-ish format). `design.md` is the code-facing distillation of that design system (colors, typography, motion/state rules, Race-specific layout rules) and is what `src/styles.css` should converge to.

## Notable Constraints

- No dependency additions/updates unless the existing stack (React, Vite, Vitest, zod, Tailwind, lucide-react) genuinely can't do the job — and even then, enforce the 48h package-freshness gate (`npm config set min-release-age=2d`) first, per this project's and the user's global dependency-safety rules.
- Browser/visual verification is expected for UI work — see AGENTS.md's "Browser And Visual Verification" section for the specific pages/interactions to check (especially Race: Start/Stop, central clock, lane completion, share URL).
- Before calling non-trivial work complete, AGENTS.md calls for a `claude -p` adversarial review pass — be patient with it, it can run silently for minutes.
