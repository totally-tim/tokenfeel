export interface PhaseTrackVisualState {
  ariaValueNow: number;
  fillWidth: string;
  pipLeft: string;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function formatPercent(value: number): string {
  return `${Number((value * 100).toFixed(4))}%`;
}

export function phaseTrackVisualState(progress: number, idle = false): PhaseTrackVisualState {
  const clamped = idle ? 0 : clamp01(progress);
  const fillWidth = formatPercent(clamped);

  return {
    ariaValueNow: Math.round(clamped * 100),
    fillWidth,
    pipLeft: fillWidth
  };
}

// Reference rates the original fixed 900ms/1150ms motion durations were
// tuned for -- at these rates, behavior is unchanged from before. Faster
// than the reference ticks faster (shorter duration); slower ticks slower.
// Clamped to [300ms, 2000ms] so pathological rates never produce a
// flickering or visually-frozen texture.
const REFERENCE_TG_RATE = 50;
const REFERENCE_PP_RATE = 800;
const BASE_CADENCE_MS = 900;
const BASE_SWEEP_MS = 1150;
const MIN_MOTION_MS = 300;
const MAX_MOTION_MS = 2000;

function clampMotionMs(ms: number): number {
  return Math.max(MIN_MOTION_MS, Math.min(MAX_MOTION_MS, ms));
}

export function cadenceDurationMs(tgRate: number): number {
  if (!(tgRate > 0)) return BASE_CADENCE_MS;
  return clampMotionMs(BASE_CADENCE_MS * (REFERENCE_TG_RATE / tgRate));
}

export function sweepDurationMs(ppRate: number): number {
  if (!(ppRate > 0)) return BASE_SWEEP_MS;
  return clampMotionMs(BASE_SWEEP_MS * (REFERENCE_PP_RATE / ppRate));
}
