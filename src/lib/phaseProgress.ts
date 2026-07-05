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
