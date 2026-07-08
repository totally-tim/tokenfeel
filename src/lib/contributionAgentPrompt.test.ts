import { describe, expect, it } from "vitest";
import { contributionAgentPrompt, contributionVerificationChecks } from "./contributionAgentPrompt";

describe("contribution agent prompt", () => {
  it("anchors agents to verifiable local benchmark evidence and repo checks", () => {
    expect(contributionAgentPrompt).toContain("Do not invent");
    expect(contributionAgentPrompt).toContain("raw output");
    expect(contributionAgentPrompt).toContain("data/results/<hardware>__<model>__<quant>__<runtime>.json");
    expect(contributionAgentPrompt).toContain(
      "Include id, hardware, model, quant, runtime, measurements, source, submitter, date, and status"
    );
    expect(contributionAgentPrompt).toContain("npm run validate:data");
    expect(contributionAgentPrompt).toContain("npm test");
    expect(contributionAgentPrompt).toContain("npm run build");
    expect(contributionAgentPrompt).toContain("pull request");
  });

  it("keeps the visible checklist in sync with agent verification requirements", () => {
    expect(contributionVerificationChecks).toEqual([
      "Raw benchmark command and unedited output are attached or linked.",
      "Hardware, model, quant, runtime, backend, versions, flags, and cache mode are explicit.",
      "pp/tg measurements are sorted by context depth and match the raw run.",
      "The generated result file passes validate:data, tests, and build before PR."
    ]);
  });

  it("keeps checklist requirements represented in the copyable prompt", () => {
    for (const phrase of [
      "exact command",
      "backend",
      "flags",
      "cache mode",
      "quant segment must match the quant field exactly",
      "Sort measurements by ascending depth",
      "Verify every pp and tg value against the raw evidence",
      "npm run validate:data",
      "npm test",
      "npm run build"
    ]) {
      expect(contributionAgentPrompt).toContain(phrase);
    }
  });
});
