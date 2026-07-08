// The core "what is this event doing right now" display state machine,
// extracted from SimulatorPieces.tsx so it is testable without mounting a
// component. Drives PhaseState (Playground) and RaceLane (Race): given a
// timeline event and the current playback clock, decides which phase
// (idle/tool/prefill/decode/complete/instant) is active and how far through
// it playback has progressed.
import { decodeProgressForEvent } from "./streaming";
import type { TimelineEvent } from "../types";

export type PhaseKind = "idle" | "tool" | "prefill" | "decode" | "complete" | "instant";

export interface ActivePhase {
  kind: PhaseKind;
  elapsedMs: number;
  totalMs: number;
  progress: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function phaseProgress(elapsedMs: number, startMs: number, endMs: number): number {
  return clamp01((elapsedMs - startMs) / Math.max(1, endMs - startMs));
}

export function activePhaseForEvent(event: TimelineEvent, elapsedMs: number, hasStarted: boolean, complete: boolean): ActivePhase {
  if (!hasStarted) {
    return {
      kind: "idle",
      elapsedMs: 0,
      totalMs: Math.max(1, event.endMs - event.startMs),
      progress: 0
    };
  }

  if (complete || elapsedMs >= event.endMs) {
    return {
      kind: "complete",
      elapsedMs: event.endMs - event.startMs,
      totalMs: Math.max(1, event.endMs - event.startMs),
      progress: 1
    };
  }

  if (event.toolLatencyMs > 0 && elapsedMs < event.toolDoneMs) {
    return {
      kind: "tool",
      elapsedMs: Math.max(0, elapsedMs - event.startMs),
      totalMs: Math.max(1, event.toolLatencyMs),
      progress: phaseProgress(elapsedMs, event.startMs, event.toolDoneMs)
    };
  }

  if (event.prefillMs > 0 && elapsedMs < event.prefillDoneMs) {
    return {
      kind: "prefill",
      elapsedMs: Math.max(0, elapsedMs - event.toolDoneMs),
      totalMs: Math.max(1, event.prefillMs),
      progress: phaseProgress(elapsedMs, event.toolDoneMs, event.prefillDoneMs)
    };
  }

  if (event.decodeMs > 0 && elapsedMs < event.endMs) {
    return {
      kind: "decode",
      elapsedMs: Math.max(0, elapsedMs - event.prefillDoneMs),
      totalMs: Math.max(1, event.decodeMs),
      progress: decodeProgressForEvent(event, elapsedMs)
    };
  }

  return {
    kind: "instant",
    elapsedMs: Math.max(0, elapsedMs - event.startMs),
    totalMs: Math.max(1, event.endMs - event.startMs),
    progress: 1
  };
}
