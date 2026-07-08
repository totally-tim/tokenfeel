import { describe, expect, test } from "vitest";
import { buildGroups, resultFromGroup, runtimeSlug, type OmlxRow } from "./import-omlx-benchmarks";

function makeRow(overrides: Partial<OmlxRow> = {}): OmlxRow {
  return {
    id: "row-1",
    created_at: "2026-03-08 13:13:00",
    chip_name: "M3",
    chip_variant: "Ultra",
    memory_gb: 512,
    gpu_cores: 80,
    omlx_version: "0.2.6",
    os_version: "macOS 15.5",
    model_name: "Qwen3.5-9B",
    model_variant: "",
    quantization: "8bit",
    context_length: 1024,
    pp_tps: 500,
    tg_tps: 40,
    ttft_ms: 1000,
    peak_memory_gb: 20,
    batching_results: null,
    ...overrides
  };
}

describe("buildGroups", () => {
  test("keeps rows from the same hardware/model/quant/toolchain/OS in one group", () => {
    const rows = [makeRow({ id: "a", context_length: 1024 }), makeRow({ id: "b", context_length: 4096 })];

    const { groups } = buildGroups(rows);

    expect(groups.size).toBe(1);
    const [group] = [...groups.values()];
    expect(group.selectedByDepth.size).toBe(2);
  });

  test("splits rows with the same hardware/model/quant but a different oMLX toolchain version into separate groups (D1 fix)", () => {
    const rows = [
      makeRow({ id: "a", context_length: 1024, omlx_version: "0.2.6" }),
      makeRow({ id: "b", context_length: 4096, omlx_version: "0.3.0" })
    ];

    const { groups } = buildGroups(rows);

    expect(groups.size).toBe(2);
    for (const group of groups.values()) {
      expect(group.selectedByDepth.size).toBe(1);
    }
  });

  test("splits rows with the same oMLX version but a different OS version into separate groups (D1 fix)", () => {
    const rows = [
      makeRow({ id: "a", context_length: 1024, os_version: "macOS 15.5" }),
      makeRow({ id: "b", context_length: 4096, os_version: "macOS 26.4" })
    ];

    const { groups } = buildGroups(rows);

    expect(groups.size).toBe(2);
  });

  test("produces distinct result ids for groups that only differ by toolchain/OS version", () => {
    const rows = [
      makeRow({ id: "a", context_length: 1024, omlx_version: "0.2.6", os_version: "macOS 15.5" }),
      makeRow({ id: "b", context_length: 1024, omlx_version: "0.3.0", os_version: "macOS 15.5" }),
      makeRow({ id: "c", context_length: 1024, omlx_version: "0.2.6", os_version: "macOS 26.4" })
    ];

    const { groups } = buildGroups(rows);
    const ids = [...groups.values()].map((group) => resultFromGroup(group, "2026-01-01T00:00:00.000Z").id);

    expect(new Set(ids).size).toBe(3);
  });
});

describe("runtimeSlug", () => {
  test("differs when the oMLX version differs", () => {
    const a = runtimeSlug(makeRow({ omlx_version: "0.2.6" }));
    const b = runtimeSlug(makeRow({ omlx_version: "0.3.0" }));

    expect(a).not.toBe(b);
  });

  test("differs when the OS version differs", () => {
    const a = runtimeSlug(makeRow({ os_version: "macOS 15.5" }));
    const b = runtimeSlug(makeRow({ os_version: "macOS 26.4" }));

    expect(a).not.toBe(b);
  });

  test("falls back to 'unknown' for missing toolchain/OS fields without crashing", () => {
    expect(() => runtimeSlug(makeRow({ omlx_version: "", os_version: "" }))).not.toThrow();
  });
});

describe("resultFromGroup", () => {
  test("uses the supplied retrievedAt deterministically instead of the current wall clock", () => {
    const rows = [makeRow({ id: "a", context_length: 1024 })];
    const { groups } = buildGroups(rows);
    const [group] = [...groups.values()];

    const first = resultFromGroup(group, "2026-01-01T00:00:00.000Z");
    const second = resultFromGroup(group, "2026-01-01T00:00:00.000Z");

    expect(first).toEqual(second);
    expect(first.evidence.retrievedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("measurements only contain depths from the group's own toolchain/OS combination", () => {
    const rows = [
      makeRow({ id: "a", context_length: 1024, omlx_version: "0.2.6", os_version: "macOS 15.5" }),
      makeRow({ id: "b", context_length: 4096, omlx_version: "0.3.0", os_version: "macOS 26.4" })
    ];
    const { groups } = buildGroups(rows);

    for (const group of groups.values()) {
      const result = resultFromGroup(group, "2026-01-01T00:00:00.000Z");
      expect(result.measurements).toHaveLength(1);
    }
  });
});
