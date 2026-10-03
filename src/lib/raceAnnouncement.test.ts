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

  it("announces both final times and the verdict once both lanes finish", () => {
    expect(raceFinishAnnouncement(done(12_000), done(90_000), { winner: "left", deltaMs: 78_000 })).toBe(
      "Race finished. Lane A 12.0s, Lane B 1:30.0. Lane A won by 1:18.0."
    );
    expect(raceFinishAnnouncement(done(90_000), done(12_000), { winner: "right", deltaMs: 78_000 })).toBe(
      "Race finished. Lane A 1:30.0, Lane B 12.0s. Lane B won by 1:18.0."
    );
  });

  it("uses the gap summary's too-close wording and keeps both times when the verdict is uncertain", () => {
    expect(raceFinishAnnouncement(done(12_000), done(12_400), { winner: "too-close", deltaMs: 400 })).toBe(
      "Race finished. Lane A 12.0s, Lane B 12.4s. Too close to call from this data."
    );
  });

  it("keeps the faster lane's time when both lanes complete in the same frame", () => {
    const verdict = { winner: "left" as const, deltaMs: 100 };
    const before = raceFinishAnnouncement(running(19_000), running(19_100), verdict);
    const after = raceFinishAnnouncement(done(19_000), done(19_100), verdict);
    expect(before).toBe("");
    expect(after).toBe("Race finished. Lane A 19.0s, Lane B 19.1s. Lane A won by 0.1s.");
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
    expect(transitions).toEqual([
      "Lane A finished in 12.0s.",
      "Race finished. Lane A 12.0s, Lane B 30.0s. Lane A won by 18.0s."
    ]);
  });
});
