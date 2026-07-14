import { formatClock, formatNumber, formatTokens, percent } from "./format";
import type { TimelineEvent, TimelineSummary } from "../types";

export type PhaseCopyKind = "idle" | "tool" | "prefill" | "decode" | "complete" | "instant";

// Thinking tokens are timed exactly like decode (see activePhase.ts -- there
// is no separate timing phase for them), but the Playground rule requires
// prefill/decode/thinking/tool-wait to be visually distinct. This derives
// the *display* kind (color + icon) from the timing kind + event role,
// without touching the timing state machine itself.
export type PhaseVisualKind = PhaseCopyKind | "thinking";

export function phaseVisualKind(event: TimelineEvent, kind: PhaseCopyKind): PhaseVisualKind {
  return kind === "decode" && event.role === "thinking" ? "thinking" : kind;
}

interface PhaseCopy {
  label: string;
  detail: string;
  tokenLabel: string;
}

const generatedRoles = new Set(["assistant", "thinking", "tool_call"]);

export function phaseCopyForEvent(event: TimelineEvent, kind: PhaseCopyKind): PhaseCopy {
  if (kind === "idle") {
    return {
      label: "Queued",
      detail: "Start the simulation to process this prompt",
      tokenLabel: "waiting"
    };
  }

  if (kind === "tool") {
    return {
      label: "Waiting on tool",
      detail: "External tool latency before prompt processing resumes",
      tokenLabel: "tool latency"
    };
  }

  if (kind === "prefill") {
    if (event.role === "tool_result") {
      return {
        label: "Reading tool result",
        detail: "Tool output is being ingested before the model continues",
        tokenLabel: "tool-result tok"
      };
    }

    return {
      label: "Processing prompt",
      detail: "Prompt text is being ingested before generation continues",
      tokenLabel: "prompt tok"
    };
  }

  if (kind === "decode" && event.role === "thinking") {
    return {
      label: "Streaming thinking",
      detail: "Reasoning tokens are streaming before the visible answer",
      tokenLabel: "thinking tok"
    };
  }

  if (kind === "decode" && event.role === "tool_call") {
    return {
      label: "Streaming tool call",
      detail: "Tool-call tokens are streaming at decode speed",
      tokenLabel: "tool-call tok"
    };
  }

  if (kind === "decode") {
    return {
      label: "Streaming answer",
      detail: "Visible answer tokens are streaming at decode speed",
      tokenLabel: "visible tok"
    };
  }

  if (kind === "complete") {
    return {
      label: "Turn complete",
      detail: "This event has finished",
      tokenLabel: "turn finished"
    };
  }

  return {
    label: "Instant event",
    detail: "No measurable prompt or decode phase",
    tokenLabel: "instant"
  };
}

export function statFootItems(summary: TimelineSummary): Array<{ label: string; value: string }> {
  return [
    { label: "PREFILL", value: formatClock(summary.prefillMs) },
    { label: "PREFILLED", value: `${formatTokens(summary.prefilledWithCache)} tok` },
    { label: "CACHE SAVED", value: percent(summary.cacheSavedRatio) },
    { label: "TOTAL SIM", value: formatClock(summary.wallTimeMs) }
  ];
}

export function turnMetricForEvent(event: TimelineEvent): string {
  if (!generatedRoles.has(event.role) && (event.prefillMs > 0 || event.toolLatencyMs > 0)) {
    if (event.role === "tool_result") {
      return event.prefillMs > 0
        ? `tool-result ingest ${formatClock(event.prefillMs)}`
        : `tool round-trip ${formatClock(event.toolLatencyMs)}`;
    }

    return event.prefillMs > 0
      ? `prompt ingest ${formatClock(event.prefillMs)}`
      : `tool wait ${formatClock(event.toolLatencyMs)}`;
  }

  if (generatedRoles.has(event.role) && (event.prefillMs > 0 || event.toolLatencyMs > 0)) {
    return `TTFT ${formatClock(event.ttftMs)}`;
  }

  if (event.role === "thinking") {
    return `thinking decode ${formatClock(event.decodeMs)}`;
  }

  if (event.role === "tool_call") {
    return `tool-call decode ${formatClock(event.decodeMs)}`;
  }

  if (event.role === "assistant") {
    return `answer decode ${formatClock(event.decodeMs)}`;
  }

  return `${formatNumber(event.tokens)} tok`;
}
