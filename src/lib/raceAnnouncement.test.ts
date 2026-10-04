import { describe, expect, it } from "vitest";
import {
  RACE_STATUS_MIN_DISPLAY_MS,
  raceLogUpdates,
  raceStatusText,
  type RaceLaneSnapshot,
  type RaceLogEntry
} from "./raceAnnouncement";
import type { RaceVerdict } from "./raceComparison";

const frameMs = 1000 / 60;
const started: RaceLogEntry = { at: 0, kind: "action", text: "Race started." };

interface Change {
  at: number;
  text: string;
}

function lane(totalMs: number, simMs: number): RaceLaneSnapshot {
  return { started: true, progress: Math.min(1, simMs / totalMs), complete: simMs >= totalMs, wallTimeMs: totalMs };
}

/**
 * Mirrors RacePage: each animation frame observes both lanes, appends what the
 * detector reports, then renders the status text at that frame's time. The
 * page stops rendering once both lanes are complete, so the last change is
 * read at the completion frame and never at a later time.
 */
function simulateRace(totalA: number, totalB: number, speed: number, verdict: RaceVerdict) {
  let log: RaceLogEntry[] = [started];
  const changes: Change[] = [{ at: 0, text: raceStatusText(log, 0, verdict) }];
  for (let at = frameMs; ; at += frameMs) {
    const simMs = at * speed;
    log = [...log, ...raceLogUpdates(log, { A: lane(totalA, simMs), B: lane(totalB, simMs) }, at)];
    const text = raceStatusText(log, at, verdict);
    if (text !== changes[changes.length - 1].text) changes.push({ at, text });
    if (simMs >= Math.max(totalA, totalB)) return changes;
  }
}

function hasNewerEntry(text: string, lane: string, percent: number) {
  if (text.includes(`Lane ${lane} finished`)) return true;
  return [...text.matchAll(new RegExp(`Lane ${lane} (\\d+)%`, "g"))].some((match) => Number(match[1]) > percent);
}

// A replacement that comes sooner than the minimum display time counts as
// dropping the text it replaces, unless the new text still contains it. The
// only exception is a mark that the new text replaces with a newer mark or the
// finish of the same lane. A scheduled change renders on the first frame after
// it is due, so the time a text stays up can fall short of the minimum by up to
// one frame.
function expectNothingDropped(changes: Change[]) {
  changes.slice(1).forEach((change, index) => {
    const previous = changes[index];
    if (change.at - previous.at >= RACE_STATUS_MIN_DISPLAY_MS - frameMs) return;
    const kept = previous.text
      .replace(/Lane ([AB]) (\d+)%\. ?/g, (mark, lane: string, percent: string) =>
        hasNewerEntry(change.text, lane, Number(percent)) ? "" : mark
      )
      .trim();
    expect(change.text).toContain(kept);
  });
}

describe("raceLogUpdates", () => {
  const verdict: RaceVerdict = { winner: "left", deltaMs: 1000 };

  it("logs nothing for a lane that has not started, even when a zero-length timeline reports full progress", () => {
    const idle = { started: false, progress: 1, complete: false, wallTimeMs: 0 };
    expect(raceLogUpdates([], { A: idle, B: idle }, 5)).toEqual([]);
  });

  it("logs only the furthest mark when a lane passes two marks between observations", () => {
    const log = [started];
    const updates = raceLogUpdates(log, { A: lane(40_000, 22_000), B: lane(60_000, 0) }, 5_000);
    expect(updates).toEqual([{ at: 5_000, kind: "mark", lane: "A", quarter: 2 }]);
    const later = [...log, ...updates];
    expect(raceLogUpdates(later, { A: lane(40_000, 25_000), B: lane(60_000, 0) }, 5_100)).toEqual([]);
    expect(raceStatusText(later, 5_100, verdict)).toBe("Lane A 50%.");
  });

  it("lets a finish supersede the lane's own 75% when both happen between observations", () => {
    const log: RaceLogEntry[] = [started, { at: 5_000, kind: "mark", lane: "A", quarter: 2 }];
    expect(raceLogUpdates(log, { A: lane(40_000, 40_000), B: lane(60_000, 40_000) }, 9_000)).toEqual([
      { at: 9_000, kind: "finish", lane: "A", wallTimeMs: 40_000 },
      { at: 9_000, kind: "mark", lane: "B", quarter: 2 }
    ]);
  });
});

