A design and motion pass across all six surfaces, converging `src/styles.css` toward
`design.md` and updating `design.md` where the design genuinely moved. No changes to
simulation math, timing semantics, comparison semantics, catalog data, or provenance rules.
No new dependencies.

## The finding that reframed this

The audit turned up a credibility defect that outranked anything aesthetic. The guard at
`SimulatorPieces.tsx:708`/`:833` read:

```
result.status !== "community" && result.status !== "verified" && <StatusBadge/>
```

The catalog is 791 `community` + 5 `verified` + 0 `flagged` + 0 `illustrative`, so that
condition was false for **every one of 796 rows** — no trust badge had ever rendered on
Race lanes or the Playground session header, the two surfaces where a reader acts on a
number. Browser-confirmed: zero `.status-badge` nodes on Race with a verified lane racing
a community lane.

Compounding it: `.status-verified` had no CSS rule at all and fell through to the accent
base, `.status-community` and `.status-illustrative` computed to byte-identical style, and
`.status-flagged` shared a rule with `.status-running` — so a disputed benchmark row was
styled exactly like a healthy lane mid-race.

## What changed

**Trust state.** Split into `TrustBadge` (four catalog statuses) and `StatusBadge`
(playback only) so they can never share styling again. All four states now render
everywhere a number is read, and differ on hue plus two non-colour signals — icon glyph and
border treatment — so they survive greyscale. All four clear WCAG AA at the 10px badge size
(verified 5.80, community 5.46, flagged 4.70, illustrative 5.91).

**Provenance.** Three stacked chips ellipsized inside a ~336px shared boilerplate prefix in
a ~333px box, so all three rendered the same visible string in prime lane space. They now
wrap and render in full at zero clicks with the source link beneath. The lane difference is
finally legible — "7 upstream row(s) on oMLX 0.2.20rc1" against "11 upstream row(s) on
oMLX 0.3.0".

**Motion.** Two real defects, fixed surgically; the architecture was already sound and is
preserved.

- Removed `transition: width 180ms linear` from `.spine-progress b`. Its width comes from
  `usePlayback`'s rAF progress, so the transition retargeted every frame — the bar trailed
  true progress by up to 180ms and kept sliding after the lane clock had locked, which
  contradicts "complete: motion stops and final timing locks".
- The 1x/2x/4x/8x multiplier scaled wall-clock but never reached `cadenceDurationMs` /
  `sweepDurationMs`, so at 8x tokens landed eight times faster while the sweep and cadence
  animated at 1x. Threaded through, with tests.
- The decode caret pulses at the rate-derived cadence instead of sitting static.
- Completed the reduced-motion block: keyframes were covered but five transitions survived,
  including the two `width 0.18s` progress bars and an SVG `transform`. The block now
  carries an inline table accounting for every keyframes rule and every transition.

**Text fitting** — the loudest "unfinished" signal. Hero line-height 0.98 → 1.06 (descenders
were clipped); `mark` tightened with `box-decoration-break` so the highlight stops colliding
with trailing punctuation; `.setup-mode-tabs` `repeat(3)` → `repeat(4)`, which had orphaned
"Quant" onto a second row.

**Layout.** Race gets one shared `--race-center` track so the config band and lane band sit
on one grid — they disagreed (280px vs 176px) and the narrower value wrapped the spine
labels onto three lines. Idle hides the setup-card identity the pickers and lane panel
already show. Lane readouts are sized by kind, so a measured final elapsed keeps display
type while a phase name or "Ready" steps down. Playground packs idle rows to their natural
heights, removing ~400px of empty transcript panel. Method's five unequal explanations are
no longer forced into four equal-height columns with an orphaned fifth card; Contribute
keeps its four-up grid because 01→04 is a genuine sequence.

**Tokens.** Amber split into `--warn` (text, now clears 4.5:1 everywhere it lands) and
`--warn-fill` (`#FF9F0A`, non-text marks only) — the spec value was declared as
`--warn-bright` and used nowhere. Phase tokens reference base tokens instead of copying hex.
30 arbitrary font sizes across 156 declarations replaced with a 17-rung scale; no raw px
font-size remains. All 69 declared tokens have a consumer.

