import type { PackageVerdict } from "./packageIntel";

/** One readable log line per verdict. (Module 6 will turn verdicts into explanations; this is for debugging.) */
export function formatVerdictLine(v: PackageVerdict): string {
  const c = v.candidate;
  const age = v.facts?.ageDays !== undefined ? ` (${v.facts.ageDays}d)` : "";
  const parts = [
    `exists: ${v.existence}`,
    `age: ${v.freshness}${age}`,
    `repo: ${v.repository}`,
    `lookalike: ${v.lookalike}`,
  ];
  if (v.fromCache) {
    parts.push("cached");
  }
  let line = `  [verdict] ${c.origin} ${c.name}: ${v.action.toUpperCase()} (${v.severity}) | ${parts.join(", ")}`;
  if (v.signals.length > 0) {
    line += ` | signals: ${v.signals.map((s) => s.code).join(", ")}`;
  }
  if (v.suggestions.length > 0) {
    line += ` | did you mean: ${v.suggestions.join(", ")} (not installed automatically)`;
  }
  return line;
}
