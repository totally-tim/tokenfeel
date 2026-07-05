import { describe, expect, test } from "vitest";
import { raceOutputWindow } from "./raceOutput";

function event(id: string, index: number) {
  return { id, index };
}

describe("race output window", () => {
  test("keeps recent transcript context around the active race turn", () => {
    const events = [event("one", 0), event("two", 1), event("three", 2), event("four", 3), event("five", 4)];

    expect(raceOutputWindow(events, 3, 3).map((item) => item.id)).toEqual(["two", "three", "four"]);
  });

  test("clamps the active turn to available transcript bounds", () => {
    const events = [event("one", 0), event("two", 1)];

    expect(raceOutputWindow(events, 20, 4).map((item) => item.id)).toEqual(["one", "two"]);
  });

  test("does not expose transcript events before a race has started", () => {
    const events = [event("one", 0), event("two", 1)];

    expect(raceOutputWindow(events, 0, 4, false)).toEqual([]);
  });
});
