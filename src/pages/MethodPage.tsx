import { AlertTriangle, Database, GitPullRequest, Gauge, Scale, TimerReset } from "lucide-react";
import { PhaseLegend } from "../components/PhaseLegend";

export function MethodPage() {
  return (
    <main className="doc-page">
      <section className="doc-hero">
        <p className="eyebrow">DATA & METHOD</p>
        <h1>Pure math playback from published benchmark rows.</h1>
        <p>
          Tokenfeel never runs inference. It turns prefill and decode rates into a deterministic event schedule, then
          renders the scenario against wall-clock time.
        </p>
      </section>
      <section className="method-grid">
        <article>
          <Gauge />
          <h2>Timing model</h2>
          <p>
            Prefill uses measured TTFT when benchmark rows include it; otherwise it falls back to prompt tokens divided
            by pp(depth), plus submitted overhead. Decode is one over tg(depth) per token. Both rates are integrated
            across the full depth span an event traverses, not sampled once at a single depth, so pricing reflects the
            real degradation over the span instead of a single snapshot.
          </p>
        </article>
        <article>
          <TimerReset />
          <h2>Depth interpolation</h2>
          <p>
            Rates between measured depths are linear. Beyond the last measured row, the app fits a trend to the
            submitted points and extrapolates it — this is now the canonical, realistic pace, with the old flat value
            kept only as an optimistic lower bound. A single-point submission has no trend to fit, so depths past that
            one point are explicitly flagged "no depth data" rather than silently held flat.
          </p>
        </article>
        <article>
          <Database />
          <h2>Repo database</h2>
          <p>
            Hardware, models, results and scenarios live in JSON files. CI validates schema, source links and plausible
            positive rates.
          </p>
        </article>
        <article>
          <GitPullRequest />
          <h2>Verification flow</h2>
          <p>
            Community rows are visible by default. Verified rows require maintainer reproduction or a trustworthy public
            leaderboard with raw logs.
          </p>
        </article>
        <article>
          <Scale />
          <h2>Uncertainty & race verdicts</h2>
          <p>
            Every summary carries a wall-time range, not just a point estimate, and widens when non-measured depths make
            up more of the run or when contributors supply ppStddev/tgStddev. Race mode compares those ranges: if two
            configs' honest ranges overlap, it reports "too close to call from this data" instead of forcing a winner.
          </p>
        </article>
      </section>
      <section className="snippet-panel phase-legend-panel">
        <h2>The five playback phases</h2>
        <p>
          Every simulator surface — Playground and both Race lanes — speaks one visual language. Each phase has its own
          color and motion, so you can read the state at a glance.
        </p>
        <PhaseLegend />
        <p className="phase-legend-caption">
          User and tool-result events add prompt tokens and can require prefill. Assistant, thinking and tool-call
          events are generated tokens and are decoded. Cache busts reduce the reusable prefix and make the re-prefill
          cost visible.
        </p>
      </section>
      <section className="not-modeled">
        <AlertTriangle />
        <div>
          <h2>Not modeled in v1</h2>
          <p>
            Batching, speculative decoding, KV eviction, tokenization cost, sampling cost, thermal throttling and
            network latency stay out of ranking math unless contributors submit trustworthy data for those fields.
          </p>
        </div>
      </section>
    </main>
  );
}
