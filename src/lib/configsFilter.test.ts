import { describe, expect, test, vi } from "vitest";
import type { BenchmarkResult, HardwareConfig, ModelMetadata, TimelineSummary } from "../types";
import {
  baselineMetric,
  buildBaselineByResultId,
  buildRangeLabel,
  compareRowLabel,
  computeCoverage,
  computeFrontierRows,
  countDistinctHardware,
  filterRowsBySelectionAndQuery,
  labelFor,
  paginateRows,
  plural,
  sortRows,
  toggleCompareSelection,
  topCoverageEntries,
  withAllOption,
  type RankedResultRow
} from "./configsFilter";

const emptySummary: TimelineSummary = {
  wallTimeMs: 0,
  wallTimeRangeMs: { min: 0, max: 0 },
  totalTokens: 0,
  generatedTokens: 0,
  prefilledWithCache: 0,
  prefilledWithoutCache: 0,
  cacheSavedRatio: 0,
  prefillMs: 0,
  decodeMs: 0,
  toolLatencyMs: 0,
  extrapolatedEvents: 0,
  nonMeasuredTimeShare: 0,
  avgDecodeTps: 0
};

function makeResult(overrides: Partial<BenchmarkResult> & { id: string }): BenchmarkResult {
  return {
    hardware: "hw-a",
    model: "model-a",
    quant: "4bit",
    runtime: { name: "llama.cpp", version: "b1", backend: "CUDA", flags: "default", cache: "prefix" },
    measurements: [{ depth: 0, pp: 100, tg: 50 }],
    source: { kind: "raw-json", title: "Synthetic fixture", url: "https://example.com/a" },
    submitter: "test",
    date: "2026-01-01",
    status: "community",
    ...overrides
  };
}

const hardwareA: HardwareConfig = {
  id: "hw-a",
  name: "Hardware A",
  shortName: "HW A",
  vendor: "V",
  memory: "64GB",
  accelerator: "GPU",
  notes: "n"
};
const hardwareB: HardwareConfig = {
  id: "hw-b",
  name: "Hardware B",
  shortName: "HW B",
  vendor: "V",
  memory: "16GB",
  accelerator: "GPU",
  notes: "n"
};
const modelA: ModelMetadata = {
  id: "model-a",
  name: "Model A",
  family: "F",
  params: "7B",
  license: "test",
  notes: "n"
};

function row(overrides: Partial<RankedResultRow> & { result: BenchmarkResult }): RankedResultRow {
  return { seconds: 10, hardware: hardwareA, model: modelA, summary: emptySummary, ...overrides };
}

describe("plural", () => {
  test("uses the singular form for exactly one", () => {
    expect(plural(1, "result")).toBe("result");
  });

  test("uses the plural form for zero and for more than one", () => {
    expect(plural(0, "result")).toBe("results");
    expect(plural(2, "result")).toBe("results");
  });

  test("accepts an irregular plural form", () => {
    expect(plural(2, "config", "configs")).toBe("configs");
  });
});

describe("withAllOption", () => {
  test("prepends a synthetic blank-value 'all' option", () => {
    const options = withAllOption("All hardware", [{ value: "hw-a", label: "Hardware A" }]);

    expect(options).toEqual([
      { value: "", label: "All hardware" },
      { value: "hw-a", label: "Hardware A" }
    ]);
  });
});

describe("labelFor", () => {
  const options = [{ value: "hw-a", label: "Hardware A" }];

  test("finds the label for a known value", () => {
    expect(labelFor(options, "hw-a")).toBe("Hardware A");
  });

  test("falls back to the raw value when it is not in the options", () => {
    expect(labelFor(options, "unknown")).toBe("unknown");
  });

  test("falls back to an empty string when value is undefined", () => {
    expect(labelFor(options, undefined)).toBe("");
  });
});

describe("buildBaselineByResultId / baselineMetric", () => {
  test("reads the lowest-depth measurement's pp/tg per result", () => {
    const result = makeResult({
      id: "r1",
      measurements: [
        { depth: 8192, pp: 900, tg: 40 },
        { depth: 0, pp: 1000, tg: 50 }
      ]
    });
    const map = buildBaselineByResultId([result]);

    expect(baselineMetric(map, "r1", "pp")).toBe(1000);
    expect(baselineMetric(map, "r1", "tg")).toBe(50);
  });

  test("falls back to 0 for an unknown result id instead of throwing", () => {
    const map = buildBaselineByResultId([]);
    expect(baselineMetric(map, "missing", "pp")).toBe(0);
  });

  test("warns (does not throw) when a result has no measurements", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = { ...makeResult({ id: "r1" }), measurements: [] };

    const map = buildBaselineByResultId([result]);

    expect(baselineMetric(map, "r1", "pp")).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("r1"));
    warnSpy.mockRestore();
  });
});

