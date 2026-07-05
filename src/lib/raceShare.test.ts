import { describe, expect, test } from "vitest";
import { DEFAULT_LEFT_RESULT_ID, DEFAULT_RIGHT_RESULT_ID, DEFAULT_SCENARIO_ID } from "./catalog";
import { buildRaceShareUrl, parseRaceShareHash } from "./raceShare";
import { buildPageHash, pageFromHashValue, parseHashRoute } from "./routing";

describe("race share links", () => {
  test("builds a GitHub Pages compatible hash URL from the current repo path", () => {
    const url = buildRaceShareUrl(
      {
        leftId: DEFAULT_LEFT_RESULT_ID,
        rightId: DEFAULT_RIGHT_RESULT_ID,
        scenarioId: DEFAULT_SCENARIO_ID,
        speed: 4
      },
      "https://totally-tim.github.io/tokenfeel/#configs"
    );

    expect(url).toBe(
      `https://totally-tim.github.io/tokenfeel/#race?a=${DEFAULT_LEFT_RESULT_ID}&b=${DEFAULT_RIGHT_RESULT_ID}&s=${DEFAULT_SCENARIO_ID}&speed=4`
    );
  });

  test("routes hash share links to the race page", () => {
    expect(pageFromHashValue("#race?a=left&b=right&s=agent-bugfix&speed=2")).toBe("race");
  });

  test("routes slash-prefixed hash links to the requested page", () => {
    expect(pageFromHashValue("#/race?a=left&b=right&s=agent-bugfix&speed=2")).toBe("race");
  });

  test("parses page and params from hash route", () => {
    const route = parseHashRoute("#race?a=left&b=right&s=agent-bugfix&speed=2");

    expect(route.page).toBe("race");
    expect(route.params.get("a")).toBe("left");
    expect(route.params.get("speed")).toBe("2");
  });

  test("builds canonical hash anchors for pages with params", () => {
    expect(buildPageHash("configs")).toBe("#configs");
    expect(buildPageHash("race", new URLSearchParams({ a: "left", b: "right" }))).toBe("#race?a=left&b=right");
    expect(buildPageHash("landing")).toBe("#");
  });

  test("parses race state from a hash link", () => {
    expect(
      parseRaceShareHash(
        `#race?a=${DEFAULT_LEFT_RESULT_ID}&b=${DEFAULT_RIGHT_RESULT_ID}&s=${DEFAULT_SCENARIO_ID}&speed=2`
      )
    ).toEqual({
      leftId: DEFAULT_LEFT_RESULT_ID,
      rightId: DEFAULT_RIGHT_RESULT_ID,
      scenarioId: DEFAULT_SCENARIO_ID,
      speed: 2
    });
  });

  test("round-trips optional cache override in race share links", () => {
    const url = buildRaceShareUrl(
      {
        leftId: DEFAULT_LEFT_RESULT_ID,
        rightId: DEFAULT_RIGHT_RESULT_ID,
        scenarioId: DEFAULT_SCENARIO_ID,
        speed: 2,
        cacheMode: "off"
      },
      "https://totally-tim.github.io/tokenfeel/#race"
    );

    expect(url).toContain("cache=off");
    expect(parseRaceShareHash(new URL(url).hash).cacheMode).toBe("off");
  });
});