## Before / after

| Surface        |                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Race — idle    | ![](https://raw.githubusercontent.com/totally-tim/tokenfeel/dfb2c51862f4de99a5b14bf4e3ce6bcb5ea2976e/docs/design-pass/race.jpg)              |
| Race — running | ![](https://raw.githubusercontent.com/totally-tim/tokenfeel/dfb2c51862f4de99a5b14bf4e3ce6bcb5ea2976e/docs/design-pass/race-running.jpg)      |
| Playground     | ![](https://raw.githubusercontent.com/totally-tim/tokenfeel/dfb2c51862f4de99a5b14bf4e3ce6bcb5ea2976e/docs/design-pass/playground.jpg)        |
| Data & method  | ![](https://raw.githubusercontent.com/totally-tim/tokenfeel/dfb2c51862f4de99a5b14bf4e3ce6bcb5ea2976e/docs/design-pass/method.jpg)            |
| Landing        | ![](https://raw.githubusercontent.com/totally-tim/tokenfeel/dfb2c51862f4de99a5b14bf4e3ce6bcb5ea2976e/docs/design-pass/landing.jpg)           |
| Contribute     | ![](https://raw.githubusercontent.com/totally-tim/tokenfeel/dfb2c51862f4de99a5b14bf4e3ce6bcb5ea2976e/docs/design-pass/contribute.jpg)        |
| Configs        | ![](https://raw.githubusercontent.com/totally-tim/tokenfeel/dfb2c51862f4de99a5b14bf4e3ce6bcb5ea2976e/docs/design-pass/configs.jpg)           |
| Race — 390px   | ![](https://raw.githubusercontent.com/totally-tim/tokenfeel/dfb2c51862f4de99a5b14bf4e3ce6bcb5ea2976e/docs/design-pass/m-race.jpg)            |
| Trust states   | ![](https://raw.githubusercontent.com/totally-tim/tokenfeel/dfb2c51862f4de99a5b14bf4e3ce6bcb5ea2976e/docs/design-pass/trust-four-states.jpg) |

## Verification

```
npm --userconfig=/dev/null run validate:data   88 hardware, 230 models, 796 results, 4 scenarios
npm --userconfig=/dev/null run test            306 passed (24 files)
npm --userconfig=/dev/null run build           built, catalog regenerated
npm --userconfig=/dev/null run lint            0 errors, 7 warnings (all pre-existing on main)
```

**Simulation unchanged.** Race header still reads `11:30 vs 6:29.3 projected · gap 5:01.0`,
byte-identical to before. Ran to completion at 8x: Lane B's FINAL ELAPSED is **6:29.3**,
exactly its projected total, while Lane A still showed a phase rather than an elapsed time.

**Reduced motion.** 0 running animations; the only surviving transition is a 90ms colour
crossfade. Clock counting (8.7s) and determinate fill (35.02%) still live. Before this
branch, five transitions survived including the progress-bar `width` and an SVG `transform`.

**Cadence tracks the rate.** Lane A 635.6ms vs Lane B 529.6ms at 1x (each lane's own `tg`),
and exactly half at 2x. Before, the multiplier never reached these functions.

**Race behaviours.** Start→Stop toggles; clock counts 0.0s → 25.9s → 50.3s; Stop resets to
0.0s; share URL round-trips both lanes, speed 4x and scenario.

**Six surfaces at 1440x900:** zero console errors, zero horizontal overflow.

## Review

Reviewed by an external non-Claude panel (Codex, xhigh) across four lenses — cold
adversarial, timing safety, trust/provenance, and global-restyle regression. The timing lens
returned "the simulation is still honest… no current timing-integrity defect". The
trust lens **refuted** the first attempt and the regression lens found one major issue; both
rounds of findings were fixed and re-verified in-browser. See the PR discussion for the
residual verification gap.
