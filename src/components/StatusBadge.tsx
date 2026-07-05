import type { ResultStatus } from "../types";

interface StatusBadgeProps {
  status: ResultStatus | "idle" | "generating" | "running" | "finished";
}

const labels: Record<StatusBadgeProps["status"], string> = {
  verified: "VERIFIED",
  community: "COMMUNITY",
  flagged: "FLAGGED",
  illustrative: "DEMO",
  idle: "IDLE",
  generating: "GENERATING",
  running: "RUNNING",
  finished: "FINISHED"
};

export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span className={`status-badge status-${status}`}>
      <span className="status-dot" />
      {labels[status]}
    </span>
  );
}
