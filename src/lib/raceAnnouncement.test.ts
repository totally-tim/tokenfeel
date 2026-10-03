import { describe, expect, it } from "vitest";
import { raceFinishAnnouncement } from "./raceAnnouncement";

const running = (wallTimeMs: number) => ({ complete: false, wallTimeMs });
const done = (wallTimeMs: number) => ({ complete: true, wallTimeMs });

describe("raceFinishAnnouncement", () => {
  it("stays silent while neither lane has finished, so projected times are never announced", () => {
    expect(raceFinishAnnouncement(running(12_000), running(30_000), { winner: "left", deltaMs: 18_000 })).toBe("");
  });

  it("announces the first lane to finish with its final time and no verdict", () => {
    expect(raceFinishAnnouncement(done(12_000), running(30_000), { winner: "left", deltaMs: 18_000 })).toBe(
      "Lane A finished in 12.0s."
    );
    expect(raceFinishAnnouncement(running(30_000), done(12_000), { winner: "right", deltaMs: 18_000 })).toBe(
      "Lane B finished in 12.0s."
    );
  });

  it("announces the slower lane and the verdict once both lanes finish", () => {
    expect(raceFinishAnnouncement(done(12_000), done(90_000), { winner: "left", deltaMs: 78_000 })).toBe(
      "Lane B finished in 1:30.0. Lane A won by 1:18.0."
    );
    expect(raceFinishAnnouncement(done(90_000), done(12_000), { winner: "right", deltaMs: 78_000 })).toBe(
      "Lane A finished in 1:30.0. Lane B won by 1:18.0."
    );
  });

  it("uses the same too-close wording as the gap summary when the verdict is uncertain", () => {
    expect(raceFinishAnnouncement(done(12_000), done(12_400), { winner: "too-close", deltaMs: 400 })).toBe(
      "Lane B finished in 12.4s. Too close to call from this data."
    );
  });

  it("names both lanes when they finish at the same time", () => {
    expect(raceFinishAnnouncement(done(12_000), done(12_000), { winner: "too-close", deltaMs: 0 })).toBe(
      "Both lanes finished in 12.0s. Too close to call from this data."
    );
  });

  it("changes text only at a finish, so a live region announces each transition once", () => {
    const verdict = { winner: "left" as const, deltaMs: 18_000 };
    const frames = [
      raceFinishAnnouncement(running(12_000), running(30_000), verdict),
      raceFinishAnnouncement(running(12_000), running(30_000), verdict),
      raceFinishAnnouncement(done(12_000), running(30_000), verdict),
      raceFinishAnnouncement(done(12_000), running(30_000), verdict),
      raceFinishAnnouncement(done(12_000), done(30_000), verdict),
      raceFinishAnnouncement(done(12_000), done(30_000), verdict)
    ];
    const transitions = frames.filter((text, index) => index > 0 && text !== frames[index - 1]);
    expect(transitions).toEqual(["Lane A finished in 12.0s.", "Lane B finished in 30.0s. Lane A won by 18.0s."]);
  });
});
