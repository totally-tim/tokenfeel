import { describe, expect, test } from "vitest";
import type { Timeline } from "../types";
import { playbackProgress } from "./playbackProgress";

// Only totalMs is read by playbackProgress, so a minimal cast keeps the fixture
// focused on the state under test without constructing a whole timeline.
const timelineWith = (totalMs: number): Timeline => ({ totalMs }) as Timeline;

describe("playbackProgress", () => {
  test("reports progress 1 for a zero-length timeline but stays incomplete until started", () => {
    const zero = timelineWith(0);
    // progress and isComplete are distinct signals: a zero-length timeline is
    // fully "progressed" yet not "complete" until playback has begun.
    expect(playbackProgress(zero, 0, false)).toEqual({ progress: 1, isComplete: false });
    expect(playbackProgress(zero, 0, true)).toEqual({ progress: 1, isComplete: true });
  });

  test("is complete once elapsed reaches or passes totalMs, clamping progress to 1", () => {
    const timeline = timelineWith(1000);
    expect(playbackProgress(timeline, 1000, true)).toEqual({ progress: 1, isComplete: true });
    expect(playbackProgress(timeline, 5000, true)).toEqual({ progress: 1, isComplete: true });
  });

  test("never reports complete before playback has started, even past the end", () => {
    const timeline = timelineWith(1000);
    expect(playbackProgress(timeline, 5000, false).isComplete).toBe(false);
  });

  test("reports a mid-run fraction while playing", () => {
    const timeline = timelineWith(1000);
    const state = playbackProgress(timeline, 250, true);
    expect(state.progress).toBeCloseTo(0.25);
    expect(state.isComplete).toBe(false);
  });
});
