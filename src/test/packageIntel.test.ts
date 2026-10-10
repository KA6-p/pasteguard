import { test } from "node:test";
import assert from "node:assert/strict";
import type { PackageCandidate } from "../extractor";
import { MemoryCache } from "../cache";
import { PackageIntelligence } from "../packageIntel";
import type { PyPILookup } from "../pypiClient";

const NOW = Date.parse("2026-10-10T00:00:00Z");
const DAY = 86_400_000;
const POPULAR = ["requests", "flask", "numpy", "pandas", "flask-cors"];

function cand(
  name: string,
  over: Partial<PackageCandidate> = {},
): PackageCandidate {
  return {
    origin: "import",
    name,
    distribution: name,
    normalized: name.toLowerCase().replace(/[-_.]+/g, "-"),
    mappingConfidence: "assumed",
    span: { line: 0, startCharacter: 0, endCharacter: name.length },
    ...over,
  };
}

function found(daysAgo: number, o: { releases?: number; repo?: boolean; yanked?: boolean } = {}): PyPILookup {
  const first = new Date(NOW - daysAgo * DAY).toISOString();
  return {
    status: "found",
    facts: {
      name: "x",
      latestVersion: "1.0",
      firstReleaseTime: first,
      lastReleaseTime: first,
      releaseCount: o.releases ?? 5,
      repoUrls: o.repo === false ? [] : ["https://github.com/a/b"],
      hasRepoUrl: o.repo !== false,
      allYanked: o.yanked ?? false,
    },
  };
}

/** A fake registry plus a call log. */
function setup(table: Record<string, PyPILookup>, now = { t: NOW }) {
  const calls: string[] = [];
  const cache = new MemoryCache();
  const intel = new PackageIntelligence({
    client: async (n) => {
      calls.push(n);
      return table[n] ?? { status: "not-found" };
    },
    cache,
    now: () => now.t,
    popular: POPULAR,
  });
  return { intel, calls, cache, now };
}

const codes = (v: { signals: { code: string }[] }) => v.signals.map((s) => s.code);

test("a popular, established package is ok", async () => {
  const { intel } = setup({ requests: found(4000) });
  const v = await intel.assess(cand("requests", { mappingConfidence: "known" }));
  assert.equal(v.action, "ok");
  assert.equal(v.severity, "info");
  assert.equal(v.existence, "found");
  assert.equal(v.freshness, "established");
  assert.ok(codes(v).includes("popular-package"));
});

test("not found + explicit pip install -> do-not-install (high), with suggestions", async () => {
  const { intel } = setup({});
  const v = await intel.assess(cand("flask-gpt-helper", { origin: "pip-install", mappingConfidence: "explicit" }));
  assert.equal(v.existence, "not-found");
  assert.equal(v.action, "do-not-install");
  assert.equal(v.severity, "high");
  assert.deepEqual(v.suggestions, ["flask"]);
  assert.ok(codes(v).includes("not-found"));
});

test("not found + assumed import name -> unverified (warning), never 'do-not-install'", async () => {
  const { intel } = setup({});
  const v = await intel.assess(cand("flask_gpt_helper"));
  assert.equal(v.existence, "not-found");
  assert.equal(v.action, "unverified");
  assert.equal(v.severity, "warning");
  assert.ok(codes(v).includes("not-found-assumed-name"));
  assert.deepEqual(v.suggestions, ["flask"]);
});

test("not found + known mapping -> do-not-install", async () => {
  const { intel } = setup({});
  const v = await intel.assess(cand("cv2", { distribution: "opencv-python", normalized: "opencv-python", mappingConfidence: "known" }));
  assert.equal(v.action, "do-not-install");
});

test("very new package -> review", async () => {
  const { intel } = setup({ "shiny-helper": found(2) });
  const v = await intel.assess(cand("shiny-helper"));
  assert.equal(v.freshness, "very-new");
  assert.equal(v.action, "review");
  assert.equal(v.severity, "warning");
  assert.ok(codes(v).includes("very-new"));
});

