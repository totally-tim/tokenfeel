import { describe, expect, test } from "vitest";
import { buildPageHash, pageFromHashValue, parseHashRoute } from "./routing";

describe("routing", () => {
  test("falls back to landing for an unknown page", () => {
    expect(pageFromHashValue("#nonsense")).toBe("landing");
    expect(parseHashRoute("#nonsense").page).toBe("landing");
  });

  test("round-trips a bare hash to the landing page", () => {
    expect(pageFromHashValue("#")).toBe("landing");
    expect(buildPageHash("landing")).toBe("#");
  });

  test("preserves query params through parse -> build", () => {
    const route = parseHashRoute("#race?a=left&b=right&s=agent-bugfix&speed=2");
    const rebuilt = buildPageHash(route.page, route.params);

    expect(rebuilt).toBe("#race?a=left&b=right&s=agent-bugfix&speed=2");
  });
});
