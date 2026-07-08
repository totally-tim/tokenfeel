import { useEffect, useMemo, useRef, useState } from "react";
import { activeEventAt, buildTimeline, summarizeTimeline } from "../sim/timing";
import type { BenchmarkResult, CacheMode, ScenarioScript } from "../types";

interface UsePlaybackInput {
  result: BenchmarkResult;
  scenario: ScenarioScript;
  cacheMode: CacheMode;
  speed: number;
  autoStart?: boolean;
}

export function usePlayback({ result, scenario, cacheMode, speed, autoStart = false }: UsePlaybackInput) {
  const timeline = useMemo(() => buildTimeline({ result, scenario, cacheMode }), [result, scenario, cacheMode]);
  const summary = useMemo(() => summarizeTimeline(timeline), [timeline]);
  const [isPlaying, setIsPlaying] = useState(autoStart);
  const [hasStarted, setHasStarted] = useState(autoStart);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAtRef = useRef<number>(0);
  const elapsedRef = useRef<number>(0);

  const setPlaybackElapsed = (next: number) => {
    elapsedRef.current = next;
    setElapsedMs(next);
  };

  useEffect(() => {
    setPlaybackElapsed(0);
    setIsPlaying(autoStart);
    setHasStarted(autoStart);
    startedAtRef.current = performance.now();
  }, [timeline, autoStart]);

  useEffect(() => {
    if (!isPlaying) return undefined;

    const segmentStartElapsedMs = elapsedRef.current;
    startedAtRef.current = performance.now();
    let raf = 0;

    const tick = (now: number) => {
      const rawElapsed = segmentStartElapsedMs + (now - startedAtRef.current) * speed;
      const next = Math.min(rawElapsed, timeline.totalMs);
      setPlaybackElapsed(next);
      if (next >= timeline.totalMs) {
        setIsPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, speed, timeline.totalMs]);

  const activeEvent = activeEventAt(timeline, elapsedMs);
  const progress = timeline.totalMs === 0 ? 1 : Math.min(1, elapsedMs / timeline.totalMs);
  const isComplete = hasStarted && elapsedMs >= timeline.totalMs;

  return {
    timeline,
    summary,
    activeEvent,
    elapsedMs,
    progress,
    isPlaying,
    hasStarted,
    isComplete,
    setIsPlaying,
    // Arrow functions (not method shorthand) so these can be handed around
    // and called standalone -- e.g. `onPlay={playback.restart}` -- without
    // any implicit `this` binding concerns.
    restart: () => {
      setPlaybackElapsed(0);
      startedAtRef.current = performance.now();
      setHasStarted(true);
      setIsPlaying(true);
    },
    pause: () => {
      setIsPlaying(false);
    },
    reset: () => {
      setPlaybackElapsed(0);
      startedAtRef.current = performance.now();
      setHasStarted(false);
      setIsPlaying(false);
    }
  };
}
