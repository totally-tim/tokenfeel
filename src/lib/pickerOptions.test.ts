import { describe, expect, test } from "vitest";
import { filterPickerOptions } from "./pickerOptions";

const options = [
  { value: "dgx-spark", label: "DGX Spark", sub: "128 GB · CUDA" },
  { value: "strix-halo", label: "Strix Halo", sub: "128 GB · ROCm" },
  { value: "m4-max", label: "M4 Max", sub: "128 GB · Metal" },
  { value: "m2-max", label: "M2 Max", sub: "64 GB · Metal" },
  { value: "rtx-4090", label: "RTX 4090", sub: "24 GB · CUDA" }
];

describe("filterPickerOptions", () => {
  test("searches labels and metadata while capping visible choices", () => {
    expect(filterPickerOptions(options, "metal", "dgx-spark", 2)).toEqual([
      { value: "m4-max", label: "M4 Max", sub: "128 GB · Metal" },
      { value: "m2-max", label: "M2 Max", sub: "64 GB · Metal" }
    ]);
  });

  test("keeps the selected option visible for empty searches", () => {
    expect(filterPickerOptions(options, "", "rtx-4090", 3).map((option) => option.value)).toEqual([
      "rtx-4090",
      "dgx-spark",
      "strix-halo"
    ]);
  });
});
