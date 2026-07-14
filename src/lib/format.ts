export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  // Round to the display precision BEFORE splitting into minutes/seconds.
  // Flooring first produced artifacts like "1:60.0" for 119.96 (floor gives
  // 1 minute, then 59.96 rounds up to 60.0) -- rounding the total first makes
  // it 120.0 -> "2:00.0". One decimal below the 10-minute mark, whole seconds
  // at/past it. Decide the precision from the value already rounded to a tenth,
  // so 599.96 -> 600.0 crosses into whole-seconds and renders "10:00", not the
  // stray "10:00.0" that choosing decimals off the raw 599.96 would produce.
  const roundedTenths = Number(seconds.toFixed(1));
  const decimals = roundedTenths < 600 ? 1 : 0;
  const rounded = decimals === 1 ? roundedTenths : Math.round(roundedTenths);
  if (rounded < 60) return `${rounded.toFixed(1)}s`;
  const minutes = Math.floor(rounded / 60);
  const remaining = rounded - minutes * 60;
  return `${minutes}:${remaining.toFixed(decimals).padStart(decimals === 1 ? 4 : 2, "0")}`;
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
