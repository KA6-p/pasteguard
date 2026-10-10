import * as fs from "node:fs";
import * as path from "node:path";
import type { PyPILookup } from "./pypiClient";

/** Only definitive answers are cached. "unavailable" (network trouble) is never stored. */
export type CacheableLookup = Extract<PyPILookup, { status: "found" | "not-found" }>;

export interface CacheEntry {
  /** Epoch milliseconds when the registry was queried. */
  fetchedAt: number;
  result: CacheableLookup;
}

export interface LookupCache {
  get(key: string): Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): Promise<void>;
}

export class MemoryCache implements LookupCache {
  private readonly map = new Map<string, CacheEntry>();

  async get(key: string): Promise<CacheEntry | undefined> {
    return this.map.get(key);
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    this.map.set(key, entry);
  }
}

function isValidEntry(v: unknown): v is CacheEntry {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const e = v as { fetchedAt?: unknown; result?: { status?: unknown; facts?: unknown } };
  if (typeof e.fetchedAt !== "number" || !Number.isFinite(e.fetchedAt) || !e.result) {
    return false;
  }
  if (e.result.status === "not-found") {
    return true;
  }
  if (e.result.status === "found") {
    const f = e.result.facts as { releaseCount?: unknown; name?: unknown; hasRepoUrl?: unknown; allYanked?: unknown } | undefined;
    return (
      !!f &&
      typeof f.name === "string" &&
      typeof f.releaseCount === "number" &&
      typeof f.hasRepoUrl === "boolean" &&
      typeof f.allYanked === "boolean"
    );
  }
  return false;
}

export interface DiskCacheOptions {
  maxEntries?: number;
  flushDelayMs?: number;
}

/** A small JSON-file cache. Loaded lazily, written in the background, and tolerant of a corrupt file. */
export class DiskCache implements LookupCache {
  private map: Map<string, CacheEntry> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;
  private readonly maxEntries: number;
  private readonly flushDelayMs: number;

  constructor(private readonly filePath: string, opts: DiskCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 5000;
    this.flushDelayMs = opts.flushDelayMs ?? 2000;
  }

  private async load(): Promise<Map<string, CacheEntry>> {
    if (this.map) {
      return this.map;
    }
    const map = new Map<string, CacheEntry>();
    try {
      const parsed: unknown = JSON.parse(await fs.promises.readFile(this.filePath, "utf8"));
      if (typeof parsed === "object" && parsed !== null) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (isValidEntry(v)) {
            map.set(k, v);
          }
        }
      }
    } catch {
      // Missing or corrupt file: start empty.
    }
    this.map = map;
    return map;
  }

  async get(key: string): Promise<CacheEntry | undefined> {
    return (await this.load()).get(key);
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    const map = await this.load();
    map.set(key, entry);
    if (map.size > this.maxEntries) {
      const oldest = [...map.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
      for (const [k] of oldest.slice(0, map.size - this.maxEntries)) {
        map.delete(k);
      }
    }
    this.dirty = true;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.flushDelayMs);
    this.timer.unref?.();
  }

  /** Write pending changes now. Safe to call repeatedly. */
  async flush(): Promise<void> {
    if (!this.dirty || !this.map) {
      return;
    }
    this.dirty = false;
    const tmp = `${this.filePath}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.promises.writeFile(tmp, JSON.stringify(Object.fromEntries(this.map)), "utf8");
      await fs.promises.rename(tmp, this.filePath);
    } catch {
      this.dirty = true; // try again on the next change
    }
  }

  async dispose(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.flush();
  }
}
