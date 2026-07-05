import { Check, Clock, Cpu, Gauge, Wrench } from "lucide-react";

// The canonical five-phase vocabulary, shown as a legend so the marketing and
// method pages speak the same visual language as the live simulator.
const PHASES = [
  { kind: "idle", Icon: Clock, label: "Queued", desc: "Idle — nothing is computing yet." },
  { kind: "prefill", Icon: Cpu, label: "Prompt prefill", desc: "Processing the prompt before the first visible token." },
  { kind: "tool", Icon: Wrench, label: "Tool wait", desc: "External tool latency pauses the loop." },
  { kind: "decode", Icon: Gauge, label: "Decode", desc: "Generated tokens stream at decode speed." },
  { kind: "complete", Icon: Check, label: "Complete", desc: "The turn has finished." }
] as const;

export function PhaseLegend({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`phase-legend ${compact ? "compact" : ""}`}>
      {PHASES.map((phase) => (
        <div key={phase.kind} className={`phase-legend-item phase-legend-${phase.kind}`}>
          <span className="phase-legend-swatch">
            <phase.Icon size={14} />
          </span>
          <div>
            <strong>{phase.label}</strong>
            {!compact && <small>{phase.desc}</small>}
          </div>
        </div>
      ))}
    </div>
  );
}
