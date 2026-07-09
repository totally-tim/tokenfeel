# Thinking-Token Streaming Realism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make reasoning/agent scenario streaming (especially `thinking` events) look like continuous decode at the declared token rate, by densifying illustrative scenario text to a realistic token:word ratio, and by fixing the two UI-side symptoms that content density alone doesn't cover (auto-scroll tracking a growing stream, and a cadence texture that doesn't reflect the real decode rate).

**Architecture:** No changes to the timing/pacing algorithm (`src/sim/timing.ts`, `src/lib/streaming.ts`) — it is already correct. This is a content-density fix (rewrite scenario `text` fields, never `tokens`) plus three small, independent code changes: a schema-level regression guard, a shared collapsible `ThinkingStream` component with auto-scroll, and rate-scaled motion durations for the existing phase-progress texture.

**Tech Stack:** React 18 + TypeScript, Vite, Zod schemas, Vitest, hand-authored JSON scenario data.

## Global Constraints

- Run all npm commands as `npm --userconfig=/dev/null run <script>` (repo convention — avoids machine-level npm config surprises).
- `event.tokens` is ground truth and must never change in any task in this plan — only `event.text` changes.
- No new dependencies. This repo has no component-test harness (no `*.test.tsx`, no testing-library) — UI tasks are verified by `tsc -b` (via `build`) plus manual browser verification, not new component tests; do not add one for this plan.
- Run `npm --userconfig=/dev/null run validate:data` after any scenario JSON or schema change; run `npm --userconfig=/dev/null run test` and `npm --userconfig=/dev/null run build` after any code change.
- Design reference: `docs/superpowers/specs/2026-07-09-thinking-token-streaming-design.md`.

---

## Task 1: Densify `reasoning-math` scenario content

**Files:**
- Modify: `scenarios/reasoning-math/script.json`

