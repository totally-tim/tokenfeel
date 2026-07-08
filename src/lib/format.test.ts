import { describe, expect, test } from "vitest";
import { formatTokens } from "./format";

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
