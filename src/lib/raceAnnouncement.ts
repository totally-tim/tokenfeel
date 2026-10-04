import { formatClock } from "./format";
import { raceVerdictLabel, type RaceVerdict } from "./raceComparison";

type RaceLaneId = "A" | "B";

/**
 * One fact about the current run, stamped with the real time (performance.now)
 * at which the page first observed it. Start, Stop and setup resets begin a new
 * log with a single action entry, so nothing from an earlier run can play.
 */
export type RaceLogEntry =
  | { at: number; kind: "action"; text: string }
  | { at: number; kind: "mark"; lane: RaceLaneId; quarter: number }
  | { at: number; kind: "finish"; lane: RaceLaneId; wallTimeMs: number };

export interface RaceLaneSnapshot {
  started: boolean;
  progress: number;
  complete: boolean;
  wallTimeMs: number;
}

/**
 * A live-region text that changes again within a few hundred milliseconds may
 * be replaced before a screen reader speaks it, so a text counts as spoken once
 * it has been shown this long. Quartile text waits until the current text is
 * spoken, and a finish repeats the current text only while it is not. 500 ms is
 * just above that threshold; a longer value makes finishes repeat text that
 * has already been read.
 */
export const RACE_STATUS_MIN_DISPLAY_MS = 500;

function reachedQuarter(log: RaceLogEntry[], lane: RaceLaneId) {
  let reached = 0;
  for (const entry of log) {
    if (entry.kind === "mark" && entry.lane === lane) reached = Math.max(reached, entry.quarter);
    if (entry.kind === "finish" && entry.lane === lane) reached = 4;
  }
  return reached;
}

/**
 * New log entries for marks the lanes reached since the log was last updated.
 * A lane that passes several marks between two observations logs only the
 * furthest one, and a finish supersedes that lane's marks: the page never
 * showed the lane at the lower marks, so they are already out of date.
 */
export function raceLogUpdates(
  log: RaceLogEntry[],
  snapshots: Record<RaceLaneId, RaceLaneSnapshot>,
  now: number
): RaceLogEntry[] {
  const updates: RaceLogEntry[] = [];
  for (const lane of ["A", "B"] as const) {
    const { started, progress, complete, wallTimeMs } = snapshots[lane];
    if (!started) continue;
    const quarter = complete ? 4 : Math.min(3, Math.floor(progress * 4));
    if (quarter <= reachedQuarter(log, lane)) continue;
    updates.push(
      quarter === 4 ? { at: now, kind: "finish", lane, wallTimeMs } : { at: now, kind: "mark", lane, quarter }
    );
  }
  return updates;
}

function entryText(log: RaceLogEntry[], index: number, verdict: RaceVerdict) {
  const entry = log[index];
  if (entry.kind === "action") return entry.text;
  if (entry.kind === "mark") return `Lane ${entry.lane} ${entry.quarter * 25}%.`;
  const finished = `Lane ${entry.lane} finished in ${formatClock(entry.wallTimeMs)}.`;
  const otherFinishedEarlier = log
    .slice(0, index)
    .some((earlier) => earlier.kind === "finish" && earlier.lane !== entry.lane);
  if (!otherFinishedEarlier) return finished;
  const margin = verdict.winner === "too-close" ? "" : ` by ${formatClock(verdict.deltaMs)}`;
  return `${finished} Race finished. ${raceVerdictLabel(verdict.winner)}${margin}.`;
}

/**
 * The text of the Race status region at `now`, replayed from the log.
 *
 * Entries with the same timestamp form one message. A message shows at once
 * when the current text has been up for RACE_STATUS_MIN_DISPLAY_MS; otherwise
 * a quartile waits and is merged with anything else that arrives before then.
 * A finish never waits: it shows at once after any waiting text and, when the
 * current text has not been up that long, keeps that text in front of it. The
 * page stops rendering after the last finish, which is why a finish must take
 * the waiting text with it; that also means no quartile plays after it.
 *
 * The page renders every frame while a race runs, so waiting text appears
 * when it is due. After a gap in rendering, such as a background tab, waiting
 * text can be replaced as soon as it appears; it is then at least as old as
 * the gap.
 */
export function raceStatusText(log: RaceLogEntry[], now: number, verdict: RaceVerdict): string {
  let shown: string[] = [];
  let shownAt = -Infinity;
  let waiting: string[] = [];

  for (let index = 0; index < log.length && log[index].at <= now;) {
    const at = log[index].at;
    const parts: string[] = [];
    let finish = false;
    for (; index < log.length && log[index].at === at; index += 1) {
      parts.push(entryText(log, index, verdict));
      finish ||= log[index].kind === "finish";
    }

    if (waiting.length > 0 && shownAt + RACE_STATUS_MIN_DISPLAY_MS <= at) {
      shown = waiting;
      shownAt += RACE_STATUS_MIN_DISPLAY_MS;
      waiting = [];
    }
    if (at - shownAt >= RACE_STATUS_MIN_DISPLAY_MS) {
      shown = parts;
      shownAt = at;
    } else if (finish) {
      shown = [...shown, ...waiting, ...parts];
      shownAt = at;
      waiting = [];
    } else {
      waiting.push(...parts);
    }
  }

  if (waiting.length > 0 && shownAt + RACE_STATUS_MIN_DISPLAY_MS <= now) shown = waiting;
  return shown.join(" ");
}