**Interfaces:**
- Produces: no code interface — this is a data-only change. Downstream tasks (Task 4's schema guard) will validate this file's density once it lands.

Current file (for reference — only `text` fields on the two listed events change; `id`, `tokens`, and all other fields/events stay exactly as-is):

```json
{
  "id": "reasoning-math",
  "title": "Reasoning math",
  "type": "reasoning",
  "systemPromptTokens": 620,
  "description": "A single reasoning-heavy question with visible thinking and a compact final answer.",
  "events": [
    {
      "id": "math-u1",
      "role": "user",
      "text": "A factory has three machines with different failure probabilities. Which maintenance schedule minimizes expected downtime?",
      "tokens": 84
    },
    {
      "id": "math-thinking",
      "role": "thinking",
      "text": "Compare the expected loss of preventive replacement against failure repair time, normalize by production value and search the weekly schedule space.",
      "tokens": 2400
    },
    {
      "id": "math-a1",
      "role": "assistant",
      "text": "The lowest expected downtime comes from servicing Machine B every second Friday, Machine A monthly and Machine C only after the vibration threshold crosses the warning band.",
      "tokens": 430
    }
  ]
}
```

Rewrite targets:

| event id | role | tokens | current words | target words |
|---|---|---|---|---|
| `math-thinking` | thinking | 2400 | 21 | 1200–1600 |
| `math-a1` | assistant | 430 | 27 | 269–331 |

- [ ] **Step 1: Rewrite `math-thinking`**

Write a long internal-monologue-style reasoning trace (register: fragments, self-correction, "wait," "actually," restating the problem, working through numbers, backtracking on a wrong turn before recovering) for a model working through: modeling expected downtime cost per machine from failure probability, weighing preventive-replacement cost against expected failure/repair cost, weighting by each machine's production value/criticality, then searching the weekly-schedule space. The reasoning must plausibly converge on the exact conclusion `math-a1` states: service Machine B every second Friday, Machine A monthly, Machine C only after its vibration threshold crosses the warning band. Target 1200–1600 words.

- [ ] **Step 2: Rewrite `math-a1`**

Write a fuller final-answer version of the same conclusion (Machine B biweekly, Machine A monthly, Machine C threshold-triggered) — clean, confident, well-organized chat-reply prose (not internal monologue), with brief justification for each machine's schedule. Target 269–331 words.

- [ ] **Step 3: Verify density**

Run:

```bash
node -e "
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('scenarios/reasoning-math/script.json', 'utf8'));
for (const e of data.events) {
  if (!['assistant','thinking','tool_call'].includes(e.role)) continue;
  const words = e.text.split(/\s+/).filter(Boolean).length;
  const chars = e.text.length;
  console.log(e.id, e.role, 'tokens=' + e.tokens, 'words=' + words, 'chars=' + chars, 'tok/word=' + (e.tokens / words).toFixed(2));
}
"
```

Expected: `math-thinking` prints `tok/word` between 1.5 and 2.0; `math-a1` prints `tok/word` between 1.3 and 1.6.

- [ ] **Step 4: Confirm `event.tokens` is unchanged and the file is still valid JSON**

Run: `git diff scenarios/reasoning-math/script.json`
Expected: diff only touches the two `"text"` values; every `"tokens"` line is unchanged.

Run: `npm --userconfig=/dev/null run validate:data`
Expected: passes (this file has no schema-level density guard yet — that lands in Task 4 — so this just confirms the JSON is still well-formed and the catalog still builds).

- [ ] **Step 5: Commit**

```bash
git add scenarios/reasoning-math/script.json
git commit -m "Densify reasoning-math thinking/answer text to realistic token density"
```

---

## Task 2: Densify `repo-wide-refactor` scenario content

**Files:**
- Modify: `scenarios/repo-wide-refactor/script.json`

**Interfaces:**
- Produces: no code interface — data-only change.

Current file (only `text` on the seven listed events changes; every other field, including all `tool_result` events' text/tokens/cacheBust, stays exactly as-is):

```json
{
  "id": "repo-wide-refactor",
  "title": "Repo-wide refactor",
  "type": "agent",
  "systemPromptTokens": 18000,
  "description": "A long-context agent pass over a medium repository: broad file reads, patch synthesis, test output and a final review.",
  "events": [
    {
      "id": "refactor-u1",
      "role": "user",
      "text": "Refactor the race experience end to end. Read the product brief, current route, shared simulator components, picker helpers, tests and styling before touching code. Keep the implementation tight and verify the browser flow.",
      "tokens": 1200
    },
    {
      "id": "refactor-tool-call-1",
      "role": "tool_call",
      "text": "read_many([\"src/pages/RacePage.tsx\", \"src/components/SimulatorPieces.tsx\", \"src/lib/configMatrix.ts\", \"src/styles.css\", \"src/hooks/usePlayback.ts\", \"scenarios/*/script.json\"])",
      "tokens": 90
    },
    {
      "id": "refactor-tool-result-1",
      "role": "tool_result",
      "text": "Repository context loaded: RacePage owns URL state and dual playback; SimulatorPieces contains SearchSelect, phase UI and lane rendering; configMatrix has top-down result resolution; styles define command panel, picker strip, lanes and mobile breakpoints. Existing scenarios are short and do not stress context depth.",
      "tokens": 28000,
      "toolLatencyMs": 420,
      "cacheBust": { "retainedPrefixTokens": 18000, "reason": "Large multi-file read inserted into the working transcript." }
    },
    {
      "id": "refactor-thinking-1",
      "role": "thinking",
      "text": "The race page needs an interaction model more than another visual skin: clean start/stop semantics, match suggestions, axis-first selection and less status chrome. The helper logic should be pure so ranking and progressive selection can be tested without the browser.",
      "tokens": 5200
    },
    {
      "id": "refactor-a1",
      "role": "assistant",
      "text": "I will split comparison ranking into a small helper module, replace the top command strip with a compare workbench, make running state expose Stop instead of Restart, and add a long-context scenario so race timing reflects real agent work.",
      "tokens": 2400
    },
    {
      "id": "refactor-tool-call-2",
      "role": "tool_call",
      "text": "apply_patch(\"race refactor: comparison helpers, RacePage workbench, stop/reset playback, long-context scenario, responsive CSS\")",
      "tokens": 80
    },
    {
      "id": "refactor-tool-result-2",
      "role": "tool_result",
      "text": "Patch applied. New helper tests cover model-first selection and same-model hardware suggestions. RacePage now shows a compact compare header, lane setup cards, suggested matches for Lane B, and a single run control. Status badges were removed from race lanes.",
      "tokens": 42000,
      "toolLatencyMs": 780,
      "cacheBust": { "retainedPrefixTokens": 25000, "reason": "Patch output and generated catalog changes invalidate part of the previous prefix." }
    },
    {
      "id": "refactor-thinking-2",
      "role": "thinking",
      "text": "The new path still needs browser evidence: the selector panel should not overflow, suggested matches should be visible without forcing them, Stop must reset both lanes to zero, and the long scenario should expose deep context without making the page unreadable.",
      "tokens": 6200
    },
    {
      "id": "refactor-tool-call-3",
      "role": "tool_call",
      "text": "npm test && npm run build && playwright race visual sweep",
      "tokens": 70
    },
    {
      "id": "refactor-tool-result-3",
      "role": "tool_result",
      "text": "Tests, typecheck and build passed. Browser sweep covered desktop and mobile Race, opened the progressive selector, started and stopped the race, applied a suggested match, and confirmed no console errors or horizontal overflow.",
      "tokens": 8800,
      "toolLatencyMs": 900
    },
    {
      "id": "refactor-a2",
      "role": "assistant",
      "text": "Race is now centered on comparable setup selection. The default is a same-model hardware comparison, Start becomes Stop while the run is active, Stop resets to the beginning, and exploratory mismatches remain possible but are no longer the primary path.",
      "tokens": 1800
    }
  ]
}
```

Rewrite targets:

| event id | role | tokens | current | target |
|---|---|---|---|---|
| `refactor-tool-call-1` | tool_call | 90 | 175 chars | 315–405 chars |
| `refactor-thinking-1` | thinking | 5200 | 40 words | 2600–3467 words |
| `refactor-a1` | assistant | 2400 | 39 words | 1500–1846 words |
| `refactor-tool-call-2` | tool_call | 80 | 128 chars | 280–360 chars |
| `refactor-thinking-2` | thinking | 6200 | 41 words | 3100–4133 words |
| `refactor-tool-call-3` | tool_call | 70 | 57 chars | 245–315 chars |
| `refactor-a2` | assistant | 1800 | 40 words | 1125–1385 words |

- [ ] **Step 1: Rewrite `refactor-tool-call-1`**

Expand the `read_many([...])` file list with a few more plausible files a real "refactor the race experience end to end" pass would read before touching code — e.g. `src/lib/raceComparison.ts`, `src/lib/raceSession.ts`, `src/lib/raceOutput.ts`, `src/lib/phaseCopy.ts`, `src/lib/activePhase.ts`, existing test files. Target 315–405 characters, staying a single plausible tool-call expression.

- [ ] **Step 2: Rewrite `refactor-thinking-1`**

Write a long internal-monologue reasoning trace for a coding agent examining the just-loaded repo context (RacePage owns URL state and dual playback; SimulatorPieces has SearchSelect/phase UI/lane rendering; configMatrix does top-down result resolution) and working through the race-page redesign: why start/stop semantics need to change, what a match-suggestion algorithm should weigh, why comparison-ranking logic needs to be pure/testable, tradeoffs between an inline fix and a small helper module, how a long-context scenario should be added without destabilizing timing. Must plausibly converge on `refactor-a1`'s stated plan (split comparison ranking into a helper module, replace the top command strip with a compare workbench, Stop instead of Restart, add a long-context scenario). Target 2600–3467 words.

- [ ] **Step 3: Rewrite `refactor-a1`**

Expand "I will split comparison ranking into a small helper module..." into a fuller, organized explanation of the same plan (same four commitments, more detail on each: what the helper module's interface looks like, what the compare workbench replaces, how Stop resets both lanes, what the long-context scenario needs to stress). Target 1500–1846 words.

- [ ] **Step 4: Rewrite `refactor-tool-call-2`**

Expand the `apply_patch(...)` description with more specific detail about the changed files/behavior (still a single plausible tool-call string, not a full diff). Target 280–360 characters.

- [ ] **Step 5: Rewrite `refactor-thinking-2`**

Write a long reasoning trace for the agent planning its browser-verification pass, given `refactor-tool-result-2`'s summary (compact compare header, lane setup cards, suggested matches for Lane B, single run control, status badges removed): weighing what could still be broken (selector panel overflow, suggested-match visibility, Stop not resetting both lanes, long-scenario readability), and why. Must plausibly lead into `refactor-tool-call-3`'s verification pass. Target 3100–4133 words.

- [ ] **Step 6: Rewrite `refactor-tool-call-3`**

Expand `npm test && npm run build && playwright race visual sweep` with more realistic flags/detail (e.g. what the visual sweep actually exercises). Target 245–315 characters.

- [ ] **Step 7: Rewrite `refactor-a2`**

Expand the final wrap-up ("Race is now centered on comparable setup selection...") into a fuller summary covering the same four points (default same-model comparison, Start/Stop semantics, Stop resets to start, exploratory mismatches still possible but not default) with brief justification for each. Target 1125–1385 words.

- [ ] **Step 8: Verify density**

Run:

```bash
node -e "
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('scenarios/repo-wide-refactor/script.json', 'utf8'));
for (const e of data.events) {
  if (!['assistant','thinking','tool_call'].includes(e.role)) continue;
  const words = e.text.split(/\s+/).filter(Boolean).length;
  const chars = e.text.length;
  console.log(e.id, e.role, 'tokens=' + e.tokens, 'words=' + words, 'chars=' + chars, 'tok/word=' + (e.tokens / words).toFixed(2), 'chars/tok=' + (chars / e.tokens).toFixed(2));
}
"
```

Expected: both `thinking` events print `tok/word` in [1.5, 2.0]; both `assistant` events print `tok/word` in [1.3, 1.6]; all three `tool_call` events print `chars/tok` in [3.5, 4.5].

- [ ] **Step 9: Confirm `event.tokens` is unchanged for every event, including untouched `tool_result` events**

Run: `git diff scenarios/repo-wide-refactor/script.json`
Expected: diff only touches the seven `"text"` values listed above; every `"tokens"` line and every `tool_result` event is unchanged.

Run: `npm --userconfig=/dev/null run validate:data`
Expected: passes.

- [ ] **Step 10: Commit**

```bash
git add scenarios/repo-wide-refactor/script.json
git commit -m "Densify repo-wide-refactor thinking/answer/tool-call text to realistic token density"
```

---

## Task 3: Densify `agent-bugfix` scenario content

**Files:**
- Modify: `scenarios/agent-bugfix/script.json`

**Interfaces:**
- Produces: no code interface — data-only change.

Current file (only `text` on the six listed events changes; every other field, including all `tool_result` events, stays exactly as-is):

```json
{
  "id": "agent-bugfix",
  "title": "Agent bugfix",
  "type": "agent",
  "systemPromptTokens": 4012,
  "description": "An agentic coding loop with tool calls, tool results, cache busts and short fixes.",
  "events": [
    {
      "id": "agent-u1",
      "role": "user",
      "text": "The timing test is failing on extrapolated depths. Read the module and the test, then fix it.",
      "tokens": 28
    },
    {
      "id": "agent-tool-call-1",
      "role": "tool_call",
      "text": "read_file(\"src/sim/timing.ts\", lines=[80,140])",
      "tokens": 41
    },
    {
      "id": "agent-tool-result-1",
      "role": "tool_result",
      "text": "export function tgAt(depth: number): number { const pts = result.measurements; if (depth >= pts.at(-1).depth) return flatExtrapolate(pts); return lerp(pts, depth); }",
      "tokens": 1240,
      "toolLatencyMs": 180,
      "cacheBust": { "retainedPrefixTokens": 4012, "reason": "Large file-read result inserted into transcript." }
    },
    {
      "id": "agent-thinking-1",
      "role": "thinking",
      "text": "The failing case sits exactly at the final measured depth; equality should not enter the interpolation branch.",
      "tokens": 318
    },
    {
      "id": "agent-a1",
      "role": "assistant",
      "text": "Found it — lerp() includes the final point, so at exactly the last measured depth it interpolates past the array. I'll clamp the upper bound and route equality to the flat extrapolation branch.",
      "tokens": 148
    },
    {
      "id": "agent-tool-call-2",
      "role": "tool_call",
      "text": "apply_patch(\"src/sim/timing.ts\", \"clamp interpolation upper bound\")",
      "tokens": 64
    },
    {
      "id": "agent-tool-result-2",
      "role": "tool_result",
      "text": "Patch applied. Modified interpolateRate to return the final measured point for equality and clamp beyond it.",
      "tokens": 1540,
      "toolLatencyMs": 260,
      "cacheBust": { "retainedPrefixTokens": 4350, "reason": "Patch output reorders the tool transcript." }
    },
    {
      "id": "agent-tool-call-3",
      "role": "tool_call",
      "text": "npm test -- src/sim/timing.test.ts",
      "tokens": 36
    },
    {
      "id": "agent-tool-result-3",
      "role": "tool_result",
      "text": "PASS src/sim/timing.test.ts. interpolateRate keeps interior values unchanged and clamps the final depth.",
      "tokens": 760,
      "toolLatencyMs": 620
    },
    {
      "id": "agent-a2",
      "role": "assistant",
      "text": "Fixed. lerp() treated the last measured depth as interpolatable, so at exactly 16,384 it indexed one point past the array and returned NaN. I clamped the upper bound and routed the equality case to flatExtrapolate(). The failing test now passes and the three interpolated depths are unchanged.",
      "tokens": 220
    }
  ]
}
```

Rewrite targets:

| event id | role | tokens | current | target |
|---|---|---|---|---|
| `agent-tool-call-1` | tool_call | 41 | 46 chars | 144–185 chars |
| `agent-thinking-1` | thinking | 318 | 17 words | 159–212 words |
| `agent-a1` | assistant | 148 | 33 words | 93–114 words |
| `agent-tool-call-2` | tool_call | 64 | 67 chars | 224–288 chars |
| `agent-tool-call-3` | tool_call | 36 | 34 chars | 126–162 chars |
| `agent-a2` | assistant | 220 | 47 words | 138–169 words |

This scenario needs modest growth (2–4x), not the 30–100x rewrite of Tasks 1–2 — its existing text was already closer to a reasonable density.

- [ ] **Step 1: Rewrite `agent-tool-call-1`**

Expand `read_file("src/sim/timing.ts", lines=[80,140])` with a more specific/realistic read call (e.g. a second target or a brief comment on why these lines). Target 144–185 characters.

- [ ] **Step 2: Rewrite `agent-thinking-1`**

Expand the single insight ("The failing case sits exactly at the final measured depth...") into a short paragraph of reasoning that walks through why an off-by-one at the boundary depth causes `lerp()` to index past the array, in-voice with the existing sentence. Target 159–212 words.

- [ ] **Step 3: Rewrite `agent-a1`**

Expand "Found it — lerp() includes the final point..." with a bit more detail on the fix approach. Target 93–114 words.

- [ ] **Step 4: Rewrite `agent-tool-call-2`**

Expand `apply_patch("src/sim/timing.ts", "clamp interpolation upper bound")` with more specific patch detail. Target 224–288 characters.

- [ ] **Step 5: Rewrite `agent-tool-call-3`**

Expand `npm test -- src/sim/timing.test.ts` with a realistic flag or two (e.g. a reporter flag). Target 126–162 characters.

- [ ] **Step 6: Rewrite `agent-a2`**

Expand "Fixed. lerp() treated the last measured depth..." with a bit more closing detail (still consistent with the existing facts: index 16,384, NaN, flatExtrapolate(), three interpolated depths unchanged). Target 138–169 words.

- [ ] **Step 7: Verify density**

Run:

```bash
node -e "
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('scenarios/agent-bugfix/script.json', 'utf8'));
for (const e of data.events) {
  if (!['assistant','thinking','tool_call'].includes(e.role)) continue;
  const words = e.text.split(/\s+/).filter(Boolean).length;
  const chars = e.text.length;
  console.log(e.id, e.role, 'tokens=' + e.tokens, 'words=' + words, 'chars=' + chars, 'tok/word=' + (e.tokens / words).toFixed(2), 'chars/tok=' + (chars / e.tokens).toFixed(2));
}
"
```

Expected: `agent-thinking-1` prints `tok/word` in [1.5, 2.0]; `agent-a1`/`agent-a2` print `tok/word` in [1.3, 1.6]; all three `tool_call` events print `chars/tok` in [3.5, 4.5].

- [ ] **Step 8: Confirm `event.tokens` is unchanged, then validate**

Run: `git diff scenarios/agent-bugfix/script.json`
Expected: diff only touches the six `"text"` values listed above.

Run: `npm --userconfig=/dev/null run validate:data`
Expected: passes.

- [ ] **Step 9: Commit**

```bash
git add scenarios/agent-bugfix/script.json
git commit -m "Densify agent-bugfix thinking/answer/tool-call text to realistic token density"
```

---

## Task 4: Add content-density floor guard to `scenarioEventSchema`

**Files:**
- Modify: `src/data/schemas.ts:164-210`
- Test: `src/data/schema.test.ts`

**Interfaces:**
- Consumes: nothing new — extends the existing `scenarioEventSchema` export.
- Produces: `scenarioEventSchema` now rejects any `assistant`/`thinking`/`tool_call` event whose `text.length < tokens * 1` (below 1 char/token). No new exports.

This task runs *after* Tasks 1–3 so the real scenario data already clears the floor by the time the guard is added — `validate:data` never goes red mid-plan.

- [ ] **Step 1: Write the failing tests**

Add to `src/data/schema.test.ts` (after the existing `describe("scenarioEventSchema cache_bust marker role (T1)", ...)` block, i.e. after line 401):

```ts
describe("scenarioEventSchema content-density floor (thinking-token streaming realism)", () => {
  it("rejects a generated-role event whose text is far too sparse for its declared token count", () => {
    expect(() =>
      scenarioEventSchema.parse({
        id: "sparse-thinking",
        role: "thinking",
        text: "Too short for the claimed token count.",
        tokens: 5200
      })
    ).toThrow(/content-density floor/);
  });

  it("accepts a generated-role event whose text clears the density floor", () => {
    const parsed = scenarioEventSchema.parse({
      id: "dense-thinking",
      role: "thinking",
      text: "x".repeat(5200),
      tokens: 5200
    });
    expect(parsed.tokens).toBe(5200);
  });

  it("does not apply the density floor to non-generated roles", () => {
    expect(() =>
      scenarioEventSchema.parse({ id: "short-user-turn", role: "user", text: "Yes.", tokens: 5200 })
    ).not.toThrow();
    expect(() =>
      scenarioEventSchema.parse({ id: "short-tool-result", role: "tool_result", text: "OK", tokens: 5200 })
    ).not.toThrow();
  });

  it("never trips on a legitimately short generated reply", () => {
    expect(() =>
      scenarioEventSchema.parse({ id: "short-reply", role: "assistant", text: "Yes.", tokens: 3 })
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/data/schema.test.ts -t "content-density floor"`
Expected: the first test (`rejects a generated-role event...`) FAILS because `scenarioEventSchema.parse` does not yet throw.

- [ ] **Step 3: Implement the guard**

In `src/data/schemas.ts`, replace the `scenarioEventSchema` definition (lines 164–210) with:

```ts
const GENERATED_SCENARIO_ROLES = new Set(["assistant", "thinking", "tool_call"]);
const SCENARIO_TEXT_MIN_CHARS_PER_TOKEN = 1;

export const scenarioEventSchema = z
  .object({
    id: idSchema,
    role: z.enum(["user", "assistant", "tool_call", "tool_result", "thinking", "cache_bust"]),
    text: z.string(),
    tokens: z.number().int().nonnegative(),
    toolLatencyMs: z.number().nonnegative().optional(),
    cacheBust: z
      .object({
        retainedPrefixTokens: z.number().int().nonnegative(),
        reason: z.string().optional()
      })
      .optional()
  })
  .superRefine((event, ctx) => {
    // A standalone "cache_bust"-role event is a zero-content, zero-duration
    // marker (see ScenarioRole in types.ts): a standalone event using it must
    // never advance context depth or add wall-clock time. The schema rejects
    // nonzero tokens/toolLatencyMs (and any cacheBust property at all) on
    // it, but this is enforced again here defensively so a malformed event
    // can never silently inflate contextDepth/cachedPrefixTokens or add
    // tool latency for zero timing cost (T1).
    if (event.role === "cache_bust") {
      if (event.tokens !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Event "${event.id}" has role "cache_bust" but nonzero tokens (${event.tokens}) -- a standalone cache_bust-role event must be a zero-token marker; use the cacheBust property on a user/tool_result event to model a partial cache invalidation with real content`,
          path: ["tokens"]
        });
      }
      if (event.toolLatencyMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Event "${event.id}" has role "cache_bust" but nonzero toolLatencyMs (${event.toolLatencyMs}) -- a standalone cache_bust-role event must be a zero-duration marker; use toolLatencyMs on a user/tool_result event instead`,
          path: ["toolLatencyMs"]
        });
      }
      if (event.cacheBust) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Event "${event.id}" has role "cache_bust" and a cacheBust property, which buildTimeline never applies to this role (it only prefills on user/tool_result events) -- set cacheBust on a user/tool_result event instead`,
          path: ["cacheBust"]
        });
      }
      return;
    }

    // Generated-role events (assistant/thinking/tool_call) stream at decode
    // speed in the UI, revealed in proportion to token progress (see
    // src/lib/streaming.ts). Illustrative text far shorter than the declared
    // token count makes that reveal look sparse/stalled instead of a
    // continuous stream at the claimed rate -- see
    // docs/superpowers/specs/2026-07-09-thinking-token-streaming-design.md.
    // This is a conservative floor (not the ~1.3-2 tokens/word authoring
    // target), loose enough that a legitimate short reply never trips it.
    if (
      GENERATED_SCENARIO_ROLES.has(event.role) &&
      event.text.length < event.tokens * SCENARIO_TEXT_MIN_CHARS_PER_TOKEN
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Event "${event.id}" has role "${event.role}" with ${event.tokens} tokens but only ${event.text.length} characters of text -- below the ${SCENARIO_TEXT_MIN_CHARS_PER_TOKEN} char/token content-density floor; streamed playback will look far sparser than the declared token count implies`,
        path: ["text"]
      });
    }
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/data/schema.test.ts`
Expected: all tests in the file PASS, including the four new ones and the pre-existing `cache_bust marker role (T1)` tests (confirms the restructured early-return-to-branch didn't regress that behavior).

- [ ] **Step 5: Run the full validation/test/build pipeline against the now-densified real scenario data**

Run: `npm --userconfig=/dev/null run validate:data && npm --userconfig=/dev/null run test && npm --userconfig=/dev/null run build`
Expected: all three pass — confirms Tasks 1–3's rewritten `reasoning-math`, `repo-wide-refactor`, and `agent-bugfix` content clears the new floor.

- [ ] **Step 6: Commit**

```bash
git add src/data/schemas.ts src/data/schema.test.ts
git commit -m "Add content-density floor guard to scenarioEventSchema"
```

---

## Task 5: Rate-scaled motion duration helpers

**Files:**
- Modify: `src/lib/phaseProgress.ts`
- Test: `src/lib/phaseProgress.test.ts`

**Interfaces:**
- Produces: `cadenceDurationMs(tgRate: number): number` and `sweepDurationMs(ppRate: number): number`, both exported from `src/lib/phaseProgress.ts`. Consumed by Task 6.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/phaseProgress.test.ts`:

```ts
import { cadenceDurationMs, phaseTrackVisualState, sweepDurationMs } from "./phaseProgress";
```

(replacing the existing `import { phaseTrackVisualState } from "./phaseProgress";` on line 2), then append:

```ts
describe("rate-scaled motion durations", () => {
  test("cadenceDurationMs returns the historical 900ms baseline at the reference decode rate", () => {
    expect(cadenceDurationMs(50)).toBe(900);
  });

  test("cadenceDurationMs ticks faster (shorter duration) for a faster decode rate", () => {
    expect(cadenceDurationMs(100)).toBe(450);
  });

  test("cadenceDurationMs clamps to the minimum for an extremely fast decode rate", () => {
    expect(cadenceDurationMs(10_000)).toBe(300);
  });

  test("cadenceDurationMs clamps to the maximum for an extremely slow decode rate", () => {
    expect(cadenceDurationMs(1)).toBe(2000);
  });

  test("cadenceDurationMs falls back to the baseline for a non-positive rate", () => {
    expect(cadenceDurationMs(0)).toBe(900);
    expect(cadenceDurationMs(-5)).toBe(900);
  });

  test("sweepDurationMs returns the historical 1150ms baseline at the reference prefill rate", () => {
    expect(sweepDurationMs(800)).toBe(1150);
  });

  test("sweepDurationMs ticks faster for a faster prefill rate", () => {
    expect(sweepDurationMs(1600)).toBe(575);
  });

  test("sweepDurationMs clamps to the minimum and maximum bounds", () => {
    expect(sweepDurationMs(100_000)).toBe(300);
    expect(sweepDurationMs(1)).toBe(2000);
  });

  test("sweepDurationMs falls back to the baseline for a non-positive rate", () => {
    expect(sweepDurationMs(0)).toBe(1150);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/phaseProgress.test.ts`
Expected: FAILS with "cadenceDurationMs is not a function" (or a TypeScript error on the import).

- [ ] **Step 3: Implement the helpers**

In `src/lib/phaseProgress.ts`, append after the existing `phaseTrackVisualState` function:

```ts
// Reference rates the original fixed 900ms/1150ms motion durations were
// tuned for -- at these rates, behavior is unchanged from before. Faster
// than the reference ticks faster (shorter duration); slower ticks slower.
// Clamped to [300ms, 2000ms] so pathological rates never produce a
// flickering or visually-frozen texture.
const REFERENCE_TG_RATE = 50;
const REFERENCE_PP_RATE = 800;
const BASE_CADENCE_MS = 900;
const BASE_SWEEP_MS = 1150;
const MIN_MOTION_MS = 300;
const MAX_MOTION_MS = 2000;

function clampMotionMs(ms: number): number {
  return Math.max(MIN_MOTION_MS, Math.min(MAX_MOTION_MS, ms));
}

export function cadenceDurationMs(tgRate: number): number {
  if (!(tgRate > 0)) return BASE_CADENCE_MS;
  return clampMotionMs(BASE_CADENCE_MS * (REFERENCE_TG_RATE / tgRate));
}

export function sweepDurationMs(ppRate: number): number {
  if (!(ppRate > 0)) return BASE_SWEEP_MS;
  return clampMotionMs(BASE_SWEEP_MS * (REFERENCE_PP_RATE / ppRate));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/phaseProgress.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/phaseProgress.ts src/lib/phaseProgress.test.ts
git commit -m "Add rate-scaled cadence/sweep motion duration helpers"
```

---

## Task 6: Wire rate-scaled motion durations into `PhaseState`

**Files:**
- Modify: `src/components/SimulatorPieces.tsx:45,117-121`

**Interfaces:**
- Consumes: `cadenceDurationMs`, `sweepDurationMs` from `src/lib/phaseProgress.ts` (Task 5).
- Produces: no new exports — `PhaseState`'s rendered `.phase-state-track` element now carries `--cadence-duration`/`--sweep-duration` inline custom properties scaled to `event.tgRate`/`event.ppRate`. Both `PhaseState` (Playground) and `RaceLane` (Race, which renders `<PhaseState .../>` directly) pick this up with no further changes.

- [ ] **Step 1: Update the import**

In `src/components/SimulatorPieces.tsx:45`, change:

```ts
import { phaseTrackVisualState } from "../lib/phaseProgress";
```

to:

```ts
import { cadenceDurationMs, phaseTrackVisualState, sweepDurationMs } from "../lib/phaseProgress";
```

- [ ] **Step 2: Extend `trackStyle` in `PhaseState`**

In `src/components/SimulatorPieces.tsx:117-121`, change:

```ts
  const trackStyle = {
    "--phase-fill-width": trackVisual.fillWidth,
    "--phase-pip-left": trackVisual.pipLeft
  } as CSSProperties;
```

to:

```ts
  const trackStyle = {
    "--phase-fill-width": trackVisual.fillWidth,
    "--phase-pip-left": trackVisual.pipLeft,
    "--cadence-duration": `${cadenceDurationMs(event.tgRate)}ms`,
    "--sweep-duration": `${sweepDurationMs(event.ppRate)}ms`
  } as CSSProperties;
```

- [ ] **Step 3: Typecheck and build**

Run: `npm --userconfig=/dev/null run build`
Expected: passes (this exercises `tsc -b`, which will catch any type mismatch in the new `CSSProperties` entries).

- [ ] **Step 4: Run the full test suite**

Run: `npm --userconfig=/dev/null run test`
Expected: passes, no changes expected to any existing test outcomes.

- [ ] **Step 5: Browser-verify**

Start the dev server: `npm --userconfig=/dev/null run dev -- --port 4530` (or another free port). Using `playwright-cli`, open Playground, pick two results with visibly different decode throughput (e.g. a slow large-model config and a fast small-model config), play a scenario for each, and confirm the decode "tick" texture inside the phase progress bar visibly ticks faster for the faster config. Then repeat in Race with two lanes at different rates running side by side. Close the dev server when done.

- [ ] **Step 6: Commit**

```bash
git add src/components/SimulatorPieces.tsx
git commit -m "Scale phase-progress cadence/sweep motion to the active event's real rate"
```

---

## Task 7: Shared collapsible `ThinkingStream` component + auto-scroll-tail for all active generated text

**Files:**
- Modify: `src/components/SimulatorPieces.tsx` (add `ThinkingStream`; update `Transcript` and `RaceLane`)
- Modify: `src/styles.css` (add `.thinking-row-scroll`)

**Interfaces:**
- Consumes: `Disclosure` (already defined earlier in the same file), `formatClock`/`formatNumber` (already imported), `TimelineEvent` (already imported).
- Produces: `ThinkingStream({ event, streamedText, streamedTokens, active, showCursor }): JSX.Element`, exported from `src/components/SimulatorPieces.tsx`, used by both `Transcript` and `RaceLane`.

- [ ] **Step 1: Add the `ThinkingStream` component**

In `src/components/SimulatorPieces.tsx`, insert immediately after the `Disclosure` function closes (after line 188, before the `SearchSelectProps` interface):

```tsx
// Live while its event is streaming (expanded, auto-scrolling tail so the
// newest text stays in view); once that turn completes and playback moves
// on, collapses to a one-line summary via the shared Disclosure pattern,
// expandable back open to inspect the full finished trace. Shared between
// Transcript (Playground) and RaceLane (Race) -- see
// docs/superpowers/specs/2026-07-09-thinking-token-streaming-design.md.
export function ThinkingStream({
  event,
  streamedText,
  streamedTokens,
  active,
  showCursor
}: {
  event: TimelineEvent;
  streamedText: string;
  streamedTokens: number;
  active: boolean;
  showCursor: boolean;
}) {
  const tailRef = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    if (!active) return;
    tailRef.current?.scrollIntoView({ block: "end" });
  }, [active, streamedText]);

  if (!active) {
    return (
      <Disclosure label={`Thought for ${formatClock(event.decodeMs)} · ${formatNumber(event.tokens)} tok`}>
        <div className="thinking-row">
          <div className="thinking-row-scroll">
            <p>{streamedText}</p>
          </div>
        </div>
      </Disclosure>
    );
  }

  return (
    <div className="thinking-row">
      <span>
        › THINKING · {formatNumber(streamedTokens)} / {formatNumber(event.tokens)} tokens
      </span>
      <div className="thinking-row-scroll">
        <p ref={tailRef}>
          {streamedText}
          {showCursor ? <span className="cursor">▍</span> : null}
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the `.thinking-row-scroll` CSS rule**

In `src/styles.css`, immediately after the `.thinking-row p { ... }` rule (after line 1183, before `.cursor`), insert:

```css
.thinking-row-scroll {
  max-height: 220px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
```

- [ ] **Step 3: Relax the scroll cap on the mobile stacking breakpoint**

In `src/styles.css`, inside the `@media (max-width: 980px)` block (starts at line 4109), immediately after the existing rule:

```css
  .race-output-event pre,
  .race-output-event .tool-result {
    max-height: none;
    overflow: visible;
  }
```

insert:

```css
  .thinking-row-scroll {
    max-height: none;
    overflow: visible;
  }
```

- [ ] **Step 4: Wire `ThinkingStream` and an auto-scroll-tail ref into `Transcript`**

In `src/components/SimulatorPieces.tsx`, replace the `Transcript` function body (currently lines 529–605) with:

```tsx
export function Transcript({
  events,
  activeIndex,
  elapsedMs,
  cacheMode,
  runtimeCache
}: {
  events: TimelineEvent[];
  activeIndex: number;
  elapsedMs: number;
  cacheMode: CacheMode;
  runtimeCache: RuntimeMetadata["cache"];
}) {
  const visibleEvents = events.slice(0, Math.max(1, activeIndex + 1));
  const activeRef = useRef<HTMLElement | null>(null);
  const tailRef = useRef<HTMLElement | null>(null);
  const cacheEnabled = cacheMode === "on" || (cacheMode === "runtime" && runtimeCache === "prefix");
  const activeEvent = events[activeIndex];
  const activeStreamedText = activeEvent ? streamFrameForEvent(activeEvent, elapsedMs).text : "";

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // Keep the newest streamed text of the active event in view as it grows,
  // independent of the whole-article scroll above -- needed now that
  // generated text runs far longer than the transcript's visible height.
  useEffect(() => {
    tailRef.current?.scrollIntoView({ block: "end" });
  }, [activeIndex, activeStreamedText]);

  return (
    <div className="transcript">
      <div className="system-chip">
        <span>SYSTEM PROMPT · {cacheEnabled ? "cache eligible" : "cache off"}</span>
        <span>{cacheEnabled ? "prefix reusable" : "full prefill"}</span>
      </div>
      {visibleEvents.map((event) => {
        const active = event.index === activeIndex;
        const streamFrame = streamFrameForEvent(event, active ? elapsedMs : event.endMs);
        const streamedText = streamFrame.text;
        const streamedTokens = streamFrame.tokens;
        const showCursor = active && isGeneratedEvent(event) && streamedText.length < event.text.length;
        return (
          <article
            key={event.id}
            ref={active ? activeRef : undefined}
            className={`transcript-event event-${event.role} ${active ? "current" : ""}`}
          >
            <div className="event-head">
              <span>{eventLabel(event)}</span>
              <span>
                {isGeneratedEvent(event) && active
                  ? `${formatNumber(streamedTokens)} / ${formatNumber(event.tokens)} tok`
                  : `${formatNumber(event.tokens)} tok`}
              </span>
              {event.cacheBust && <span className="warn-text">re-prefilled · cache bust</span>}
            </div>
            {event.role === "tool_call" ? (
              <pre ref={active ? tailRef : undefined}>
                {streamedText}
                {showCursor ? <span className="cursor">▍</span> : null}
              </pre>
            ) : event.role === "tool_result" ? (
              <div className="tool-result">{event.text}</div>
            ) : event.role === "thinking" ? (
              <ThinkingStream
                event={event}
                streamedText={streamedText}
                streamedTokens={streamedTokens}
                active={active}
                showCursor={showCursor}
              />
            ) : (
              <p ref={active ? tailRef : undefined}>
                {streamedText}
                {showCursor ? <span className="cursor">▍</span> : null}
              </p>
            )}
          </article>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 5: Wire `ThinkingStream` and an auto-scroll-tail ref into `RaceLane`**

In `src/components/SimulatorPieces.tsx`, in the `RaceLane` function:

First, after the existing `const activeOutputRef = useRef<HTMLElement | null>(null);` line, add:

```tsx
  const tailRef = useRef<HTMLElement | null>(null);
  const activeStreamedText = streamFrameForEvent(activeEvent, elapsedMs).text;
```

Then, after the existing:

```tsx
  useEffect(() => {
    activeOutputRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeEvent.index]);
```

add:

```tsx
  // Keep the newest streamed text of the active event in view as it grows,
  // independent of the whole-card scroll above.
  useEffect(() => {
    tailRef.current?.scrollIntoView({ block: "end" });
  }, [activeEvent.index, activeStreamedText]);
```

Then, inside the `outputEvents.map((event) => { ... })` callback, replace:

```tsx
                    {waitingForOutput ? (
                      <p className="race-output-waiting">{waitingCopy}</p>
                    ) : event.role === "tool_call" ? (
                      <pre>
                        {streamedText}
                        {showCursor ? <span className="cursor">▍</span> : null}
                      </pre>
                    ) : event.role === "tool_result" ? (
                      <div className="tool-result">{event.text}</div>
                    ) : event.role === "thinking" ? (
                      <div className="thinking-row">
                        <span>
                          › THINKING · {formatNumber(streamFrame.tokens)} / {formatNumber(event.tokens)} tokens
                        </span>
                        <p>
                          {streamedText}
                          {showCursor ? <span className="cursor">▍</span> : null}
                        </p>
                      </div>
                    ) : (
                      <p>
                        {streamedText}
                        {showCursor ? <span className="cursor">▍</span> : null}
                      </p>
                    )}
```

with:

```tsx
                    {waitingForOutput ? (
                      <p className="race-output-waiting">{waitingCopy}</p>
                    ) : event.role === "tool_call" ? (
                      <pre ref={eventActive ? tailRef : undefined}>
                        {streamedText}
                        {showCursor ? <span className="cursor">▍</span> : null}
                      </pre>
                    ) : event.role === "tool_result" ? (
                      <div className="tool-result">{event.text}</div>
                    ) : event.role === "thinking" ? (
                      <ThinkingStream
                        event={event}
                        streamedText={streamedText}
                        streamedTokens={streamFrame.tokens}
                        active={eventActive}
                        showCursor={showCursor}
                      />
                    ) : (
                      <p ref={eventActive ? tailRef : undefined}>
                        {streamedText}
                        {showCursor ? <span className="cursor">▍</span> : null}
                      </p>
                    )}
```

- [ ] **Step 6: Typecheck and build**

Run: `npm --userconfig=/dev/null run build`
Expected: passes.

- [ ] **Step 7: Run the full test suite**

Run: `npm --userconfig=/dev/null run test`
Expected: passes, no changes expected to any existing test outcomes (no test exercises `SimulatorPieces.tsx` directly — this repo has no component-test harness, per Global Constraints).

- [ ] **Step 8: Browser-verify Playground**

Start the dev server: `npm --userconfig=/dev/null run dev -- --port 4530` (or another free port). Using `playwright-cli`, open `#playground`, select the `reasoning-math` scenario, press play, and confirm: the thinking text now reveals continuously (no multi-second dead pauses followed by a word jump), the visible text auto-follows as it grows past the transcript's viewport, and once the thinking turn completes it collapses to a `Thought for Xs · Y tok` summary line that expands back open on click to show the full finished text. Repeat with the `repo-wide-refactor` scenario (longer thinking turns, exercises the scroll cap more).

- [ ] **Step 9: Browser-verify Race**

In the same browser session, navigate to `#race`, configure both lanes to run the `repo-wide-refactor` scenario (different hardware/model is fine), start the race, and confirm: the live-output panel's thinking block streams continuously and auto-scrolls to keep the newest text visible within its bounded height, collapses once that turn completes as the lane moves to the next turn, and the panel never overflows its card or causes horizontal scroll. Confirm no console errors via `read_console_messages`.

- [ ] **Step 10: Commit**

```bash
git add src/components/SimulatorPieces.tsx src/styles.css
git commit -m "Add shared ThinkingStream component with collapse-on-complete and auto-scroll-tail"
```

---

## Self-Review Notes

- **Spec coverage:** Design section 1 (content rewrite) → Tasks 1–3. Section 2 (shared `ThinkingStream`, collapse-after-active) → Task 7 Steps 1–5. Section 3 (auto-scroll-tail for all active generated text) → Task 7 Steps 4–5 (the `tailRef` wiring applies to `assistant`/`tool_call` branches, not just `thinking`). Section 4 (data-integrity guard) → Task 4. Section 5 (cadence/sweep scaling) → Tasks 5–6. Testing & verification section → covered per-task (Vitest for schema/lib changes, browser verification for UI changes, full pipeline run woven through Tasks 4, 6, 7).
- **Ordering rationale:** content tasks (1–3) precede the schema guard (4) specifically so no commit in this plan leaves `validate:data` failing.
- **No placeholders:** content tasks specify exact target ranges and per-event authorial direction rather than "write appropriate text," since this repo has no way to pre-author ~11,500 words of scenario prose inside a plan document itself — verification is by computed ratio (Step "Verify density" in each content task), not literal text comparison.
