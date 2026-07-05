import { describe, expect, test } from "vitest";
import { phaseTrackVisualState } from "./phaseProgress";

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
});
