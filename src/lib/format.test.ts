import { describe, expect, test } from "vitest";
import { formatClock, formatNumber, formatRate, formatSeconds, formatTokens, percent } from "./format";

describe("formatSeconds", () => {
  test("renders sub-minute durations as one-decimal seconds", () => {
    expect(formatSeconds(0)).toBe("0.0s");
    expect(formatSeconds(12.34)).toBe("12.3s");
    expect(formatSeconds(59.9)).toBe("59.9s");
  });

  test("renders minute-scale durations as m:ss.s", () => {
    expect(formatSeconds(60)).toBe("1:00.0");
    expect(formatSeconds(125.4)).toBe("2:05.4");
  });

  test("drops decimal seconds once past the 10-minute boundary", () => {
    expect(formatSeconds(600)).toBe("10:00");
    expect(formatSeconds(3661)).toBe("61:01");
    // A value just under 600 that rounds up to the 10-minute mark must adopt
    // whole-second precision too, not render the stray "10:00.0" that choosing
    // decimals off the pre-rounded 599.96 produced (review regression).
    expect(formatSeconds(599.96)).toBe("10:00");
  });

  test("falls back to 0:00 for non-finite input instead of throwing or rendering NaN", () => {
    expect(formatSeconds(Number.NaN)).toBe("0:00");
    expect(formatSeconds(Number.POSITIVE_INFINITY)).toBe("0:00");
  });

  test("rounds the total before splitting so a minute-boundary value never renders :60 (A3)", () => {
    // Flooring minutes before rounding produced "1:60.0" for 119.96; rounding
    // the total first carries into the minute -> "2:00.0".
    expect(formatSeconds(119.96)).toBe("2:00.0");
    // Past the 10-minute mark (whole-second precision), 659.6 rounds to 660 -> "11:00".
    expect(formatSeconds(659.6)).toBe("11:00");
    // A sub-minute value that rounds up to 60 crosses into the minute form,
    // never rendering "60.0s".
    expect(formatSeconds(59.96)).not.toBe("60.0s");
    expect(formatSeconds(59.96)).toBe("1:00.0");
  });
});

describe("formatClock", () => {
  test("converts milliseconds to the same format as formatSeconds", () => {
    expect(formatClock(1500)).toBe(formatSeconds(1.5));
    expect(formatClock(65_000)).toBe("1:05.0");
  });
});

describe("formatNumber", () => {
  test("uses one decimal of precision below 100", () => {
    expect(formatNumber(42.36)).toBe("42.4");
    expect(formatNumber(9.95)).toBe("10");
  });

  test("rounds to whole numbers at and above 100", () => {
    expect(formatNumber(100)).toBe("100");
    expect(formatNumber(1234.6)).toBe("1,235");
  });

  test("handles zero and negative values", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(-42.36)).toBe("-42.4");
  });
});

describe("formatRate", () => {
  test("appends the t/s unit to a formatted number", () => {
    expect(formatRate(42.36)).toBe("42.4 t/s");
    expect(formatRate(1234.6)).toBe("1,235 t/s");
  });
});

describe("percent", () => {
  test("renders a 0-1 fraction as a rounded whole-number percentage", () => {
    expect(percent(0)).toBe("0%");
    expect(percent(0.5)).toBe("50%");
    expect(percent(1)).toBe("100%");
  });

  test("rounds fractional percentages to the nearest whole number", () => {
    expect(percent(0.334)).toBe("33%");
    expect(percent(0.336)).toBe("34%");
  });
});

describe("formatTokens", () => {
  test("renders sub-1000 values as plain rounded integers", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(42)).toBe("42");
    expect(formatTokens(999)).toBe("999");
  });

  test("renders 1000-9999 with one decimal of k precision", () => {
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1200)).toBe("1.2k");
    expect(formatTokens(9499)).toBe("9.5k");
  });

  test("drops the decimal at and above the 10k boundary", () => {
    // Below 10,000 the decimal survives; at/above it the intended distinct
    // behavior takes over and collapses to a whole-number k -- this is the
    // branch that was previously a no-op duplicate of the <10k formula.
    expect(formatTokens(9999)).toBe("10k");
    expect(formatTokens(10_000)).toBe("10k");
    expect(formatTokens(12_345)).toBe("12k");
    expect(formatTokens(128_000)).toBe("128k");
  });

  test("the >=10k branch actually differs from naively reusing the <10k formula", () => {
    const value = 12_345;
    const oneDecimalFormula = `${Math.round(value / 100) / 10}k`;
    expect(formatTokens(value)).not.toBe(oneDecimalFormula);
  });
});
