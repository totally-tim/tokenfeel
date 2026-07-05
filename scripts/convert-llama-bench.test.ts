import { describe, expect, test } from "vitest";
import { parseLlamaBenchMeasurements } from "./convert-llama-bench";

describe("parseLlamaBenchMeasurements", () => {
  test("parses paired markdown pp/tg rows into depth measurements", () => {
    const parsed = parseLlamaBenchMeasurements(`
| backend | test | t/s |
| CUDA | pp2048 @ d0 | 3234.2 |
| CUDA | tg128 @ d0 | 73.3 |
| CUDA | pp2048 @ d8192 | 2491.0 |
| CUDA | tg128 @ d8192 | 71.5 |
`);

    expect(parsed.measurements).toEqual([
      { depth: 0, pp: 3234.2, tg: 73.3, ppLabel: "pp2048", tgLabel: "tg128" },
      { depth: 8192, pp: 2491, tg: 71.5, ppLabel: "pp2048 @ d8192", tgLabel: "tg128 @ d8192" }
    ]);
    expect(parsed.rawRows).toHaveLength(4);
  });

  test("parses JSON output rows with test and tokens_per_second fields", () => {
    const parsed = parseLlamaBenchMeasurements(
      JSON.stringify([
        { test: "pp512", depth: 0, tokens_per_second: 1000 },
        { test: "tg128", depth: 0, tokens_per_second: 80 },
        { test: "pp512", depth: 4096, tokens_per_second: 750 },
        { test: "tg128", depth: 4096, tokens_per_second: 65 }
      ])
    );

    expect(parsed.measurements).toEqual([
      { depth: 0, pp: 1000, tg: 80, ppLabel: "pp512", tgLabel: "tg128" },
      { depth: 4096, pp: 750, tg: 65, ppLabel: "pp512 @ d4096", tgLabel: "tg128 @ d4096" }
    ]);
  });
});
