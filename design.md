# Design - Tokenfeel

Tokenfeel uses one platform-neutral native-inspired interface system. The Pencil
mockup in `mockup.pen` is the visual source of truth; this document records the
code-facing interpretation.

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
- Ink: `#1D1D1F`
- Secondary ink: `#63636C`
- Muted ink: `#8A8A92`
- Hairline: `#D7D7DD`
- Primary border: `#BFC0C7`
- Accent: `#0A84FF`
- Accent soft: `#E8F2FF`
- Warning/tool wait: `#FF9F0A`
- Warning soft: `#FFF4DF`

Accent is for selected controls, focus, primary commands, progress, links, and
Lane A. Warning is reserved for tool wait, flagged state, and Lane B contrast.

## Typography

- Heading and body: Geist, system fallback.
- Data/caption: Geist Mono, monospace fallback.
- Letter spacing remains `0` for ordinary text. Small mono labels may use
  slight positive spacing for scanability.
- Hero type is reserved for the landing hero only. App workbench surfaces use
  compact titles and dense, readable data.

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

## Motion And State

- Prefill: determinate prompt progress with a subtle sweep.
- Decode: visible token cadence and cursor.
- Tool wait: amber pulse.
- Complete: motion stops and final timing locks.
- Idle: quiet, not visually dominant.
- Reduced motion disables animated sweeps and pulses while keeping counters and
  progress visible.

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
