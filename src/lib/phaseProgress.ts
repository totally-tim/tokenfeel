export interface PhaseTrackVisualState {
  ariaValueNow: number;
  fillWidth: string;
  pipLeft: string;
}

function clamp01(value: number): number {
  // Coerce non-finite input to 0 before clamping (A5): Math.min/Math.max
  // propagate NaN, which would otherwise reach ariaValueNow and the "NaN%"
  // width strings on the live DOM/ARIA.
  if (!Number.isFinite(value)) return 0;
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

// The playback speed multiplier scales wall-clock in usePlayback, so tokens at
// 8x land eight times faster. The cadence/sweep textures have to divide by the
// same multiplier or the animation contradicts the schedule it is describing.
// Note the [300ms, 2000ms] clamp still applies afterwards: past the floor the
// texture stops tracking the rate, because below ~3 ticks/sec it reads as
// flicker rather than as cadence.
function effectiveSpeed(speed: number): number {
  return speed > 0 && Number.isFinite(speed) ? speed : 1;
}

export function cadenceDurationMs(tgRate: number, speed = 1): number {
  const base = tgRate > 0 ? BASE_CADENCE_MS * (REFERENCE_TG_RATE / tgRate) : BASE_CADENCE_MS;
  return clampMotionMs(base / effectiveSpeed(speed));
}

export function sweepDurationMs(ppRate: number, speed = 1): number {
  const base = ppRate > 0 ? BASE_SWEEP_MS * (REFERENCE_PP_RATE / ppRate) : BASE_SWEEP_MS;
  return clampMotionMs(base / effectiveSpeed(speed));
}
