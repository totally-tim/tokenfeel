export const contributionVerificationChecks = [
  "Raw benchmark command and unedited output are attached or linked.",
  "Hardware, model, quant, runtime, backend, versions, flags, and cache mode are explicit.",
  "pp/tg measurements are sorted by context depth and match the raw run.",
  "The generated result file passes validate:data, tests, and build before PR."
] as const;

export const contributionAgentPrompt = `You are contributing a local inference benchmark result to Tokenfeel.

Goal: produce one verifiable benchmark result file and, if you have repository access, a pull request.

Rules:
- Do not invent, infer, smooth, or backfill benchmark numbers.
- Use only numbers present in raw output, machine-readable logs, or an upstream source URL.
- If evidence is missing or malformed, stop and report exactly what is missing.
- Keep one implementation path. Do not leave duplicate result files for the same hardware/model/quant/runtime.

Before running checks:
- Read CONTRIBUTING.md, src/data/schemas.ts, and one similar data/results/*.json file.
- If dependencies are not installed, run npm config set min-release-age=2d before npm ci.

Benchmark capture:
1. Run the local benchmark with llama-bench, llama-benchy, oMLX, vLLM, or another tool that reports prompt-processing and generation rates.
2. Save the exact command, tool version or commit, OS/runtime versions, backend, flags, cache mode, run count, warmup count, prompt-processing token size, generation token size, and every measured context depth.
3. Preserve the raw output unchanged as a PR artifact, public URL, or evidence.rawRows.

Result file:
- Create data/results/<hardware>__<model>__<quant>__<runtime>.json.
- The id must use the same hardware__model__quant__runtime shape, and the quant segment must match the quant field exactly.
- Include id, hardware, model, quant, runtime, measurements, source, submitter, date, and status: "community".
- Include evidence and benchmark metadata when you have raw logs, command details, token sizes, or run counts.
- Sort measurements by ascending depth.
- Verify every pp and tg value against the raw evidence before editing anything else.

Required local verification:
- npm run validate:data
- npm test
- npm run build

Final response or pull request body:
- Summarize hardware/model/quant/runtime.
- Link or attach raw benchmark evidence.
- Paste the exact benchmark command.
- Paste the three verification commands with pass/fail status.
- Call out any caveats, missing depth rows, failed checks, or assumptions.`;
