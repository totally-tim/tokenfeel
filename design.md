# Design - Tokenfeel

Tokenfeel uses one platform-neutral native-inspired interface system. The Pencil
mockup in `mockup.pen` is the visual source of truth; this document records the
code-facing interpretation.

`mockup.pen` covers four screens — Landing, Playground, Race, Configs — plus
Button, StatusBadge, TopNav and FeatureCard components. It has **no Method or
Contribute screens**, so for those two surfaces this document is the operative
spec. Where the mockup and this document disagree with a repo rule in `AGENTS.md`,
the rule wins: the mockup shows a two-state prompt-cache toggle, but cache
overrides must be explicit, so the three-state control in code is correct.

## Product Frame

Tokenfeel compares hardware, model, quant, runtime, and scenario configurations
by showing how local generation feels in real time. It is not Mac-only. The UI
should feel like a precise local app: quiet chrome, direct controls, readable
transcripts, and evidence close to every result.

## Visual System

- Canvas: `#F2F2F7`
- Primary surface: `#FFFFFF`
- Glass surface: `#FFFFFFCC`
- Card surface: `#FFFFFFF2`
- Secondary surface: `#F5F5F7`
- Control surface: `#E9E9EF`
- Ink surface: `#1C1C1E`
- Ink: `#1D1D1F`
- Secondary ink: `#63636C`
- Muted ink: `#8A8A92`
- Subtle border: `#ECECF1`
- Hairline: `#D7D7DD`
- Primary border: `#BFC0C7`
- Accent: `#0A84FF`
- Accent soft: `#E8F2FF`
- Warning ink (`--warn`): `#A35C0F`
- Warning fill (`--warn-fill`): `#FF9F0A`
- Warning soft: `#FFF4DF`
- Accent ink (`--accent-ink`): `#0A5BB8`
- Thinking (`--think`): `#7C5CFF`
- Thinking ink (`--think-ink`): `#5B3FD1`
- Thinking soft: `#F1ECFF`

Accent is for selected controls, focus, primary commands, progress, links, and
Lane A. Warning is reserved for tool wait, flagged state, and Lane B contrast.

Amber carries two roles and therefore two values. `#FF9F0A` on white is about
2.0:1 and fails AA for text, so anything with a readable glyph — labels, badge
text, icons — uses the darker `--warn`, which clears 4.5:1 on white, canvas,
secondary surface and warn-soft. `--warn-fill` is the brighter value and is used
only where contrast-for-text does not apply: the re-prefill meter, the Lane B
stripe and progress bar, the tg rate curve, and chart legend marks. Do not use
`--warn-fill` for text, and do not use `--warn` for a fill that has no glyph on
it — the split only earns its keep if both halves are actually consumed.

Every token declared here must have a consumer. A palette entry that nothing
references is a claim the code does not honour.

Thinking is a fourth phase hue, deliberately distinct from accent, warning and
ink, because reasoning tokens stream before the visible answer and need to be
readable as a separate state.

Derived tints are named tokens (`--scrim-ink`, `--glass-strong`, `--glass-mid`,
`--accent-ring`, `--accent-ghost`). Surfaces should reference those rather than
re-deriving a base color at ad-hoc alpha.

## Typography

- Heading and body: Geist, system fallback.
- Data/caption: Geist Mono, monospace fallback.
- Letter spacing remains `0` for ordinary text. Small mono labels may use
  slight positive spacing for scanability.
- Hero type is reserved for the landing hero only. App workbench surfaces use
  compact titles and dense, readable data.
- Font size never scales with viewport width.

Sizes come from one scale, declared as tokens. Do not introduce a raw `px`
font-size; add a rung if a genuinely new size is needed.

| Token | Size | Role |
| --- | --- | --- |
| `--text-2xs` | 10px | mono micro-labels, badge text |
| `--text-xs` | 11px | dense workbench labels |
| `--text-sm` | 12px | secondary data, note prose |
| `--text-md` | 13px | control labels |
| `--text-base` | 14px | body |
| `--text-lg` | 15px | emphasized body |
| `--text-body` | 16px | doc-page body |
| `--text-xl` | 18px | panel titles |
| `--text-2xl` | 21px | sub-headings, subordinate figures |
| `--text-3xl` | 24px | lane titles, live throughput |
| `--text-4xl` | 30px | phase name, section headings |
| `--text-5xl` | 36px | race clock |
| `--display-xs` | 40px | final elapsed time |
| `--display-s` | 44px | landing stats |
| `--display-m` | 48px | doc-page hero |
| `--display-l` | 62px | boot screen |
| `--display-xl` | 84px | landing hero |

## Structure

- Top navigation is a glass toolbar with a segmented page switcher and unified
  toolbar actions.
- App pages are workbenches: source-list/config rail, central canvas, bottom or
  side diagnostics.
- Secondary controls use segmented controls, popovers, sheets, or disclosures,
  not permanent banners.
- Tables are index views with clear filters, summary cards, and paged rows.
- Cards are for repeated items, panels, and framed tools only. Avoid card stacks
  inside other cards.
- Paper texture (the 64px grid) belongs to the reading surfaces — Landing and the
  two doc pages. Workbenches stay flat.
