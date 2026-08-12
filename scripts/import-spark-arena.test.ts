import { describe, expect, test } from "vitest";
import {
  billionsFromParamLabel,
  bytesPerParamForQuant,
  canonicalModelName,
  exceedsMemory,
  exceedsRoofline,
  modelFromEntry,
  parseRawLog,
  quantFromEntry,
  resolveModelMetadata,
  usableSweep,
  weightFormatsFromRepo,
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
    decode: new Map(decode),
    clientOverheadMs: new Map()
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

  test("honours quoting when a field contains the delimiter", () => {
    // A naive split(",") shifts every later column and silently drops both the
    // measurement and its cross-check.
    const parsed = parseRawLog(
      ['"model","test","t/s (total)"', '"Acme, Inc/model","pp2048 (c1)","742.67 ± 39.31"'].join("\n")
    );
    expect(parsed.get("pp2048 (c1)")).toEqual({ mean: 742.67, stddev: 39.31 });
  });

  test("reads a doubled quote inside a quoted field as one literal quote", () => {
    const parsed = parseRawLog(['"model","test","t/s (total)"', '"a""b/model","tg128 (c1)","42.5"'].join("\n"));
    expect(parsed.get("tg128 (c1)")?.mean).toBe(42.5);
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
    expect(exceedsRoofline(moe, 1, 400000)).toBe(true);
    expect(exceedsRoofline(moe, 8, 400000)).toBe(false);
  });

  test("skips the check when the active count is undisclosed", () => {
    // "gpt-oss-120b" is a MoE with roughly 5B active, but the name discloses
    // only 120B. Falling back to the total would put the ceiling at 4167 t/s
    // and reject a real 4229 t/s run as physically impossible.
    const undisclosed = modelFromEntry(makeEntry({ modelName: "gpt-oss-120b", modelFullPath: "openai/gpt-oss-120b" }));
    expect(undisclosed.params).toBe("120B");
    expect(undisclosed.activeParams).toBeUndefined();
    expect(exceedsRoofline(undisclosed, 1, 4229)).toBe(false);
    expect(exceedsRoofline(undisclosed, 1, 1e9)).toBe(false);
  });

  test("passes a model whose parameter count cannot be parsed", () => {
    const unknown = modelFromEntry(makeEntry({ modelName: "mystery-model", modelFullPath: "x/mystery-model" }));
    expect(unknown.params).toBe("unknown");
    expect(exceedsRoofline(unknown, 1, 1e9)).toBe(false);
  });
});

describe("quantFromEntry", () => {
  test("prefers the format published in the repo name over the submitter's label", () => {
    // Real row: the repo builds NVFP4 weights but the submitter typed BFLOAT16,
    // which would offer a quantization of this checkpoint that does not exist.
    expect(
      quantFromEntry(makeEntry({ modelFullPath: "lukealonso/MiniMax-M2.7-NVFP4", quantization: "BFLOAT16" }))
    ).toBe("nvfp4");
  });

  test("collapses a method label onto the format the repo states", () => {
    // The same Intel repo arrived twice, as "INT4" and as "AUTO-ROUND", which
    // split one configuration into a phantom quant comparison.
    const repo = "Intel/Qwen3.5-122B-A10B-int4-AutoRound";
    expect(quantFromEntry(makeEntry({ modelFullPath: repo, quantization: "INT4" }))).toBe("int4");
    expect(quantFromEntry(makeEntry({ modelFullPath: repo, quantization: "AUTO-ROUND" }))).toBe("int4");
  });

  test("prefers the longer token when formats overlap", () => {
    expect(quantFromEntry(makeEntry({ modelFullPath: "nvidia/Model-NVFP4", quantization: "x" }))).toBe("nvfp4");
    expect(quantFromEntry(makeEntry({ modelFullPath: "org/Model-MXFP8", quantization: "x" }))).toBe("mxfp8");
  });

  test("does not read a weight format out of the org name", () => {
    expect(quantFromEntry(makeEntry({ modelFullPath: "fp8-labs/Some-Model", quantization: "NVFP4" }))).toBe("nvfp4");
  });

  test("falls back to the submitter label when the repo names no format", () => {
    expect(quantFromEntry(makeEntry({ modelFullPath: "MiniMaxAI/MiniMax-M2.5", quantization: "BF16" }))).toBe("bf16");
  });
});