test("new + strong typo-lookalike -> do-not-install", async () => {
  const { intel } = setup({ reqeusts: found(10) });
  const v = await intel.assess(cand("reqeusts"));
  assert.equal(v.freshness, "new");
  assert.equal(v.lookalike, "strong");
  assert.equal(v.action, "do-not-install");
  assert.equal(v.severity, "high");
  assert.deepEqual(v.lookalikes, ["requests"]);
});

test("old, well-documented lookalike stays ok (lookalike alone is only a signal)", async () => {
  const { intel } = setup({ request: found(3000, { releases: 20 }) });
  const v = await intel.assess(cand("request"));
  assert.equal(v.lookalike, "strong");
  assert.equal(v.action, "ok");
  assert.ok(codes(v).includes("lookalike-strong"));
});

test("lookalike + no repository link -> review", async () => {
  const { intel } = setup({ "numpyy": found(900, { repo: false, releases: 12 }) });
  const v = await intel.assess(cand("numpyy"));
  assert.equal(v.lookalike, "strong");
  assert.equal(v.repository, "missing");
  assert.equal(v.action, "review");
});

test("new + single release -> review; established + single release + repo -> ok", async () => {
  const a = await setup({ "tiny-lib": found(15, { releases: 1 }) }).intel.assess(cand("tiny-lib"));
  assert.equal(a.action, "review");
  const b = await setup({ "tiny-lib": found(900, { releases: 1 }) }).intel.assess(cand("tiny-lib"));
  assert.equal(b.action, "ok");
});

test("a project with no releases -> review", async () => {
  const { intel } = setup({ "placeholder-name": found(400, { releases: 0 }) });
  const v = await intel.assess(cand("placeholder-name"));
  assert.equal(v.action, "review");
  assert.ok(codes(v).includes("no-releases"));
});

test("everything yanked -> review", async () => {
  const { intel } = setup({ "gone-pkg": found(400, { yanked: true }) });
  const v = await intel.assess(cand("gone-pkg"));
  assert.equal(v.action, "review");
  assert.ok(codes(v).includes("all-yanked"));
});

test("namespace packages are not looked up and never called missing", async () => {
  const { intel, calls } = setup({});
  const v = await intel.assess(cand("google", { mappingConfidence: "ambiguous" }));
  assert.equal(v.existence, "not-checked");
  assert.equal(v.action, "unverified");
  assert.equal(v.severity, "info");
  assert.deepEqual(calls, []);
});

test("local project modules are skipped without a lookup", async () => {
  const { intel, calls } = setup({});
  const v = await intel.assess(cand("utils"), { isLocalModule: (n) => n === "utils" });
  assert.equal(v.action, "ok");
  assert.ok(codes(v).includes("local-module"));
  assert.deepEqual(calls, []);
});

test("local-module shortcut does not apply to explicit pip installs", async () => {
  const { intel, calls } = setup({});
  const v = await intel.assess(cand("utils", { origin: "pip-install", mappingConfidence: "explicit" }), { isLocalModule: () => true });
  assert.equal(v.existence, "not-found");
  assert.deepEqual(calls, ["utils"]);
});

test("registry unavailable -> unverified (info), no exception", async () => {
  const intel = new PackageIntelligence({
    client: async () => ({ status: "unavailable", reason: "timeout" }),
    now: () => NOW,
    popular: POPULAR,
  });
  const v = await intel.assess(cand("whatever"));
  assert.equal(v.existence, "unavailable");
  assert.equal(v.action, "unverified");
  assert.equal(v.severity, "info");
  assert.ok(codes(v).includes("registry-unavailable"));
});

