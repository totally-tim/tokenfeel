# Thinking-token streaming realism — design

Date: 2026-07-09
Status: approved, ready for planning

## Problem

Reasoning-heavy scenarios stream `thinking` (and other generated-role) events
far more slowly-looking than their declared decode rate implies. In the
reported example, a `thinking` turn shows `1,169 / 5,200 tok` at `62.7 t/s
decode` — the numeric counter and progress bar climb smoothly and correctly —
but the visible text has only revealed a single ten-word sentence after 18.3s,
because the underlying reveal mechanism (`streamTextChunks` /
`visibleTextForProgress` in `src/lib/streaming.ts`) shows whitespace-delimited
word chunks in exact proportion to token-decode progress.

The pacing algorithm itself is correct — `decodeCumulativeProgress` already
follows the real per-token, depth-dependent rate curve integrated in
`src/sim/timing.ts`, not a flat fraction of elapsed time. The bug is a content
problem: authored illustrative text for generated events is drastically
shorter than the token counts they're attached to.

Measured today (tokens per displayed word):

| scenario / event                  | role           | tokens    | text words | tokens/word |
| --------------------------------- | -------------- | --------- | ---------- | ----------- |
| reasoning-math                    | thinking       | 2,400     | 21         | 114.3       |
| reasoning-math                    | assistant      | 430       | 27         | 15.9        |
| repo-wide-refactor (turn 4)       | thinking       | 5,200     | 40         | 130.0       |
| repo-wide-refactor (turn 4)       | assistant      | 2,400     | 39         | 61.5        |
| repo-wide-refactor (turn 8)       | thinking       | 6,200     | 41         | 151.2       |
| repo-wide-refactor (turn 10)      | assistant      | 1,800     | 40         | 45.0        |
| agent-bugfix                      | thinking       | 318       | 17         | 18.7        |
| agent-bugfix                      | assistant (x2) | 148 / 220 | 33 / 47    | ~4.5        |
| repo-wide-refactor / agent-bugfix | tool_call (x5) | 36–90     | 2–12       | 6.4–20.5    |

Real English prose tokenizes at roughly 1.3 tokens/word. At 45–150
tokens/word, a new word only appears every 1–2.5 seconds of decode time
regardless of the lane's actual token rate, which reads as a stalled/broken
stream rather than a fast one.

A secondary, independent issue: the decode "cadence" tick texture in the
phase-state progress bar (`--cadence-duration: 0.9s`, `--sweep-duration:
1.15s` in `src/styles.css`) is a hardcoded constant, not scaled to the
event's actual `tgRate`/`ppRate` — the same visual tempo plays whether the
lane is running 5 tok/s or 200 tok/s.

## Non-goals

- No change to the timing/pacing algorithm in `src/sim/timing.ts` or
  `src/lib/streaming.ts` — `decodeCumulativeProgress` and the depth-integrated
  rate curve are already correct and stay as-is.
- No synthetic jitter or randomization in reveal pacing.
- Not matching literal real-world token/word density exactly (~1.3
  tokens/word) for every role — `tool_call` payloads (code/JSON) are sized by
  character count instead, and `thinking` targets a slightly higher band to
  match the more fragmentary register of real reasoning traces.
- Not collapsing `assistant`/`tool_call` turns after completion — only
  `thinking` gets the collapse-after-active treatment; the visible answer and
  tool calls stay fully expanded, matching how real chat UIs never hide the
  final answer.

## Design

### 1. Content rewrite (data)

Rewrite `text` (never `tokens` — token counts are ground truth per
AGENTS.md) for every generated-role event whose current density falls short
of these targets:

- `assistant`: ~1.3–1.6 tokens/word.
- `thinking`: ~1.5–2.0 tokens/word.
- `tool_call`: ~3.5–4.5 characters/token (character-based; code/JSON doesn't
  tokenize the same way as prose).

Scope: all three scenario files (`reasoning-math`, `repo-wide-refactor`,
`agent-bugfix`) — roughly 8 prose events (thinking + assistant) and 5
tool_call events. Estimated ~10,000–13,000 words of new prose plus
proportionally-sized tool-call payloads.

