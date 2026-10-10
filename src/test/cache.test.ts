import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CacheEntry, DiskCache } from "../cache";

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pasteguard-cache-"));
  return path.join(dir, "nested", "pypi-cache.json");
}

const notFound = (t: number): CacheEntry => ({ fetchedAt: t, result: { status: "not-found" } });
const foundEntry = (t: number): CacheEntry => ({
  fetchedAt: t,
  result: {
    status: "found",
    facts: { name: "x", latestVersion: "1", releaseCount: 2, repoUrls: [], hasRepoUrl: false, allYanked: false },
  },
});

test("entries survive a flush and reload", async () => {
  const file = tmpFile();
  const a = new DiskCache(file, { flushDelayMs: 10_000 });
  await a.set("ghost", notFound(100));
  await a.set("real", foundEntry(200));
  await a.dispose();

  const b = new DiskCache(file);
  assert.deepEqual(await b.get("ghost"), notFound(100));
  assert.deepEqual(await b.get("real"), foundEntry(200));
  assert.equal(await b.get("missing"), undefined);
});

test("a corrupt cache file is ignored, not fatal", async () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ this is not json");
  const c = new DiskCache(file);
  assert.equal(await c.get("anything"), undefined);
  await c.set("k", notFound(1));
  await c.dispose();
  assert.deepEqual(await new DiskCache(file).get("k"), notFound(1));
});

test("malformed entries inside a valid file are dropped", async () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      good: notFound(5),
      bad1: { fetchedAt: "yesterday", result: { status: "not-found" } },
      bad2: { fetchedAt: 1, result: { status: "found", facts: { name: 3 } } },
      bad3: 42,
    }),
  );
  const c = new DiskCache(file);
  assert.deepEqual(await c.get("good"), notFound(5));
  assert.equal(await c.get("bad1"), undefined);
  assert.equal(await c.get("bad2"), undefined);
  assert.equal(await c.get("bad3"), undefined);
});

test("the oldest entries are evicted past maxEntries", async () => {
  const c = new DiskCache(tmpFile(), { maxEntries: 2, flushDelayMs: 10_000 });
  await c.set("old", notFound(1));
  await c.set("mid", notFound(2));
  await c.set("new", notFound(3));
  assert.equal(await c.get("old"), undefined);
  assert.ok(await c.get("mid"));
  assert.ok(await c.get("new"));
  await c.dispose();
});