describe("exceedsMemory", () => {
  const flash162 = modelFromEntry(
    makeEntry({ modelName: "DeepSeek-V4-Flash-162B", modelFullPath: "0xSero/DeepSeek-V4-Flash-162B" })
  );

  test("uses the measured parameter count, not the one in the repo name", () => {
    // The repo name says 162B; it actually stores 92.2B unpacked elements.
    expect(flash162.params).toBe("92B");
  });

  test("rejects weights that cannot fit the cluster", () => {
    // 162B of FP8 weights would be 162GB on a 128GB single node.
    const asNamed = { ...flash162, params: "162B" };
    expect(exceedsMemory(asNamed, "fp8", 1)).toBe(true);
    expect(exceedsMemory(flash162, "fp8", 1)).toBe(false);
  });

  test("accounts for the weight format and the cluster size", () => {
    const big = { ...flash162, params: "400B" };
    // 400B: 800GB at bf16, 400GB at fp8, 200GB at nvfp4.
    expect(exceedsMemory(big, "bf16", 1)).toBe(true);
    expect(exceedsMemory(big, "nvfp4", 1)).toBe(true);
    expect(exceedsMemory(big, "nvfp4", 2)).toBe(false);
    expect(exceedsMemory(big, "bf16", 4)).toBe(true);
    expect(exceedsMemory(big, "bf16", 8)).toBe(false);
  });

  test("passes when the format or parameter count is unknown", () => {
    expect(exceedsMemory(flash162, "some-unknown-format", 1)).toBe(false);
    expect(exceedsMemory({ ...flash162, params: "unknown" }, "fp8", 1)).toBe(false);
  });

  test("sizes a hybrid checkpoint by its smallest component", () => {
    // A hybrid stores different tensors in different formats, so the gate stays
    // a claim about what cannot fit under the most favourable packing.
    expect(bytesPerParamForQuant("int4-fp8")).toBe(0.5);
    expect(bytesPerParamForQuant("nvfp4-bf16")).toBe(0.5);
    expect(bytesPerParamForQuant("fp8")).toBe(1);
    expect(bytesPerParamForQuant("int4-mystery")).toBeUndefined();
  });
});

describe("billionsFromParamLabel", () => {
  test("reads the A-prefixed active-parameter form", () => {
    // Two hand-authored records write activeParams as "A3B" rather than "3B".
    // Both gates allow the row when this returns undefined, so failing to read
    // the second form let a 937k t/s claim past the roofline check.
    expect(billionsFromParamLabel("A3B")).toBe(3);
    expect(billionsFromParamLabel("3B")).toBe(3);
    expect(billionsFromParamLabel("284B")).toBe(284);
    expect(billionsFromParamLabel("500M")).toBe(0.5);
    expect(billionsFromParamLabel("MoE")).toBeUndefined();
  });

  test("keeps the roofline gate firing on an A-prefixed active count", () => {
    const model = {
      id: "m",
      name: "M",
      family: "Qwen",
      params: "35B",
      activeParams: "A3B",
      license: "x",
      notes: "Hand-authored."
    };
    // 1 GB10 at 1 PFLOP / (2 * 3B) is roughly 167k t/s.
    expect(exceedsRoofline(model, 1, 937495)).toBe(true);
    expect(exceedsRoofline(model, 1, 100000)).toBe(false);
  });
});

describe("weightFormatsFromRepo", () => {
  test("keeps every format a hybrid checkpoint names, in name order", () => {
    expect(weightFormatsFromRepo("bleysg/Qwen3.5-122B-A10B-int4-fp8-hybrid")).toEqual(["int4", "fp8"]);
    expect(weightFormatsFromRepo("rdtand/Qwen3.6-27B-Blackwell-NVFP4-BF16-vllm")).toEqual(["nvfp4", "bf16"]);
  });

  test("never reads a longer token as the shorter one it contains", () => {
    expect(weightFormatsFromRepo("nvidia/Model-NVFP4")).toEqual(["nvfp4"]);
    expect(weightFormatsFromRepo("org/Model-MXFP8")).toEqual(["mxfp8"]);
  });
});

