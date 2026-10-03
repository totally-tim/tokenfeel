import { formatClock } from "./format";
import { raceVerdictLabel, type RaceVerdict } from "./raceComparison";

export interface RaceLaneFinish {
  complete: boolean;
  wallTimeMs: number;
}

/**
 * Screen-reader text for the time-driven Race transitions: a lane finishing
 * and, once both have, the verdict. It is "" until a lane completes and then
 * changes only when the next lane completes, so a live region that renders it
 * announces each transition once instead of tracking the 60fps clock. A lane's
 * time is announced only after that lane completes, so it is always final.
 * The final message repeats both times because both lanes can complete in the
 * same frame, which skips the single-lane message.
 */
export function raceFinishAnnouncement(left: RaceLaneFinish, right: RaceLaneFinish, verdict: RaceVerdict): string {
  if (!right.complete) return left.complete ? laneFinished("A", left) : "";
  if (!left.complete) return laneFinished("B", right);
  const margin = verdict.winner === "too-close" ? "" : ` by ${formatClock(verdict.deltaMs)}`;
  return `Race finished. Lane A ${formatClock(left.wallTimeMs)}, Lane B ${formatClock(right.wallTimeMs)}. ${raceVerdictLabel(verdict.winner)}${margin}.`;
}

function laneFinished(label: "A" | "B", lane: RaceLaneFinish) {
  return `Lane ${label} finished in ${formatClock(lane.wallTimeMs)}.`;
}
