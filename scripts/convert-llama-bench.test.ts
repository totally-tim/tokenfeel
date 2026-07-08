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

  test("threads ppStddev/tgStddev through from JSON rows that carry a stddev_ts field", () => {
    const parsed = parseLlamaBenchMeasurements(
      JSON.stringify([
        { test: "pp512", depth: 0, tokens_per_second: 1000, stddev_ts: 12.5 },
        { test: "tg128", depth: 0, tokens_per_second: 80, stddev_ts: 1.1 },
        { test: "pp512", depth: 4096, tokens_per_second: 750 },
        { test: "tg128", depth: 4096, tokens_per_second: 65 }
      ])
    );

    expect(parsed.measurements[0]).toMatchObject({ depth: 0, ppStddev: 12.5, tgStddev: 1.1 });
    // No stddev field present in the raw row -- must not crash, and must not
    // fabricate a stddev where none was submitted.
    expect(parsed.measurements[1].ppStddev).toBeUndefined();
    expect(parsed.measurements[1].tgStddev).toBeUndefined();
  });

  test("parses markdown rows without stddev without crashing", () => {
    const parsed = parseLlamaBenchMeasurements(`
| backend | test | t/s |
| CUDA | pp2048 @ d0 | 3234.2 |
| CUDA | tg128 @ d0 | 73.3 |
`);

    expect(parsed.measurements[0].ppStddev).toBeUndefined();
    expect(parsed.measurements[0].tgStddev).toBeUndefined();
  });

  test("extracts ppStddev/tgStddev from llama-bench's real markdown '<avg> ± <stddev>' cells", () => {
    const parsed = parseLlamaBenchMeasurements(`
| backend | test | t/s |
| CUDA | pp2048 @ d0 | 3234.20 ± 12.34 |
| CUDA | tg128 @ d0 | 73.30 ± 1.10 |
| CUDA | pp2048 @ d8192 | 2491.00 ± 9.80 |
| CUDA | tg128 @ d8192 | 71.50 ± 0.90 |
`);

    expect(parsed.measurements).toEqual([
      {
        depth: 0,
        pp: 3234.2,
        tg: 73.3,
        ppLabel: "pp2048",
        tgLabel: "tg128",
        ppStddev: 12.34,
        tgStddev: 1.1
      },
      {
        depth: 8192,
        pp: 2491,
        tg: 71.5,
        ppLabel: "pp2048 @ d8192",
        tgLabel: "tg128 @ d8192",
        ppStddev: 9.8,
        tgStddev: 0.9
      }
    ]);
  });

  test("does not let a later stddev-less duplicate row keep a stale stddev from an earlier row at the same depth", () => {
    const parsed = parseLlamaBenchMeasurements(
      JSON.stringify([
        { test: "pp512", depth: 0, tokens_per_second: 1000, stddev_ts: 12.5 },
        { test: "pp512", depth: 0, tokens_per_second: 900 },
        { test: "tg128", depth: 0, tokens_per_second: 80 }
      ])
    );

    expect(parsed.measurements[0]).toMatchObject({ depth: 0, pp: 900 });
    expect(parsed.measurements[0].ppStddev).toBeUndefined();
  });

  test("picks the '<avg> ± <stddev>' cell over a trailing bare-number column (e.g. thread count)", () => {
    const parsed = parseLlamaBenchMeasurements(`
| model | test | t/s | threads |
| llama | pp512 @ d0 | 3234.20 ± 12.34 | 99 |
| llama | tg128 @ d0 | 73.30 ± 1.10 | 99 |
`);

    expect(parsed.measurements).toEqual([
      {
        depth: 0,
        pp: 3234.2,
        tg: 73.3,
        ppLabel: "pp512",
        tgLabel: "tg128",
        ppStddev: 12.34,
        tgStddev: 1.1
      }
    ]);
  });

  test("does not silently drop a row whose measured rate is exactly 0 tokens/s", () => {
    const parsed = parseLlamaBenchMeasurements(
      JSON.stringify([
        { test: "pp512", depth: 0, tokens_per_second: 0 },
        { test: "tg128", depth: 0, tokens_per_second: 80 }
      ])
    );

    expect(parsed.measurements).toEqual([
      { depth: 0, pp: 0, tg: 80, ppLabel: "pp512", tgLabel: "tg128" }
    ]);
  });
});
