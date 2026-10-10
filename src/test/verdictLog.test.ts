import { test } from "node:test";
import assert from "node:assert/strict";
import { formatVerdictLine } from "../verdictLog";
import type { PackageVerdict } from "../packageIntel";

test("formatVerdictLine summarizes a not-found verdict with suggestions", () => {
  const v = {
    candidate: { origin: "import", name: "flask_gpt_helper" },
    existence: "not-found",
    freshness: "unknown",
    repository: "unknown",
    lookalike: "possible",
    lookalikes: ["flask"],
    suggestions: ["flask"],
    action: "unverified",
    severity: "warning",
    signals: [{ code: "not-found-assumed-name" }],
    fromCache: true,
  } as unknown as PackageVerdict;
  const line = formatVerdictLine(v);
  assert.match(line, /import flask_gpt_helper: UNVERIFIED \(warning\)/);
  assert.match(line, /exists: not-found/);
  assert.match(line, /cached/);
  assert.match(line, /signals: not-found-assumed-name/);
  assert.match(line, /did you mean: flask \(not installed automatically\)/);
});
