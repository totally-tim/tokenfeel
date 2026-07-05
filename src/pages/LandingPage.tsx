import {
  Brain,
  Gauge,
  GitBranch,
  Layers3,
  Link,
  MessagesSquare,
  Swords,
  Terminal
} from "lucide-react";
import { PhaseLegend } from "../components/PhaseLegend";
import { FLAG_RESULT_ISSUE_URL } from "../lib/projectLinks";
import type { Catalog } from "../types";
import type { PageId } from "../lib/routing";

interface LandingPageProps {
  catalog: Catalog;
  onNavigate: (page: PageId) => void;
}

const features = [
  {
    icon: Gauge,
    title: "Prefill-aware timing",
    text: "Throughput is interpolated across measured context depths, so long prompts and large tool results slow down like the submitted hardware.",
    link: "The timing model ↗"
  },
  {
    icon: Layers3,
    title: "Prompt caching, modeled",
    text: "Prefix hits and cache-bust events show cached vs re-prefilled tokens in two colors.",
    link: "Why caching matters ↗"
  },
  {
    icon: Swords,
    title: "Race mode",
    text: "Two configs, one script, started together. Prefill, thinking, tool wait, and decode splits make the gap visible.",
    link: "Open a race ↗"
  },
  {
    icon: Terminal,
    title: "Real scenarios",
    text: "Chatbot, agentic coding loop, reasoning. Display text is fiction; token counts are the ground truth.",
    link: "Browse scenarios ↗"
  },
  {
    icon: GitBranch,
    title: "The repo is the database",
    text: "Hardware, results and scripts live as JSON. Submit a benchmark via pull request. Zero backend, zero ops.",
    link: "Contribute data ↗"
  },
  {
    icon: Link,
    title: "Shareable URLs",
    text: "The full race config encodes into the URL. Every 'which box should I buy' thread ends with a link.",
    link: "Copy a link ↗"
  }
];

export function LandingPage({ catalog, onNavigate }: LandingPageProps) {
  return (
    <main className="landing-page">
      <section className="hero-section">
        <p className="eyebrow">LOCAL LLM SPEED LAB</p>
        <h1>
          Compare configs
          <br />
          and feel generation
          <br />
          in <mark>real time</mark>.
        </h1>
        <p className="hero-copy">
          Pick hardware, model, quant, runtime, and scenario. Watch prefill, tool wait,
          thinking, and decode unfold in real time, then compare any two configurations
          with the same script.
        </p>
        <div className="hero-actions">
          <button type="button" className="primary-button" onClick={() => onNavigate("race")}>
            Start a race
          </button>
          <button type="button" className="secondary-button" onClick={() => onNavigate("playground")}>
            Try the playground
          </button>
        </div>
        <div className="trust-strip">
          <span>SEEDED FROM</span>
          <strong>Spark Arena</strong>
          <strong>Strix Halo toolboxes</strong>
          <strong>BridgeBench</strong>
          <strong>mlx-lm</strong>
        </div>
      </section>

      <section className="pipeline-zone" aria-label="Simulation pipeline">
        <div className="pipeline-frame">
          <div className="pipeline-head">
            <span>FIG 1 — SIMULATION PIPELINE · PURE MATH, ZERO INFERENCE</span>
            <span>published t/s → real-time playback</span>
          </div>
          <div className="pipeline-row">
            <PipelinePanel
              n="01"
              title="RESULT.json"
              lines={["d 0        pp 3234       tg 73.3", "d 8k       pp 2491       tg 71.5", "d 100k     pp 1153       tg 52.5", "cache: prefix", "vLLM · CUDA"]}
            />
            <Connector />
            <PipelinePanel
              n="02"
              title="TIMING MODEL"
              lines={["TTFT = measured", "fallback = prompt ÷ pp(depth)", "t/tok = 1 ÷ tg(depth)", "interp — linear", "extrap — flat ⚠"]}
            />
            <Connector />
            <PipelinePanel
              n="03"
              title="EVENT TIMELINE"
              lines={["turn 1  ███░░░░░░", "turn 2  █████░░░", "turn 3  ██████░", "■ prefill  ■ decode"]}
            />
            <Connector />
            <PipelinePanel
              n="04"
              title="STREAMED SESSION"
              lines={["> user (42 tok)", "Sure — here's a three-day route through the", "Dolomites that keeps driving under two", "● generating                 73.3 t/s"]}
            />
          </div>
        </div>
        <div className="pipeline-legend">
          <span>PHASES YOU WATCH</span>
          <PhaseLegend compact />
        </div>
      </section>

      <section className="stats-strip">
        <div>
          <strong>1×</strong>
          <span>default playback speed, honest to the ms</span>
        </div>
        <div>
          <strong>{catalog.hardware.length}</strong>
          <span>hardware configs seeded locally</span>
        </div>
        <div>
          <strong>0</strong>
          <span>inference runs, anywhere, ever</span>
        </div>
      </section>

      <section className="feature-section">
        <h2>
          Everything the <mark>numbers</mark> cannot show you.
        </h2>
        <div className="feature-grid">
          {features.map((feature) => (
            <article key={feature.title} className="feature-card">
              <span className="feature-icon">
                <feature.icon size={22} />
              </span>
              <h3>{feature.title}</h3>
              <p>{feature.text}</p>
              <button type="button" onClick={() => onNavigate(feature.title === "Race mode" ? "race" : "method")}>
                {feature.link}
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="closing-zone">
        <h2>
          Settle a <mark>configuration</mark> argument
          <br />
          with your eyes, not a spreadsheet.
        </h2>
        <p>Pure-math simulation from published benchmarks. No accounts, no backend. Pick two setups and press play.</p>
        <div className="hero-actions">
          <button type="button" className="primary-button" onClick={() => onNavigate("race")}>
            Start a race
          </button>
          <button type="button" className="dark-secondary-button" onClick={() => onNavigate("method")}>
            What we simulate
          </button>
        </div>
      </section>

      <footer className="footer">
        <span className="brand-mark">tf</span>
        <span>Tokenfeel · open source · local first · GitHub Pages ready · {catalog.results.length} seed rows</span>
        <nav>
          <button onClick={() => onNavigate("method")}>Method</button>
          <button onClick={() => onNavigate("playground")}>Scenarios</button>
          <button onClick={() => onNavigate("contribute")}>Contribute</button>
          <a href={FLAG_RESULT_ISSUE_URL} target="_blank" rel="noreferrer">Report a result</a>
        </nav>
      </footer>
    </main>
  );
}

function PipelinePanel({ n, title, lines }: { n: string; title: string; lines: string[] }) {
  return (
    <article className="pipeline-panel">
      <h3>
        <span>{n}</span> {title}
      </h3>
      <pre>{lines.join("\n")}</pre>
    </article>
  );
}

function Connector() {
  return <span className="connector">····›</span>;
}
