import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPopularIndex, damerauLevenshtein, findLookalikes, lookalikeLevel, suggestPackages } from "../lookalike";

const index = buildPopularIndex(["requests", "numpy", "flask", "flask-cors", "pandas", "python-dateutil", "six", "boto3", "beautifulsoup4"]);

test("damerauLevenshtein basics", () => {
  assert.equal(damerauLevenshtein("abc", "abc"), 0);
  assert.equal(damerauLevenshtein("", "abc"), 3);
  assert.equal(damerauLevenshtein("kitten", "sitting"), 3);
  assert.equal(damerauLevenshtein("requests", "reqeusts"), 1); // adjacent swap counts as one edit
  assert.equal(damerauLevenshtein("requests", "request"), 1);
});

test("a one-edit typo of a popular package is a strong lookalike", () => {
  const m = findLookalikes("reqeusts", index);
  assert.deepEqual(m.map((x) => x.name), ["requests"]);
  assert.equal(lookalikeLevel(m), "strong");
});

test("the popular package itself is not its own lookalike", () => {
  assert.deepEqual(findLookalikes("requests", index), []);
  assert.equal(lookalikeLevel([]), "none");
});

test("popular name plus extra words is a possible (combo) lookalike", () => {
  const m = findLookalikes("flask-gpt-helper", index);
  assert.deepEqual(m.map((x) => [x.name, x.kind]), [["flask", "combo"]]);
  assert.equal(lookalikeLevel(m), "possible");
});

test("multi-token popular names match as whole token sequences", () => {
  const m = findLookalikes("my-python-dateutil-fork", index);
  assert.ok(m.some((x) => x.name === "python-dateutil"));
});

test("short names are not typo-matched (too many false positives)", () => {
  assert.deepEqual(findLookalikes("sx", index), []);
  assert.deepEqual(findLookalikes("sixx", index), []);
});

test("unrelated names have no lookalikes", () => {
  assert.deepEqual(findLookalikes("totally-unrelated-thing", index), []);
});

test("two-edit typos only count for long names", () => {
  // beautifulsoup4 -> beautifulsopu44 style: long enough for distance 2
  const m = findLookalikes("beautifulsoup5x", index);
  assert.ok(m.some((x) => x.name === "beautifulsoup4"));
  assert.equal(lookalikeLevel(m), "possible");
});

test("suggestPackages: token match for a made-up helper name", () => {
  assert.deepEqual(suggestPackages("flask-gpt-helper", index), ["flask"]);
});

test("suggestPackages: typo fixes come first", () => {
  const s = suggestPackages("reqeusts", index);
  assert.equal(s[0], "requests");
});

test("suggestPackages: respects the limit and returns nothing for unrelated names", () => {
  assert.deepEqual(suggestPackages("zzzz-qqqq", index), []);
  const big = buildPopularIndex(["aaaa-x", "aaab-x", "aaac-x", "aaad-x", "aaae-x", "aaaf-x", "aaag-x"]);
  assert.ok(suggestPackages("aaaa-y", big, 3).length <= 3);
});
