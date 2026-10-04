// "nearest-end" is "nearest", except that a target taller than the view shows
// its end, where a stream's newest text is.
export type RevealBlock = "nearest" | "nearest-end" | "end";

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

/** A band of the viewport, in client coordinates. */
export interface VisibleBounds {
  top: number;
  bottom: number;
}

/**
 * The scrollTop that brings a target into view inside one scroll box, with
 * `scrollIntoView`'s block semantics. `top` is the target's offset from the
 * top of the box's visible part, which is `viewHeight` tall.
 */
export function revealScrollTop(
  box: ScrollBoxMetrics,
  top: number,
  height: number,
  block: RevealBlock,
  viewHeight = box.clientHeight
): number {
  const bottom = top + height;
  let delta = 0;
  if (block === "end") {
    delta = bottom - viewHeight;
  } else {
    const above = top < 0;
    const below = bottom > viewHeight;
    const taller = height > viewHeight;
    if (taller && block === "nearest-end") {
      delta = bottom - viewHeight;
    } else if (above !== below) {
      // Exactly one edge is hidden; with both hidden or both visible the box stays.
      const alignTop = (above && !taller) || (below && taller);
      delta = alignTop ? top : bottom - viewHeight;
    }
  }
  const maxScrollTop = Math.max(0, box.scrollHeight - box.clientHeight);
  return Math.min(maxScrollTop, Math.max(0, box.scrollTop + delta));
}

/**
 * `target.scrollIntoView({ block })` limited to `box`. The native call also
 * scrolls every scrollable ancestor, including the lane card and the page.
 * `clip` narrows the box's visible part to what its ancestors leave showing.
 * Always instant: a smooth scroll would restart on every frame of a stream,
 * and an instant one needs no reduced-motion override.
 */
export function revealInScrollBox(
  box: ScrollBox,
  target: RevealTarget,
  block: RevealBlock,
  clip?: VisibleBounds
): void {
  const clientTop = box.getBoundingClientRect().top + box.clientTop;
  const viewTop = Math.max(clientTop, clip?.top ?? clientTop);
  const viewBottom = Math.min(clientTop + box.clientHeight, clip?.bottom ?? Infinity);
  if (viewBottom <= viewTop) return;
  const targetRect = target.getBoundingClientRect();
  scrollBoxTo(box, revealScrollTop(box, targetRect.top - viewTop, targetRect.height, block, viewBottom - viewTop));
}

/** The band of the viewport that the clipping ancestors of `element` leave visible. */
export function ancestorClip(element: Element): VisibleBounds {
  let top = -Infinity;
  let bottom = Infinity;
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (getComputedStyle(ancestor).overflowY === "visible") continue;
    const rect = ancestor.getBoundingClientRect();
    top = Math.max(top, rect.top + ancestor.clientTop);
    bottom = Math.min(bottom, rect.top + ancestor.clientTop + ancestor.clientHeight);
  }
  return { top, bottom };
}

export function scrollBoxToEnd(box: ScrollBox): void {
  scrollBoxTo(box, Math.max(0, box.scrollHeight - box.clientHeight));
}

function scrollBoxTo(box: ScrollBox, top: number): void {
  if (Math.abs(top - box.scrollTop) < 0.5) return;
  box.scrollTo({ top, behavior: "instant" });
}
