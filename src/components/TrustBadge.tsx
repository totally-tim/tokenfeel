import { AlertTriangle, FlaskConical, ShieldCheck, Users } from "lucide-react";
import type { ResultStatus } from "../types";

/**
 * Trust state for a catalog row. Deliberately separate from StatusBadge, which
 * shows *playback* state (idle/generating/finished): a `flagged` benchmark row
 * and a `running` lane used to share one CSS rule, which meant a disputed
 * number looked exactly like a healthy lane mid-race.
 *
 * Every state carries three independent differentiators -- label word, icon and
 * border treatment -- on top of hue, so the four stay distinguishable for
 * colour-blind users and in greyscale. See AGENTS.md: "color is not the only
 * state indicator".
 */
const trust: Record<ResultStatus, { label: string; Icon: typeof ShieldCheck; title: string }> = {
  verified: {
    label: "VERIFIED",
    Icon: ShieldCheck,
    title: "Maintainer reproduced this row, or imported it verbatim from a trusted source."
  },
  community: {
    label: "COMMUNITY",
    Icon: Users,
    title: "Community submission with source-backed provenance. Not maintainer-reproduced."
  },
  flagged: {
    label: "FLAGGED",
    Icon: AlertTriangle,
    title: "Disputed row. Treat these numbers with suspicion until the source is resolved."
  },
  illustrative: {
    label: "DEMO",
    Icon: FlaskConical,
    title: "Synthetic or illustrative row. Not a real benchmark measurement."
  }
};

export function TrustBadge({ status, compact = false }: { status: ResultStatus; compact?: boolean }) {
  const { label, Icon, title } = trust[status];
  return (
    <span className={`trust-badge trust-${status} ${compact ? "trust-compact" : ""}`} title={title}>
      <Icon aria-hidden="true" />
      <span className="trust-label">{label}</span>
    </span>
  );
}