describe("canonicalModelName", () => {
  test("strips weight-format decoration so quant is not part of model identity", () => {
    expect(canonicalModelName("MiniMax-M2.5-AWQ")).toBe("MiniMax-M2.5");
    expect(canonicalModelName("MiniMax-M2.5-AWQ-4bit")).toBe("MiniMax-M2.5");
    expect(canonicalModelName("Qwen3.5-122B-A10B-int4-AutoRound")).toBe("Qwen3.5-122B-A10B");
    expect(canonicalModelName("Qwen3.5-122B-A10B-FP8")).toBe("Qwen3.5-122B-A10B");
  });

  test("leaves a name that states no weight format untouched", () => {
    // "162B" is a size, not a format: this community-pruned derivative must stay
    // distinct from the 284B DeepSeek-V4-Flash it came from.
    expect(canonicalModelName("DeepSeek-V4-Flash-162B")).toBe("DeepSeek-V4-Flash-162B");
    expect(canonicalModelName("DeepSeek-V4-Flash")).toBe("DeepSeek-V4-Flash");
    expect(canonicalModelName("gpt-oss-120b")).toBe("gpt-oss-120b");
  });

  test("gives quant variants of one checkpoint the same model id", () => {
    const awq = modelFromEntry(
      makeEntry({ modelName: "MiniMax-M2.5-AWQ", modelFullPath: "quanttrio/MiniMax-M2.5-AWQ" })
    );
    const awq4 = modelFromEntry(
      makeEntry({ modelName: "MiniMax-M2.5-AWQ-4bit", modelFullPath: "cyankiwi/MiniMax-M2.5-AWQ-4bit" })
    );
    expect(awq.id).toBe(awq4.id);
    expect(awq.id).toBe("minimax-m2.5");
  });

  test("still reads the parameter counts out of the undecorated name", () => {
    const model = modelFromEntry(
      makeEntry({
        modelName: "Qwen3.5-122B-A10B-int4-AutoRound",
        modelFullPath: "Intel/Qwen3.5-122B-A10B-int4-AutoRound"
      })
    );
    expect(model.id).toBe("qwen3.5-122b-a10b");
    expect(model.params).toBe("122B");
    expect(model.activeParams).toBe("10B");
  });
});

describe("resolveModelMetadata", () => {
  const inferred = modelFromEntry(
    makeEntry({ modelName: "DeepSeek-V4-Flash", modelFullPath: "deepseek-ai/DeepSeek-V4-Flash" })
  );

  test("infers nothing useful from a name that states no size", () => {
    expect(inferred.params).toBe("unknown");
  });

  test("prefers a hand-authored record so the gates get a real parameter count", () => {
    const curated = { ...inferred, params: "284B", activeParams: "13B", notes: "Hand-authored." };
    const resolved = resolveModelMetadata(inferred, curated);
    expect(resolved.params).toBe("284B");
    // 284B of FP8 weights cannot fit two 128GB nodes; without the curated record
    // the gate had nothing to check and admitted the row.
    expect(exceedsMemory(resolved, "fp8", 2)).toBe(true);
    expect(exceedsMemory(inferred, "fp8", 2)).toBe(false);
  });

  test("only fills gaps from a previously generated record", () => {
    const generated = {
      ...inferred,
      params: "284B",
      notes: "Generated from the Spark Arena DGX Spark leaderboard import. ..."
    };
    expect(resolveModelMetadata(inferred, generated).params).toBe("284B");
    expect(resolveModelMetadata({ ...inferred, params: "92B" }, generated).params).toBe("92B");
  });

  test("returns the inferred record when nothing exists yet", () => {
    expect(resolveModelMetadata(inferred, undefined)).toBe(inferred);
  });
});