describe("filterRowsBySelectionAndQuery", () => {
  const rows: RankedResultRow[] = [
    row({ result: makeResult({ id: "r1", status: "verified" }), hardware: hardwareA, model: modelA }),
    row({ result: makeResult({ id: "r2", hardware: "hw-b", status: "community" }), hardware: hardwareB, model: modelA })
  ];
  const selectedIds = new Set(["r1", "r2"]);

  test("keeps only rows whose id is in the selected set", () => {
    const filtered = filterRowsBySelectionAndQuery(rows, new Set(["r1"]), "", false);
    expect(filtered.map((r) => r.result.id)).toEqual(["r1"]);
  });

  test("matches query case-insensitively against hardware/model/runtime/quant", () => {
    const filtered = filterRowsBySelectionAndQuery(rows, selectedIds, "HARDWARE B", false);
    expect(filtered.map((r) => r.result.id)).toEqual(["r2"]);
  });

  test("verifiedOnly excludes non-verified rows", () => {
    const filtered = filterRowsBySelectionAndQuery(rows, selectedIds, "", true);
    expect(filtered.map((r) => r.result.id)).toEqual(["r1"]);
  });
});

describe("sortRows", () => {
  const baselineByResultId = buildBaselineByResultId([
    makeResult({ id: "r1", measurements: [{ depth: 0, pp: 100, tg: 10 }] }),
    makeResult({ id: "r2", measurements: [{ depth: 0, pp: 900, tg: 90 }] })
  ]);
  const rows: RankedResultRow[] = [
    row({ result: makeResult({ id: "r1" }), seconds: 5 }),
    row({ result: makeResult({ id: "r2" }), seconds: 20 })
  ];

  test("leaves the existing order untouched when sorting by seconds", () => {
    expect(sortRows(rows, "seconds", baselineByResultId).map((r) => r.result.id)).toEqual(["r1", "r2"]);
  });

  test("sorts by pp descending", () => {
    expect(sortRows(rows, "pp", baselineByResultId).map((r) => r.result.id)).toEqual(["r2", "r1"]);
  });

  test("sorts by tg descending", () => {
    expect(sortRows(rows, "tg", baselineByResultId).map((r) => r.result.id)).toEqual(["r2", "r1"]);
  });

  test("does not mutate the input array", () => {
    const original = [...rows];
    sortRows(rows, "pp", baselineByResultId);
    expect(rows).toEqual(original);
  });
});

describe("paginateRows", () => {
  const items = Array.from({ length: 25 }, (_, index) => index);

  test("splits into pages of the given size", () => {
    const page = paginateRows(items, 0, 10);
    expect(page.visibleRows).toEqual(items.slice(0, 10));
    expect(page.pageCount).toBe(3);
    expect(page.firstVisible).toBe(1);
    expect(page.lastVisible).toBe(10);
  });

  test("clamps an out-of-range page index to the last page", () => {
    const page = paginateRows(items, 99, 10);
    expect(page.safePageIndex).toBe(2);
    expect(page.visibleRows).toEqual(items.slice(20, 25));
  });

  test("clamps a negative page index to the first page", () => {
    const page = paginateRows(items, -3, 10);
    expect(page.safePageIndex).toBe(0);
    expect(page.visibleRows).toEqual(items.slice(0, 10));
    expect(page.firstVisible).toBe(1);
  });

  test("always reports at least one page, even for an empty list", () => {
    const page = paginateRows([], 0, 10);
    expect(page.pageCount).toBe(1);
    expect(page.visibleRows).toEqual([]);
    expect(page.firstVisible).toBe(0);
    expect(page.lastVisible).toBe(0);
  });
});

describe("buildRangeLabel", () => {
  test("reports 'No results' for an empty set", () => {
    expect(buildRangeLabel(0, 0, 0)).toBe("No results");
  });

  test("formats a 1-indexed inclusive range", () => {
    expect(buildRangeLabel(25, 1, 10)).toBe("Showing 1-10 of 25");
  });
});

