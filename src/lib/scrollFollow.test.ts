import { describe, expect, test } from "vitest";
import { readPrunedCatalogFromDisk } from "../../scripts/validate-data";
import { buildTimeline } from "../sim/timing";
import { revealInScrollBox, revealScrollTop, scrollBoxToEnd, type RevealTarget, type ScrollBox } from "./scrollFollow";
import { streamFrameForEvent } from "./streaming";

class FakeBox implements ScrollBox {
  scrollTop = 0;
  clientTop = 1;
  scrollCalls: ScrollToOptions[] = [];

  constructor(
    public clientHeight: number,
    public scrollHeight: number
  ) {}

  getBoundingClientRect() {
    return { top: 100 };
  }

  // Clamps like a browser scroll container.
  scrollTo(options: ScrollToOptions) {
    this.scrollCalls.push(options);
    const maxScrollTop = Math.max(0, this.scrollHeight - this.clientHeight);
    this.scrollTop = Math.min(maxScrollTop, Math.max(0, options.top ?? this.scrollTop));
  }
}

// A target `offset` px below the top of the box's scrollable content.
function targetIn(box: FakeBox, offset: number, height: number): RevealTarget {
  return {
    getBoundingClientRect: () => ({
      top: box.getBoundingClientRect().top + box.clientTop + offset - box.scrollTop,
      height
    })
  };
}

describe("revealScrollTop", () => {
  const box = { scrollTop: 0, clientHeight: 200, scrollHeight: 1000 };

  test("end aligns the target's bottom with the box's bottom", () => {
    expect(revealScrollTop(box, 500, 100, "end")).toBe(400);
  });

  test("end clamps to the scrollable range", () => {
    expect(revealScrollTop(box, 950, 100, "end")).toBe(800);
    expect(revealScrollTop({ ...box, scrollTop: 100 }, -300, 50, "end")).toBe(0);
  });

  test("nearest leaves a fully visible target alone", () => {
    expect(revealScrollTop({ ...box, scrollTop: 300 }, 20, 100, "nearest")).toBe(300);
  });

  test("nearest shows a short target below the box in full", () => {
    expect(revealScrollTop(box, 250, 100, "nearest")).toBe(150);
  });

  test("nearest shows a target taller than the box from its top", () => {
    expect(revealScrollTop(box, 250, 400, "nearest")).toBe(250);
  });

  test("nearest scrolls up to a short target above the box", () => {
    expect(revealScrollTop({ ...box, scrollTop: 300 }, -50, 100, "nearest")).toBe(250);
  });

  test("nearest leaves the box alone when the target covers it", () => {
    expect(revealScrollTop({ ...box, scrollTop: 300 }, -50, 400, "nearest")).toBe(300);
  });
});

describe("revealInScrollBox", () => {
  test("scrolls only the box, instantly", () => {
    const box = new FakeBox(200, 1000);
    revealInScrollBox(box, targetIn(box, 500, 100), "end");
    expect(box.scrollCalls).toEqual([{ top: 400, behavior: "instant" }]);
    expect(box.scrollTop).toBe(400);
  });

  test("does not scroll when the target is already in place", () => {
    const box = new FakeBox(200, 1000);
    box.scrollTop = 400;
    revealInScrollBox(box, targetIn(box, 500, 100), "end");
    expect(box.scrollCalls).toEqual([]);
  });
});

describe("scrollBoxToEnd", () => {
  test("scrolls to the bottom of the content, instantly", () => {
    const box = new FakeBox(180, 640);
    scrollBoxToEnd(box);
    expect(box.scrollCalls).toEqual([{ top: 460, behavior: "instant" }]);
  });

  test("does nothing when the content fits", () => {
    const box = new FakeBox(180, 180);
    scrollBoxToEnd(box);
    expect(box.scrollCalls).toEqual([]);
  });
});

describe("revealing a lane's output box inside its card", () => {
  test("leaves the card alone while the whole box is visible", () => {
    const card = new FakeBox(400, 600);
    card.scrollTop = 120;
    revealInScrollBox(card, targetIn(card, 300, 202), "nearest");
    expect(card.scrollCalls).toEqual([]);
  });

  test("scrolls the card only as far as a clipped box needs", () => {
    const card = new FakeBox(400, 600);
    revealInScrollBox(card, targetIn(card, 391, 202), "nearest");
    expect(card.scrollTop).toBe(193);
  });

  test("counts only the part of the card that its ancestors leave visible", () => {
    const card = new FakeBox(400, 800);
    // The card's client area spans 101..501 in the viewport; an ancestor
    // clips it at 465, so the box must end there instead of at 501.
    revealInScrollBox(card, targetIn(card, 391, 202), "nearest", { top: 0, bottom: 465 });
    expect(card.scrollTop).toBe(229);
  });

  test("counts a clip at the top of the card", () => {
    const card = new FakeBox(400, 800);
    card.scrollTop = 300;
    // The box sits 20px below the card's top edge, under a 40px clip.
    revealInScrollBox(card, targetIn(card, 320, 202), "nearest", { top: 141, bottom: Infinity });
    expect(card.scrollTop).toBe(280);
  });

  test("leaves a fully clipped card alone", () => {
    const card = new FakeBox(400, 800);
    revealInScrollBox(card, targetIn(card, 391, 202), "nearest", { top: 600, bottom: 560 });
    expect(card.scrollCalls).toEqual([]);
  });
});

describe("following a long streaming event", () => {
  const catalog = readPrunedCatalogFromDisk();
  const scenario = catalog.scenarios.find((item) => item.id === "repo-wide-refactor");
  if (!scenario) throw new Error("repo-wide-refactor scenario is missing");
  const timeline = buildTimeline({ result: catalog.results[0], scenario, cacheMode: "runtime" });
  const event = timeline.events.find((item) => item.id === "refactor-thinking-2");
  if (!event) throw new Error("refactor-thinking-2 event is missing");

  test("keeps the streamed tail inside the box on every frame", () => {
    // Layout model: earlier turns fill 900px above the active turn, which has
    // a 24px header and wraps its text at 60 characters per 20px line.
    const above = 900;
    const box = new FakeBox(320, above);
    const frames = 600;
    const lengths = new Set<number>();
    let previousScrollTop = 0;

    for (let frame = 0; frame <= frames; frame += 1) {
      const elapsedMs = event.startMs + ((event.endMs - event.startMs) * frame) / frames;
      const text = streamFrameForEvent(event, elapsedMs).text;
      lengths.add(text.length);
      const height = 24 + Math.ceil(text.length / 60) * 20;
      box.scrollHeight = above + height;

      revealInScrollBox(box, targetIn(box, above, height), "end");

      const tailBottom = above + height - box.scrollTop;
      expect(tailBottom).toBeGreaterThan(0);
      expect(tailBottom).toBeLessThanOrEqual(box.clientHeight);
      expect(box.scrollTop).toBeGreaterThanOrEqual(previousScrollTop);
      previousScrollTop = box.scrollTop;
    }

    // The text really streamed, and grew far past the box.
    expect(lengths.size).toBeGreaterThan(frames / 2);
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight * 10);
    expect(box.scrollCalls.every((call) => call.behavior === "instant")).toBe(true);
  });
});
