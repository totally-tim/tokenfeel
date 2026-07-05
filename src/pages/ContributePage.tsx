import { useState } from "react";
import { Bot, Clipboard, ClipboardCheck, FileJson, GitPullRequest, TerminalSquare } from "lucide-react";
import { contributionAgentPrompt, contributionVerificationChecks } from "../lib/contributionAgentPrompt";

const steps = [
  {
    icon: TerminalSquare,
    title: "Run the benchmark",
    text: "Use llama-bench, llama-benchy, oMLX or another tool that reports prompt-processing and generation rates."
  },
  {
    icon: FileJson,
    title: "Convert to JSON",
    text: "Create one result file with hardware, model, quant, runtime, source URL and sorted pp/tg depth measurements."
  },
  {
    icon: ClipboardCheck,
    title: "Attach raw evidence",
    text: "Paste raw output, link machine-readable logs and include exact command, run count, token sizes and runtime versions."
  },
  {
    icon: GitPullRequest,
    title: "Open a PR",
    text: "CI validates the schema and builds a preview. Maintainers can promote rows from community to verified later."
  }
];

export function ContributePage() {
  const [copyLabel, setCopyLabel] = useState("Copy prompt");

  const copyAgentPrompt = async () => {
    const resetCopyLabel = () => window.setTimeout(() => setCopyLabel("Copy prompt"), 1200);

    try {
      await navigator.clipboard.writeText(contributionAgentPrompt);
      setCopyLabel("Copied");
      resetCopyLabel();
    } catch {
      setCopyLabel("Copy failed");
      resetCopyLabel();
    }
  };

  return (
    <main className="doc-page contribute-page">
      <section className="doc-hero">
        <p className="eyebrow">CONTRIBUTE</p>
        <h1>Make benchmark submissions boring, reviewable and linkable.</h1>
        <p>
          The public version should be a GitHub Pages repo where every new hardware result is a pull
          request, not a form submission into a private database.
        </p>
      </section>
      <section className="contribute-steps">
        {steps.map((step, index) => (
          <article key={step.title}>
            <span>0{index + 1}</span>
            <step.icon />
            <h2>{step.title}</h2>
            <p>{step.text}</p>
          </article>
        ))}
      </section>
      <section className="agent-prompt-panel" aria-labelledby="agent-prompt-title">
        <div className="agent-prompt-head">
          <div>
            <p className="eyebrow">AGENT HANDOFF</p>
            <h2 id="agent-prompt-title">Copy the benchmark agent prompt, or let an agent read it here.</h2>
            <p>
              The prompt turns a local inference run into one reviewable result file with raw evidence,
              schema checks, tests and build output.
            </p>
          </div>
          <button type="button" className="secondary-button small" onClick={copyAgentPrompt} aria-live="polite">
            <Clipboard size={15} /> {copyLabel}
          </button>
        </div>
        <div className="agent-prompt-grid">
          <div className="agent-checklist">
            <Bot size={26} />
            <h3>Submission guardrails</h3>
            <ul>
              {contributionVerificationChecks.map((check) => (
                <li key={check}>{check}</li>
              ))}
            </ul>
          </div>
          <pre>{contributionAgentPrompt}</pre>
        </div>
      </section>
      <section className="snippet-panel">
        <h2>Minimum result file</h2>
        <pre>{`{
  "id": "framework-strix-halo__qwen3-30b-a3b__q4_k_xl__llamacpp-vulkan",
  "hardware": "framework-strix-halo-128gb",
  "model": "qwen3-30b-a3b",
  "quant": "q4_k_xl",
  "runtime": {
    "name": "llama.cpp",
    "version": "b6200",
    "backend": "Vulkan",
    "flags": "-fa on",
    "cache": "prefix"
  },
  "measurements": [
    { "depth": 0, "pp": 741.6, "tg": 81.79 }
  ],
  "source": { "kind": "llama-bench", "title": "Raw run", "url": "https://..." },
  "evidence": { "rawUrl": "https://...", "rawFormat": "llama-bench" },
  "benchmark": { "tool": "llama-bench", "runs": 3, "ppTokens": 2048, "tgTokens": 128 },
  "submitter": "github-handle",
  "date": "2026-07-05",
  "status": "community"
}`}</pre>
      </section>
    </main>
  );
}
