import { describe, expect, test } from "vitest";
import {
  exceedsRoofline,
  modelFromEntry,
  parseRawLog,
  usableSweep,
  type Candidate,
  type SnapshotEntry
} from "./import-spark-arena";

function makeEntry(overrides: Partial<SnapshotEntry> = {}): SnapshotEntry {
  return {
    modelName: "Qwen3.5-35B-A3B-NVFP4",
    modelFullPath: "nvidia/Qwen3.5-35B-A3B-NVFP4",
    runtime: "vLLM",
    clusterSize: 1,
    tokensPerSec: 100,
    benchmarkId: "sub1",
    quantization: "NVFP4",
    submittedAt: "2026-05-01T00:00:00.000Z",
    ...overrides
  };
}

function makeCandidate(prefill: Array<[number, number]>, decode: Array<[number, number]>): Candidate {
  return {
    benchmarkId: "sub1",
    meta: makeEntry(),
    prefill: new Map(prefill),
    decode: new Map(decode)
  };
}

describe("parseRawLog", () => {
  test("reads the markdown pipe table format, keeping the ± stddev", () => {
    const parsed = parseRawLog(
      [
        "| model               |         test |      t/s (total) |        t/s (req) |",
        "|:--------------------|-------------:|-----------------:|-----------------:|",
        "| openai/gpt-oss-120b |  pp2048 (c1) | 6294.54 ± 625.36 | 6294.54 ± 625.36 |",
        "| openai/gpt-oss-120b |   tg128 (c1) |     75.96 ± 0.73 |     75.96 ± 0.73 |"
      ].join("\n")
    );
    expect(parsed.get("pp2048 (c1)")).toEqual({ mean: 6294.54, stddev: 625.36 });
    expect(parsed.get("tg128 (c1)")).toEqual({ mean: 75.96, stddev: 0.73 });
  });

  test("reads the comma-separated format with explicit mean/std columns", () => {
    const parsed = parseRawLog(
      ["model,test_name,t_s_mean,t_s_std", "nvidia/Nemotron,pp2048 (c1),1315.5753,341.8201"].join("\n")
    );
    expect(parsed.get("pp2048 (c1)")?.mean).toBeCloseTo(1315.5753, 4);
    expect(parsed.get("pp2048 (c1)")?.stddev).toBeCloseTo(341.8201, 4);
  });

  test("reads the tab-separated variant", () => {
    const parsed = parseRawLog(["model\ttest_name\tt_s_mean\tt_s_std", "a/b\ttg128 (c1)\t42.5\t0.5"].join("\n"));
    expect(parsed.get("tg128 (c1)")).toEqual({ mean: 42.5, stddev: 0.5 });
  });

  test("reads the quoted csv variant", () => {
    const parsed = parseRawLog(['"model","test","t/s (total)"', '"a/b","pp2048 (c1)","742.67 ± 39.31"'].join("\n"));
    expect(parsed.get("pp2048 (c1)")).toEqual({ mean: 742.67, stddev: 39.31 });
  });

  // Some Spark Arena exports mangle "±" into mojibake; the value must still parse.
  test.each(["Â±", "¬±"])("survives a %s-mangled separator", (separator) => {
    const parsed = parseRawLog(
      [
        "| model | test | t/s (total) |",
        "|:------|-----:|------------:|",
        `| a/b | pp2048 (c1) | 1044.40 ${separator} 65.09 |`
      ].join("\n")
    );
    expect(parsed.get("pp2048 (c1)")).toEqual({ mean: 1044.4, stddev: 65.09 });
  });

  test("ignores the markdown alignment row rather than reading it as data", () => {
    const parsed = parseRawLog(
      ["| model | test | t/s (total) |", "|:------|-----:|------------:|", "| a/b | pp2048 (c1) | 100.0 |"].join("\n")
    );
    expect([...parsed.keys()]).toEqual(["pp2048 (c1)"]);
  });
});

describe("usableSweep", () => {
  const decay: Array<[number, number]> = [
    [0, 100],
    [8192, 90],
    [16384, 80]
  ];

  test("keeps a decaying sweep measured at shared depths", () => {
    const sweep = usableSweep(makeCandidate(decay, decay));
    expect(sweep?.depths).toEqual([0, 8192, 16384]);
  });

  test("drops a sweep whose depths are not shared between prefill and decode", () => {
    expect(
      usableSweep(
        makeCandidate(decay, [
          [0, 100],
          [4096, 90]
        ])
      )
    ).toBeUndefined();
  });

  test("drops a sweep that never reaches the 8k simulation floor", () => {
    const shallow: Array<[number, number]> = [
      [0, 100],
      [1024, 90],
      [4096, 80]
    ];
    expect(usableSweep(makeCandidate(shallow, shallow))).toBeUndefined();
  });

  test("drops a sweep that speeds up past the cold-start transition", () => {
    const spike: Array<[number, number]> = [
      [0, 100],
      [8192, 90],
      [16384, 200]
    ];
    expect(usableSweep(makeCandidate(spike, decay))).toBeUndefined();
  });

  test("exempts a first-transition increase when a longer curve confirms it is confined there", () => {
    const warmup: Array<[number, number]> = [
      [0, 50],
      [8192, 100],
      [16384, 95]
    ];
    expect(usableSweep(makeCandidate(warmup, warmup))?.depths).toEqual([0, 8192, 16384]);
  });
});

describe("exceedsRoofline", () => {
  const moe = modelFromEntry(makeEntry({ modelName: "Qwen3.6-35B-A3B-NVFP4" }));

  test("infers active parameters from an A<N>B model name", () => {
    expect(moe.params).toBe("35B");
    expect(moe.activeParams).toBe("3B");
  });

  test("rejects a prefill rate past what the accelerator could issue", () => {
    // The real Spark Arena row this guards against: ~937k t/s for a 3B-active
    // model on one GB10, several times the theoretical ceiling.
    expect(exceedsRoofline(moe, 1, 937495)).toBe(true);
  });

  test("keeps a fast but physically possible rate", () => {
    expect(exceedsRoofline(moe, 1, 2643)).toBe(false);
  });

  test("scales the ceiling with cluster size", () => {
    const single = exceedsRoofline(moe, 1, 400000);
    expect(single).toBe(true);
    expect(exceedsRoofline(moe, 8, 400000)).toBe(false);
  });

  test("tolerates an undisclosed MoE active count instead of rejecting the row", () => {
    // "gpt-oss-120b" is a MoE with roughly 5B active, but the name only
    // discloses 120B, so a strict ceiling would wrongly reject a real run.
    const undisclosed = modelFromEntry(makeEntry({ modelName: "gpt-oss-120b", modelFullPath: "openai/gpt-oss-120b" }));
    expect(undisclosed.params).toBe("120B");
    expect(exceedsRoofline(undisclosed, 1, 4229)).toBe(false);
  });

  test("passes a model whose parameter count cannot be parsed", () => {
    const unknown = modelFromEntry(makeEntry({ modelName: "mystery-model", modelFullPath: "x/mystery-model" }));
    expect(unknown.params).toBe("unknown");
    expect(exceedsRoofline(unknown, 1, 1e9)).toBe(false);
  });
});
