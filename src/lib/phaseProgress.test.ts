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
