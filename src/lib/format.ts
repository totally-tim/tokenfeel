export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds - minutes * 60;
  return `${minutes}:${remaining.toFixed(seconds < 600 ? 1 : 0).padStart(seconds < 600 ? 4 : 2, "0")}`;
}

export function formatClock(ms: number): string {
  return formatSeconds(ms / 1000);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: value < 100 ? 1 : 0 }).format(value);
}

export function formatRate(value: number): string {
  return `${formatNumber(value)} t/s`;
}

export function formatTokens(value: number): string {
  if (value >= 10_000) {
    // Large counts drop the decimal -- "12k" instead of "12.3k" -- since a
    // tenth-of-a-k is not meaningful precision once we're into 5+ digits.
    return `${Math.round(value / 1000)}k`;
  }
  if (value >= 1000) {
    const rounded = Math.round(value / 100) / 10;
    return `${rounded}k`;
  }
  return String(Math.round(value));
}

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
