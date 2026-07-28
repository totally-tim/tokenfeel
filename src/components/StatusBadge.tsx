export type PlaybackStatus = "idle" | "generating" | "finished";

const labels: Record<PlaybackStatus, string> = {
  idle: "IDLE",
  generating: "GENERATING",
  finished: "FINISHED"
};

/**
 * Playback state only. Trust state for a catalog row lives in TrustBadge --
 * keeping the two apart is what stops a `flagged` row from being styled
 * identically to a healthy in-progress lane, which is what the shared
 * `.status-flagged, .status-running` rule used to do.
 */
export function StatusBadge({ status }: { status: PlaybackStatus }) {
  return (
    <span className={`status-badge status-${status}`}>
      <span className="status-dot" />
      {labels[status]}
    </span>
  );
}