test("results are cached: found for 24h, then refetched", async () => {
  const { intel, calls, now } = setup({ "some-lib": found(900) });
  await intel.assess(cand("some-lib"));
  await intel.assess(cand("some-lib"));
  assert.equal(calls.length, 1);
  const second = await intel.assess(cand("some-lib"));
  assert.equal(second.fromCache, true);
  now.t += 23 * 3_600_000;
  await intel.assess(cand("some-lib"));
  assert.equal(calls.length, 1);
  now.t += 2 * 3_600_000; // 25h total
  await intel.assess(cand("some-lib"));
  assert.equal(calls.length, 2);
});

test("'not found' is cached only for 1 hour (a name can be registered later)", async () => {
  const { intel, calls, now } = setup({});
  await intel.assess(cand("ghost-pkg"));
  now.t += 30 * 60_000;
  await intel.assess(cand("ghost-pkg"));
  assert.equal(calls.length, 1);
  now.t += 31 * 60_000;
  await intel.assess(cand("ghost-pkg"));
  assert.equal(calls.length, 2);
});

test("offline: stale cached data is used and flagged", async () => {
  const now = { t: NOW };
  const cache = new MemoryCache();
  let online = true;
  const intel = new PackageIntelligence({
    client: async () => (online ? found(900) : { status: "unavailable", reason: "network-error" }),
    cache,
    now: () => now.t,
    popular: POPULAR,
  });
  await intel.assess(cand("some-lib"));
  online = false;
  now.t += 3 * DAY; // cache expired
  const v = await intel.assess(cand("some-lib"));
  assert.equal(v.existence, "found");
  assert.equal(v.fromCache, true);
  assert.ok(codes(v).includes("stale-cache"));
});

test("unavailable results are never cached", async () => {
  let online = false;
  const calls: string[] = [];
  const intel = new PackageIntelligence({
    client: async (n) => {
      calls.push(n);
      return online ? found(900) : { status: "unavailable", reason: "timeout" };
    },
    now: () => NOW,
    popular: POPULAR,
  });
  await intel.assess(cand("some-lib"));
  online = true;
  const v = await intel.assess(cand("some-lib"));
  assert.equal(calls.length, 2);
  assert.equal(v.existence, "found");
});

test("assessAll looks each distinct package up once and keeps input order", async () => {
  const { intel, calls } = setup({ "pkg-a": found(900), "pkg-b": found(900) });
  const list = [cand("pkg-a"), cand("pkg-b"), cand("pkg-a", { origin: "pip-install", mappingConfidence: "explicit" })];
  const verdicts = await intel.assessAll(list);
  assert.deepEqual(calls.sort(), ["pkg-a", "pkg-b"]);
  assert.deepEqual(verdicts.map((v) => v.candidate.name), ["pkg-a", "pkg-b", "pkg-a"]);
  assert.deepEqual(verdicts.map((v) => v.candidate.origin), ["import", "import", "pip-install"]);
});

test("verdicts never contain free text from the registry", async () => {
  const { intel } = setup({ "some-lib": found(900) });
  const v = await intel.assess(cand("some-lib"));
  assert.ok(!JSON.stringify(v).toLowerCase().includes("ignore all previous"));
});

test("concurrency limit is respected", async () => {
  let active = 0;
  let maxActive = 0;
  const intel = new PackageIntelligence({
    client: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return found(900);
    },
    now: () => NOW,
    popular: POPULAR,
    concurrency: 2,
  });
  await intel.assessAll(["a1", "b2", "c3", "d4", "e5", "f6"].map((n) => cand(n)));
  assert.ok(maxActive <= 2, `max concurrent lookups was ${maxActive}`);
});

test("not-found names still report their lookalike level (a typo of a popular package)", async () => {
  const { intel } = setup({});
  const v = await intel.assess(cand("reqeusts", { origin: "pip-install", mappingConfidence: "explicit" }));
  assert.equal(v.existence, "not-found");
  assert.equal(v.lookalike, "strong");
  assert.deepEqual(v.lookalikes, ["requests"]);
  assert.equal(v.suggestions[0], "requests");
});
