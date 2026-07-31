import { describe, expect, test } from "vitest";
import { cadenceDurationMs, phaseTrackVisualState, sweepDurationMs } from "./phaseProgress";

describe("phase track visual state", () => {
  test("uses exact proportional fill instead of a minimum-width fake progress", () => {
    expect(phaseTrackVisualState(0.006)).toEqual({
      ariaValueNow: 1,
      fillWidth: "0.6%",
      pipLeft: "0.6%"
    });
  });

  test("clamps the visual state to progressbar bounds", () => {
    expect(phaseTrackVisualState(-0.4)).toEqual({
      ariaValueNow: 0,
      fillWidth: "0%",
      pipLeft: "0%"
    });
    expect(phaseTrackVisualState(1.4)).toEqual({
      ariaValueNow: 100,
      fillWidth: "100%",
      pipLeft: "100%"
    });
  });

  test("keeps idle bars visually empty", () => {
    expect(phaseTrackVisualState(0.5, true)).toEqual({
      ariaValueNow: 0,
      fillWidth: "0%",
      pipLeft: "0%"
    });
  });

  test("coerces non-finite progress to an empty bar so NaN never reaches ariaValueNow or the width strings (A5)", () => {
    const state = phaseTrackVisualState(Number.NaN);
    expect(state).toEqual({ ariaValueNow: 0, fillWidth: "0%", pipLeft: "0%" });
    expect(Number.isNaN(state.ariaValueNow)).toBe(false);
    expect(state.fillWidth).not.toContain("NaN");
    expect(state.pipLeft).not.toContain("NaN");

    // Infinity must not sail through Math.min as a real value either.
    expect(phaseTrackVisualState(Number.POSITIVE_INFINITY)).toEqual({
      ariaValueNow: 0,
      fillWidth: "0%",
      pipLeft: "0%"
    });
  });
});

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

describe("speed multiplier is honored in motion durations", () => {
  // usePlayback scales wall-clock by `speed`, so tokens at 4x land four times
  // faster. If the cadence/sweep textures ignored the multiplier they would
  // animate at 1x while the schedule ran at 4x -- a lane whose motion
  // contradicts its own clock.
  test("cadenceDurationMs divides by the speed multiplier", () => {
    expect(cadenceDurationMs(50, 1)).toBe(900);
    expect(cadenceDurationMs(50, 2)).toBe(450);
    expect(cadenceDurationMs(25, 2)).toBe(900);
  });

  test("sweepDurationMs divides by the speed multiplier", () => {
    expect(sweepDurationMs(800, 1)).toBe(1150);
    expect(sweepDurationMs(800, 2)).toBe(575);
    expect(sweepDurationMs(400, 2)).toBe(1150);
  });

  test("defaults to 1x when no multiplier is supplied", () => {
    expect(cadenceDurationMs(50)).toBe(cadenceDurationMs(50, 1));
    expect(sweepDurationMs(800)).toBe(sweepDurationMs(800, 1));
  });

  test("a non-positive or non-finite multiplier falls back to 1x rather than dividing by zero", () => {
    expect(cadenceDurationMs(50, 0)).toBe(900);
    expect(cadenceDurationMs(50, -4)).toBe(900);
    expect(cadenceDurationMs(50, Number.NaN)).toBe(900);
    expect(sweepDurationMs(800, 0)).toBe(1150);
    expect(sweepDurationMs(800, Number.POSITIVE_INFINITY)).toBe(1150);
  });

  test("the motion floor still applies after the multiplier, so high speeds clamp", () => {
    // 900 / 8 = 112.5ms, below the 300ms flicker floor.
    expect(cadenceDurationMs(50, 8)).toBe(300);
    expect(sweepDurationMs(800, 8)).toBe(300);
  });

  test("a non-positive rate still respects the multiplier", () => {
    expect(cadenceDurationMs(0, 2)).toBe(450);
    expect(sweepDurationMs(0, 2)).toBe(575);
  });
});