Constraints on the rewrite itself:

- Each event is rewritten with the full scenario file as context (surrounding
  turns, the user's actual ask), so added content reads as coherent,
  in-voice, workload-specific reasoning/answer text — not generic filler.
  Real reasoning-trace register (fragments, "wait, let me reconsider",
  backtracking, restating the problem) is appropriate for `thinking`, not
  polished prose.
- `event.tokens` is never modified.
- Execute via parallel subagents (one per scenario or event cluster, per
  user's direction), then reconcile into `scenarios/*/script.json` and run
  `validate:data`.

### 2. Shared `ThinkingStream` component

Currently `Transcript` (Playground) and `RaceLane` (Race) each inline a
near-identical `thinking-row` block in `SimulatorPieces.tsx`. Extract one
shared component used by both (no duplicate implementations, per project
convention):

- **While its event is the active/streaming event**: expanded, with an
  internal auto-scrolling tail — as `streamFrameForEvent(event, elapsedMs).text`
  grows, the container scrolls to keep the newest text in view, like a live
  log rather than a page that grows past the viewport.
- **Once that turn completes and playback advances past it**: collapses to a
  one-line summary (`Thought for 18.3s · 5,200 tok`) built from
  `event.decodeMs` and `event.tokens`, reusing the existing `Disclosure`
  component for expand/collapse. Expanding a completed turn re-shows the full
  final text (no re-streaming).

### 3. Auto-scroll-tail fix for all active generated text

Independent of the `thinking`-specific collapse behavior: today,
`scrollIntoView` only fires on `activeEvent.index` change (`Transcript`'s
`activeRef` effect, `RaceLane`'s `activeOutputRef` effect), not as text grows
within one event. This was invisible at ~40 words/event; it won't be once
`assistant`/`tool_call` turns run to hundreds of words. Add a scroll-follow
effect (keyed off the active event's growing text length) so Race's bounded
`race-output-scroll` panel and Playground's transcript both keep the actively
streaming text in view.

### 4. Data-integrity guard against regression

Add a conservative content-density floor, checked in `validate:data`: fail
when a generated-role (`assistant`/`thinking`/`tool_call`) event has
`text.length < event.tokens * 1.0` (under 1 character per token) — loose
enough to never block a legitimate short reply (a 3-token "Yes." is 4 chars,
comfortably above the floor), tight enough to catch another
5,200-tokens/267-chars regression (267 < 5200) before it ships. Implementation:
either a `superRefine` on `scenarioEventSchema` (`src/data/schemas.ts`) or a
small `scenarioQuality.ts` alongside the existing `catalogQuality.ts`,
whichever fits the existing validation pipeline (`scripts/validate-data.ts`)
more cleanly.

### 5. Cadence/sweep duration scaled to real rate

`--cadence-duration` and `--sweep-duration` become per-lane CSS custom
properties computed from the active event's `tgRate`/`ppRate` (inverse
relationship — faster decode, faster tick texture) instead of the current
fixed 0.9s/1.15s constants in `:root`. Applied the same way the existing
`--phase-fill-width`/`--phase-pip-left` custom properties are already set
inline per lane in `PhaseState`/`RaceLane`. Needs a sane clamp band (e.g.
0.3s–2s) so pathologically fast or slow rates don't produce a flickering or
frozen-looking texture.

## Testing & verification

- `validate:data` (new density guard + rewritten scenario content), `test`,
  `build`.
- New test(s) for the density guard (both a passing and a failing fixture).
- No expected changes to `streaming.test.ts` / `phaseProgress.test.ts` /
  `activePhase.test.ts` assertions — the pacing algorithm is untouched;
  existing fixtures should keep passing unmodified.
- Browser-verify (Playground and Race, `reasoning-math` and
  `repo-wide-refactor`, at a couple of playback speeds): continuous-looking
  thinking-text reveal, auto-scroll-tail while active, collapse-to-summary +
  re-expand after a thinking turn completes, and the rate-scaled cadence
  texture at visibly different tok/s lanes.