describe("computeFrontierRows", () => {
  const baselineByResultId = buildBaselineByResultId([
    makeResult({ id: "r1", measurements: [{ depth: 0, pp: 100, tg: 100 }] }),
    makeResult({ id: "r2", measurements: [{ depth: 0, pp: 100, tg: 50 }] })
  ]);
  const rows: RankedResultRow[] = [
    row({ result: makeResult({ id: "r1" }), seconds: 5 }),
    row({ result: makeResult({ id: "r2" }), seconds: 15 })
  ];

  test("gives the fastest (lowest-seconds) row the longest loop bar", () => {
    const frontier = computeFrontierRows(rows, baselineByResultId);
    expect(frontier[0].result.id).toBe("r1");
    expect(frontier[0].loopPct).toBeGreaterThan(frontier[1].loopPct);
  });

  test("scales decode bar length by tg rate relative to the fastest decode in the set", () => {
    const frontier = computeFrontierRows(rows, baselineByResultId);
    expect(frontier[0].tgRate).toBe(100);
    expect(frontier[0].decodePct).toBe(100);
    expect(frontier[1].decodePct).toBeCloseTo(50);
  });

  test("gives every row equal (100%) loop bars when all seconds are tied", () => {
    const tiedRows: RankedResultRow[] = [
      row({ result: makeResult({ id: "r1" }), seconds: 10 }),
      row({ result: makeResult({ id: "r2" }), seconds: 10 })
    ];
    const frontier = computeFrontierRows(tiedRows, baselineByResultId);
    expect(frontier.every((entry) => entry.loopPct === 100)).toBe(true);
  });

  test("respects the limit", () => {
    const manyRows = Array.from({ length: 10 }, (_, index) =>
      row({ result: makeResult({ id: `r${index}` }), seconds: index })
    );
    expect(computeFrontierRows(manyRows, baselineByResultId, 3)).toHaveLength(3);
  });
});

describe("computeCoverage / topCoverageEntries", () => {
  const rows: RankedResultRow[] = [
    row({ result: makeResult({ id: "r1", hardware: "hw-a", status: "verified" }) }),
    row({ result: makeResult({ id: "r2", hardware: "hw-a", status: "community" }) }),
    row({
      result: makeResult({
        id: "r3",
        hardware: "hw-b",
        status: "community",
        evidence: { rawUrl: "https://example.com/raw" }
      })
    })
  ];

  test("groups totals/verified/raw counts per hardware id", () => {
    const coverage = computeCoverage(rows);

    expect(coverage.get("hw-a")).toEqual({ hardware: "hw-a", total: 2, verified: 1, raw: 0 });
    expect(coverage.get("hw-b")).toEqual({ hardware: "hw-b", total: 1, verified: 0, raw: 1 });
  });

  test("ranks coverage entries by total descending and reports the max", () => {
    const coverage = computeCoverage(rows);
    const { rows: ranked, maxTotal } = topCoverageEntries(coverage);

    expect(ranked.map((entry) => entry.hardware)).toEqual(["hw-a", "hw-b"]);
    expect(maxTotal).toBe(2);
  });
});

describe("countDistinctHardware", () => {
  test("counts unique hardware ids across rows", () => {
    const rows: RankedResultRow[] = [
      row({ result: makeResult({ id: "r1", hardware: "hw-a" }) }),
      row({ result: makeResult({ id: "r2", hardware: "hw-a" }) }),
      row({ result: makeResult({ id: "r3", hardware: "hw-b" }) })
    ];

    expect(countDistinctHardware(rows)).toBe(2);
  });
});

describe("toggleCompareSelection", () => {
  test("adds an id that is not yet selected", () => {
    expect(toggleCompareSelection([], "a")).toEqual(["a"]);
    expect(toggleCompareSelection(["a"], "b")).toEqual(["a", "b"]);
  });

  test("removes an id that is already selected", () => {
    expect(toggleCompareSelection(["a", "b"], "a")).toEqual(["b"]);
  });

  test("replaces the oldest selection once two are already picked (a 2-slot compare tray)", () => {
    expect(toggleCompareSelection(["a", "b"], "c")).toEqual(["b", "c"]);
  });
});

describe("compareRowLabel", () => {
  const rows: RankedResultRow[] = [row({ result: makeResult({ id: "r1" }), hardware: hardwareA })];

  test("uses the hardware's short name when available", () => {
    expect(compareRowLabel(rows, "r1")).toBe("HW A");
  });

  test("falls back to the raw id when the row is not found", () => {
    expect(compareRowLabel(rows, "unknown")).toBe("unknown");
  });
});
