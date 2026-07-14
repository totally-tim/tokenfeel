import type { Timeline } from "../types";

export interface PlaybackProgress {
  /** 0..1 fraction of the timeline elapsed; 1 for a zero-length timeline. */
  progress: number;
  /** True only once playback has started AND reached the end of the timeline. */
  isComplete: boolean;
}

/**
 * Derives playback position state (progress fraction + completion flag) from a
 * timeline, elapsed wall-clock ms, and whether playback has begun. Pure and
 * DOM-free so it can be unit-tested without a React render:
 * - progress clamps to [0, 1] and is 1 for a zero-length (totalMs === 0)
 *   timeline, which has no span to advance through;
 * - isComplete stays false until `hasStarted`, so an idle zero-length timeline
 *   reads as "not complete" even though its progress is already 1 -- the two
 *   are distinct signals, not the same thing.
 */
export function playbackProgress(timeline: Timeline, elapsedMs: number, hasStarted: boolean): PlaybackProgress {
  const { totalMs } = timeline;
  const progress = totalMs === 0 ? 1 : Math.min(1, Math.max(0, elapsedMs) / totalMs);
  const isComplete = hasStarted && elapsedMs >= totalMs;
  return { progress, isComplete };
}
