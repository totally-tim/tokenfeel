import { describe, expect, test } from "vitest";
import { raceNeedsSetupReset, raceSetupCollapsed } from "./raceSession";

describe("race session invariants", () => {
  test("keeps setup changes from leaving only one lane reset mid-race", () => {
    expect(raceNeedsSetupReset({ leftStarted: false, rightStarted: false })).toBe(false);
    expect(raceNeedsSetupReset({ leftStarted: true, rightStarted: false })).toBe(true);
    expect(raceNeedsSetupReset({ leftStarted: false, rightStarted: true })).toBe(true);
    expect(raceNeedsSetupReset({ leftStarted: true, rightStarted: true })).toBe(true);
  });

  test("keeps the pickers collapsed from Start through the finish until Edit setup", () => {
    expect(raceSetupCollapsed({ started: false, setupOpen: false })).toBe(false);
    expect(raceSetupCollapsed({ started: true, setupOpen: false })).toBe(true);
    expect(raceSetupCollapsed({ started: true, setupOpen: true })).toBe(false);
    expect(raceSetupCollapsed({ started: false, setupOpen: true })).toBe(false);
  });
});
