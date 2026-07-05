import { describe, expect, test } from "vitest";
import { raceNeedsSetupReset } from "./raceSession";

describe("race session invariants", () => {
  test("keeps setup changes from leaving only one lane reset mid-race", () => {
    expect(raceNeedsSetupReset({ leftStarted: false, rightStarted: false })).toBe(false);
    expect(raceNeedsSetupReset({ leftStarted: true, rightStarted: false })).toBe(true);
    expect(raceNeedsSetupReset({ leftStarted: false, rightStarted: true })).toBe(true);
    expect(raceNeedsSetupReset({ leftStarted: true, rightStarted: true })).toBe(true);
  });
});