describe("raceStatusText over a simulated race", () => {
  it("announces each lane's 25, 50 and 75% exactly once at 1x", () => {
    const changes = simulateRace(40_000, 60_000, 1, { winner: "left", deltaMs: 20_000 });
    for (const part of ["Lane A 25%.", "Lane A 50%.", "Lane A 75%.", "Lane B 25%.", "Lane B 50%.", "Lane B 75%."]) {
      expect(changes.filter((change) => change.text.includes(part))).toHaveLength(1);
    }
    expect(changes.map((change) => change.text)).toEqual([
      "Race started.",
      "Lane A 25%.",
      "Lane B 25%.",
      "Lane A 50%.",
      "Lane A 75%. Lane B 50%.",
      "Lane A finished in 40.0s.",
      "Lane B 75%.",
      "Lane B finished in 1:00.0. Race finished. Lane A won by 20.0s."
    ]);
    expectNothingDropped(changes);
  });

  it("merges two lanes that cross the same mark in the same frame into one string", () => {
    const changes = simulateRace(40_000, 40_000, 1, { winner: "too-close", deltaMs: 0 });
    expect(changes.map((change) => change.text)).toEqual([
      "Race started.",
      "Lane A 25%. Lane B 25%.",
      "Lane A 50%. Lane B 50%.",
      "Lane A 75%. Lane B 75%.",
      "Lane A finished in 40.0s. Lane B finished in 40.0s. Race finished. Too close to call from this data."
    ]);
  });

  it("announces both lanes when they cross a mark within 200 ms of each other", () => {
    const changes = simulateRace(40_000, 40_600, 1, { winner: "too-close", deltaMs: 600 });
    expect(changes.map((change) => change.text)).toEqual([
      "Race started.",
      "Lane A 25%.",
      "Lane B 25%.",
      "Lane A 50%.",
      "Lane B 50%.",
      "Lane A 75%.",
      "Lane B 75%.",
      "Lane A finished in 40.0s.",
      "Lane B finished in 40.6s. Race finished. Too close to call from this data."
    ]);
    expectNothingDropped(changes);
  });

  it("keeps a quartile that lands in the same frame as the other lane's finish", () => {
    const changes = simulateRace(30_000, 40_000, 1, { winner: "left", deltaMs: 10_000 });
    expect(changes.map((change) => change.text)).toContain("Lane A finished in 30.0s. Lane B 75%.");
    expectNothingDropped(changes);
  });

  it("replaces a young 75% with the same lane's finish instead of repeating it", () => {
    // At 8x, each lane shows 75% and finishes about 300 ms later, before that
    // text has been up for the minimum display time.
    const changes = simulateRace(24_000, 17_500, 8, { winner: "right", deltaMs: 6_500 });
    expect(changes.map((change) => change.text)).toEqual([
      "Race started.",
      "Lane B 25%.",
      "Lane A 25%.",
      "Lane B 50%. Lane A 50%.",
      "Lane B 75%.",
      "Lane B finished in 17.5s.",
      "Lane A 75%.",
      "Lane A finished in 24.0s. Race finished. Lane B won by 6.5s."
    ]);
    expectNothingDropped(changes);
  });

  it("keeps only each lane's newest unspoken mark in a short race at 8x", () => {
    // Every mark arrives while "Race started." is still young, so they all wait,
    // and the first finish takes the one that is still current along.
    const changes = simulateRace(4_000, 4_800, 8, { winner: "left", deltaMs: 800 });
    expect(changes.map((change) => change.text)).toEqual([
      "Race started.",
      "Lane B 75%. Lane A finished in 4.0s.",
      "Lane A finished in 4.0s. Lane B finished in 4.8s. Race finished. Lane A won by 0.8s."
    ]);
    expectNothingDropped(changes);
  });

  it("replaces a lane's waiting mark with its newer one and keeps the other lane's", () => {
    const verdict: RaceVerdict = { winner: "left", deltaMs: 1_000 };
    const log: RaceLogEntry[] = [
      started,
      { at: 100, kind: "mark", lane: "A", quarter: 1 },
      { at: 150, kind: "mark", lane: "B", quarter: 1 },
      { at: 300, kind: "mark", lane: "A", quarter: 2 },
      { at: 450, kind: "mark", lane: "A", quarter: 3 }
    ];
    expect(raceStatusText(log, 499, verdict)).toBe("Race started.");
    expect(raceStatusText(log, 500, verdict)).toBe("Lane B 25%. Lane A 75%.");
  });

  it("drops a waiting quartile on Stop and shows no stale quartile afterwards", () => {
    const verdict: RaceVerdict = { winner: "left", deltaMs: 100 };
    let log: RaceLogEntry[] = [started];
    for (const [at, simMs] of [
      [10_000, 10_000],
      [10_100, 10_100]
    ]) {
      log = [...log, ...raceLogUpdates(log, { A: lane(40_000, simMs), B: lane(40_400, simMs) }, at)];
    }
    expect(raceStatusText(log, 10_100, verdict)).toBe("Lane A 25%.");

    const stopped: RaceLogEntry[] = [{ at: 10_200, kind: "action", text: "Race stopped and reset." }];
    const idle = { started: false, progress: 0, complete: false, wallTimeMs: 40_000 };
    for (let at = 10_200; at < 14_000; at += frameMs) {
      expect(raceLogUpdates(stopped, { A: idle, B: idle }, at)).toEqual([]);
      expect(raceStatusText(stopped, at, verdict)).toBe("Race stopped and reset.");
    }
  });
});