- Grids of cards let items size to their own content. Stretching unequal-length
  content to a common height is what produces dead space and orphaned tiles.
- Match the shape to the kind of content. Contribute is a genuine four-step
  sequence and uses a four-up numbered grid; Method is five independent
  explanations of unequal length and does not. Same system, different shape.

## Race Layout

The config band above and the lane band below share one centre-column width
(`--race-center`), so the two bands sit on a single grid. They previously
disagreed (280px against 176px), which read as two half-finished layouts stacked,
and the narrower value wrapped the spine's own labels onto three lines.

At rest the lane pickers already show hardware and model, and the lane panel
repeats the identity just below, so the setup-card head hides its identity block
while idle. Once a race starts the pickers collapse and that head becomes the
lane's compact identity, so it returns.

A lane's primary readout is sized by what it is. A measured final elapsed time is
the payoff and earns display type; a phase name or "Ready" is a status word and
steps down, so it does not out-shout the live throughput figure beside it.

## Motion And State

- Prefill: determinate prompt progress with a subtle sweep.
- Decode: visible token cadence and cursor. The caret pulses at the decode
  cadence, so its tempo describes the simulated rate.
- Tool wait: amber pulse.
- Complete: motion stops and final timing locks.
- Idle: quiet, not visually dominant.
- Reduced motion disables animated sweeps and pulses while keeping counters and
  progress visible.

**Motion styles the cadence; it never times it.** This is the hard rule. What is
visible at a given moment comes from `usePlayback`'s wall-clock/rAF loop and
`src/sim/timing.ts`. No CSS transition, spring easing, or animation-driven
scheduling may sit between simulated progress and displayed progress. In
particular, a progress element whose width is driven per rAF frame must not also
carry a `transition` on that width — the transition retargets every frame, so the
bar trails the true value and keeps moving after the clock has locked.

Sweep and cadence durations derive from the active event's `ppRate`/`tgRate`
**and** the playback speed multiplier, via `sweepDurationMs` / `cadenceDurationMs`
in `src/lib/phaseProgress.ts`. Any new rate-descriptive motion must take the same
two inputs, or it will animate at 1x while the schedule runs at 8x. Both clamp to
[300ms, 2000ms]; past the floor the texture no longer tracks the rate, because
below roughly three ticks per second it reads as flicker rather than cadence.

The `prefers-reduced-motion` block in `src/styles.css` carries an inline table
accounting for every `@keyframes` rule and every `transition` in the file. Keep it
in sync when adding motion: spatial motion and pulsing stop, color crossfades
shorten, and anything that carries state — determinate fills, counters, elapsed
times, the caret glyph — stays visible.

## Trust State

Every catalog row carries a trust status: `community`, `verified`, `flagged`,
`illustrative`. Trust state renders wherever a user reads a number they might act
on — Race lanes, the Playground session header, and the Configs table — and is
never suppressed for being the common case.

Trust state and playback state are separate visual families. `TrustBadge` shows
the four catalog statuses; `StatusBadge` shows playback (`idle`, `generating`,
`running`, `finished`). They must not share styling: a `flagged` row and a healthy
`running` lane once collapsed onto one rule, which is exactly the failure this
separation prevents.

The four states differ on hue **and** on two non-color signals, so they survive
greyscale and color-blindness:

| State | Icon | Color | Border |
| --- | --- | --- | --- |
| `verified` | shield-check | `--accent-ink` | 1px solid |
| `community` | users | `--fg-secondary` | 1px solid |
| `flagged` | triangle-alert | `--warn` | 2px solid, weight 700 |
| `illustrative` | flask-conical | `--think-ink` | 1px dashed |

Badge text is 10px, which is small text, so every foreground must clear 4.5:1
against its own background. That is why `--accent-ink` and `--think-ink` exist:
`--accent-strong` is 4.37:1 on `--accent-soft` and the base `--think` is 3.76:1
on `--think-soft`, and both fail. Check the ratio when changing any of these.

Do not harmonize these. A restyle that makes the four consistent is how `flagged`
quietly stops looking flagged.

Provenance notes render at **zero clicks**, wrapped, in full — no ellipsis, no
fixed height, no disclosure. They are not boilerplate: they carry
action-critical caveats such as a comparison that is "not perfectly isolated" or
measurements clamped after an implausible jump, and a reader needs to know such a
caveat exists *before* acting on the number. Illegible provenance is worse than
absent provenance, and provenance hidden behind a click is worse than either — a
note count does not tell you a caveat is there. Costing vertical space is the
right trade. The source link sits directly beneath.

A projected figure never carries more visual weight than a measured one. The race
clock is measured and gets display type; the projected gap stays visibly
subordinate.

## Race Rules

- One page-level Share command.
- No persistent bottom result/share banner.
- The central race clock counts up while active.
- A lane shows elapsed time only after that lane is complete.
- Unfinished lanes use their primary area for current phase, throughput,
  progress, and transcript state.
- Comparable choices should be easy to reach first, while dissimilar comparisons
  remain possible.

## Shared Vocabulary

Landing, Playground, Race, and Configs share the same config labels, phase names,
button styles, badges, search pickers, source notes, and diagnostics disclosures.
Behavior and simulation math remain product logic; the design system only
changes presentation.
