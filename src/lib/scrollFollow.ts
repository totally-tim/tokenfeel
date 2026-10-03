export type RevealBlock = "nearest" | "end";

export interface ScrollBoxMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

export interface ScrollBox extends ScrollBoxMetrics {
  clientTop: number;
  getBoundingClientRect(): { top: number };
  scrollTo(options: ScrollToOptions): void;
}

export interface RevealTarget {
  getBoundingClientRect(): { top: number; height: number };
}

/**
 * The scrollTop that brings a target into view inside one scroll box, with
 * `scrollIntoView`'s block semantics. `top` is the target's offset from the
 * box's visible top edge.
 */
export function revealScrollTop(box: ScrollBoxMetrics, top: number, height: number, block: RevealBlock): number {
  const bottom = top + height;
  let delta = 0;
  if (block === "end") {
    delta = bottom - box.clientHeight;
  } else {
    const above = top < 0;
    const below = bottom > box.clientHeight;
    const taller = height > box.clientHeight;
    // Both edges hidden, or both visible: leave the box where it is.
    if (above !== below) {
      const alignTop = (above && !taller) || (below && taller);
      delta = alignTop ? top : bottom - box.clientHeight;
    }
  }
  const maxScrollTop = Math.max(0, box.scrollHeight - box.clientHeight);
  return Math.min(maxScrollTop, Math.max(0, box.scrollTop + delta));
}

/**
 * `target.scrollIntoView({ block })` limited to `box`. The native call also
 * scrolls every scrollable ancestor, including the lane card and the page.
 * Always instant: a smooth scroll would restart on every frame of a stream,
 * and an instant one needs no reduced-motion override.
 */
export function revealInScrollBox(box: ScrollBox, target: RevealTarget, block: RevealBlock): void {
  const targetRect = target.getBoundingClientRect();
  const top = targetRect.top - box.getBoundingClientRect().top - box.clientTop;
  scrollBoxTo(box, revealScrollTop(box, top, targetRect.height, block));
}

export function scrollBoxToEnd(box: ScrollBox): void {
  scrollBoxTo(box, Math.max(0, box.scrollHeight - box.clientHeight));
}

function scrollBoxTo(box: ScrollBox, top: number): void {
  if (Math.abs(top - box.scrollTop) < 0.5) return;
  box.scrollTo({ top, behavior: "instant" });
}
