import type { PackageCandidate } from "./extractor";
import { CacheableLookup, LookupCache, MemoryCache } from "./cache";
import { buildPopularIndex, findLookalikes, lookalikeLevel, LookalikeLevel, PopularIndex, suggestPackages } from "./lookalike";
import { POPULAR_PACKAGES } from "./popularPackages";
import { lookupProject, ProjectFacts, PyPILookup } from "./pypiClient";

/**
 * Module 3: package intelligence.
 *
 * Produces an evidence-based verdict per package. There is deliberately NO single "trust score":
 * each dimension is reported separately, so "unpopular" is never confused with "malicious".
 * The verdict never claims a package is malicious. The strongest wording is "do-not-install until verified".
 *
 * Decision rules (also covered by tests):
 *  - Not on PyPI + the name came from a pip install command or a known mapping -> do-not-install (high)
 *  - Not on PyPI + the name is only an assumed import name                     -> unverified (warning)
 *    (it may be the user's own module, or a package whose install name differs, or a hallucination)
 *  - Found, strong typo-lookalike AND brand new (< 30 days)                    -> do-not-install (high)
 *  - Found, and any of: very new (< 7 days), no releases, everything yanked,
 *    new + (single release or no repo link), lookalike + (single release or no repo link) -> review (warning)
 *  - Found and none of the above (or a well-known popular package)             -> ok
 *  - Registry unreachable                                                      -> unverified (info); stale cache is used if present
 */

export type Existence = "found" | "not-found" | "unavailable" | "not-checked";
export type Freshness = "established" | "new" | "very-new" | "unknown";
export type RepositoryStatus = "present" | "missing" | "unknown";
export type Action = "ok" | "review" | "unverified" | "do-not-install";
export type Severity = "info" | "warning" | "high";

export type SignalCode =
  | "not-found"
  | "not-found-assumed-name"
  | "registry-unavailable"
  | "stale-cache"
  | "namespace-package"
  | "local-module"
  | "popular-package"
  | "very-new"
  | "new"
  | "no-releases"
  | "single-release"
  | "no-repo-url"
  | "all-yanked"
  | "lookalike-strong"
  | "lookalike-possible";

export interface Signal {
  code: SignalCode;
  detail?: string;
}

export interface PackageVerdict {
  candidate: PackageCandidate;
  existence: Existence;
  freshness: Freshness;
  repository: RepositoryStatus;
  lookalike: LookalikeLevel;
  /** Popular packages this name resembles. */
  lookalikes: string[];
  /** "Did you mean" names for packages that were not found. Never installed or applied automatically. */
  suggestions: string[];
  action: Action;
  severity: Severity;
  signals: Signal[];
  facts?: {
    firstRelease?: string;
    lastRelease?: string;
    releaseCount: number;
    ageDays?: number;
  };
  /** ISO time the registry data was fetched. */
  checkedAt: string;
  fromCache: boolean;
}

export interface AssessContext {
  /** True if an assumed import name is actually a module in the user's own project. */
  isLocalModule?: (importName: string) => boolean;
}

export interface PackageIntelOptions {
  client?: (normalizedName: string) => Promise<PyPILookup>;
  cache?: LookupCache;
  now?: () => number;
  popular?: readonly string[];
  foundTtlMs?: number;
  notFoundTtlMs?: number;
  veryNewDays?: number;
  newDays?: number;
  concurrency?: number;
}

const DAY_MS = 86_400_000;

interface Resolved {
  lookup: PyPILookup;
  fromCache: boolean;
  stale: boolean;
  fetchedAt: number;
}

export class PackageIntelligence {
  private readonly client: (n: string) => Promise<PyPILookup>;
  private readonly cache: LookupCache;
  private readonly now: () => number;
  private readonly popular: PopularIndex;
  private readonly foundTtl: number;
  private readonly notFoundTtl: number;
  private readonly veryNewDays: number;
  private readonly newDays: number;
  private readonly concurrency: number;
  private readonly inflight = new Map<string, Promise<Resolved>>();

  constructor(opts: PackageIntelOptions = {}) {
    this.client = opts.client ?? ((n) => lookupProject(n));
    this.cache = opts.cache ?? new MemoryCache();
    this.now = opts.now ?? Date.now;
    this.popular = buildPopularIndex(opts.popular ?? POPULAR_PACKAGES);
    this.foundTtl = opts.foundTtlMs ?? DAY_MS;
    // Short on purpose: an attacker can register a missing name later, so "not found" must not stick around.
    this.notFoundTtl = opts.notFoundTtlMs ?? 60 * 60 * 1000;
    this.veryNewDays = opts.veryNewDays ?? 7;
    this.newDays = opts.newDays ?? 30;
    this.concurrency = Math.max(1, opts.concurrency ?? 4);
  }

  async assess(candidate: PackageCandidate, ctx: AssessContext = {}): Promise<PackageVerdict> {
    return (await this.assessAll([candidate], ctx))[0];
  }

  /** Assess many candidates, looking each distinct package up once. Results keep the input order. */
  async assessAll(candidates: readonly PackageCandidate[], ctx: AssessContext = {}): Promise<PackageVerdict[]> {
    const pre = candidates.map((c) => this.precheck(c, ctx));
    const toLookUp = [...new Set(candidates.filter((_, i) => !pre[i]).map((c) => c.normalized))];

    const resolved = new Map<string, Resolved>();
    const queue = [...toLookUp];
    const workers = Array.from({ length: Math.min(this.concurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const name = queue.shift() as string;
        resolved.set(name, await this.resolve(name));
      }
    });
    await Promise.all(workers);

    return candidates.map((c, i) => pre[i] ?? this.buildVerdict(c, resolved.get(c.normalized) as Resolved));
  }

  // ---- lookups -------------------------------------------------------------------------------

  private resolve(normalized: string): Promise<Resolved> {
    const existing = this.inflight.get(normalized);
    if (existing) {
      return existing;
    }
    const p = this.resolveUncached(normalized).finally(() => this.inflight.delete(normalized));
    this.inflight.set(normalized, p);
    return p;
  }

  private async resolveUncached(normalized: string): Promise<Resolved> {
    let entry;
    try {
      entry = await this.cache.get(normalized);
    } catch {
      entry = undefined;
    }
    const now = this.now();
    if (entry) {
      const age = now - entry.fetchedAt;
      const ttl = entry.result.status === "found" ? this.foundTtl : this.notFoundTtl;
      if (age >= 0 && age < ttl) {
        return { lookup: entry.result, fromCache: true, stale: false, fetchedAt: entry.fetchedAt };
      }
    }

    const fresh = await this.client(normalized);
    if (fresh.status === "found" || fresh.status === "not-found") {
      try {
        await this.cache.set(normalized, { fetchedAt: now, result: fresh as CacheableLookup });
      } catch {
        // A cache write failure must never break a check.
      }
      return { lookup: fresh, fromCache: false, stale: false, fetchedAt: now };
    }
    if (entry) {
      return { lookup: entry.result, fromCache: true, stale: true, fetchedAt: entry.fetchedAt };
    }
    return { lookup: fresh, fromCache: false, stale: false, fetchedAt: now };
  }

  // ---- verdicts ------------------------------------------------------------------------------

  /** Candidates that need no registry lookup at all. */
  private precheck(c: PackageCandidate, ctx: AssessContext): PackageVerdict | undefined {
    if (c.origin === "import" && c.mappingConfidence === "ambiguous") {
      return this.simple(c, "not-checked", "unverified", "info", [
        { code: "namespace-package", detail: "one import root covers many PyPI packages" },
      ]);
    }
    if (c.origin === "import" && c.mappingConfidence === "assumed" && ctx.isLocalModule?.(c.name)) {
      return this.simple(c, "not-checked", "ok", "info", [{ code: "local-module" }]);
    }
    return undefined;
  }

  private simple(c: PackageCandidate, existence: Existence, action: Action, severity: Severity, signals: Signal[]): PackageVerdict {
    return {
      candidate: c,
      existence,
      freshness: "unknown",
      repository: "unknown",
      lookalike: "none",
      lookalikes: [],
      suggestions: [],
      action,
      severity,
      signals,
      checkedAt: new Date(this.now()).toISOString(),
      fromCache: false,
    };
  }

  private buildVerdict(c: PackageCandidate, r: Resolved): PackageVerdict {
    const base = this.simple(c, "unavailable", "unverified", "info", []);
    base.fromCache = r.fromCache;
    base.checkedAt = new Date(r.fetchedAt).toISOString();
    if (r.stale) {
      base.signals.push({ code: "stale-cache", detail: "registry unreachable, using older saved data" });
    }

    const { lookup } = r;
    if (lookup.status === "unavailable") {
      base.signals.push({ code: "registry-unavailable", detail: lookup.reason });
      return base;
    }
    if (lookup.status === "not-found") {
      return this.notFound(base, c);
    }
    return this.found(base, c, lookup.facts);
  }

  private notFound(v: PackageVerdict, c: PackageCandidate): PackageVerdict {
    v.existence = "not-found";
    v.suggestions = suggestPackages(c.normalized, this.popular);
    const matches = findLookalikes(c.normalized, this.popular);
    v.lookalikes = matches.map((m) => m.name);
    v.lookalike = lookalikeLevel(matches);
    if (c.mappingConfidence === "assumed") {
      // The import name is only a guess at the install name, so a miss means "unverified".
      v.action = "unverified";
      v.severity = "warning";
      v.signals.push({ code: "not-found-assumed-name", detail: "no PyPI project has this name" });
    } else {
      v.action = "do-not-install";
      v.severity = "high";
      v.signals.push({ code: "not-found", detail: "no PyPI project has this name" });
    }
    return v;
  }

  private found(v: PackageVerdict, c: PackageCandidate, facts: ProjectFacts): PackageVerdict {
    v.existence = "found";
    v.repository = facts.hasRepoUrl ? "present" : "missing";

    const ageDays = facts.firstReleaseTime
      ? Math.max(0, Math.floor((this.now() - Date.parse(facts.firstReleaseTime)) / DAY_MS))
      : undefined;
    v.facts = {
      firstRelease: facts.firstReleaseTime,
      lastRelease: facts.lastReleaseTime,
      releaseCount: facts.releaseCount,
      ageDays,
    };
    v.freshness =
      ageDays === undefined ? "unknown" : ageDays < this.veryNewDays ? "very-new" : ageDays < this.newDays ? "new" : "established";

    // A well-known package is trusted as itself; we only look for impostors of it.
    if (this.popular.set.has(c.normalized)) {
      v.signals.push({ code: "popular-package" });
      v.action = "ok";
      v.severity = "info";
      return v;
    }

    const matches = findLookalikes(c.normalized, this.popular);
    v.lookalikes = matches.map((m) => m.name);
    v.lookalike = lookalikeLevel(matches);

    const veryNew = v.freshness === "very-new";
    const isNew = v.freshness === "new";
    const single = facts.releaseCount === 1;
    const noRepo = !facts.hasRepoUrl;
    const noReleases = facts.releaseCount === 0;

    if (veryNew) {
      v.signals.push({ code: "very-new", detail: `first release ${ageDays} day(s) ago` });
    } else if (isNew) {
      v.signals.push({ code: "new", detail: `first release ${ageDays} day(s) ago` });
    }
    if (noReleases) {
      v.signals.push({ code: "no-releases" });
    }
    if (single) {
      v.signals.push({ code: "single-release" });
    }
    if (noRepo) {
      v.signals.push({ code: "no-repo-url" });
    }
    if (facts.allYanked) {
      v.signals.push({ code: "all-yanked" });
    }
    if (v.lookalike === "strong") {
      v.signals.push({ code: "lookalike-strong", detail: v.lookalikes.slice(0, 3).join(", ") });
    } else if (v.lookalike === "possible") {
      v.signals.push({ code: "lookalike-possible", detail: v.lookalikes.slice(0, 3).join(", ") });
    }

    const weakProvenance = single || noRepo;
    if (v.lookalike === "strong" && (veryNew || isNew)) {
      v.action = "do-not-install";
      v.severity = "high";
    } else if (
      veryNew ||
      noReleases ||
      facts.allYanked ||
      (isNew && weakProvenance) ||
      (v.lookalike !== "none" && weakProvenance)
    ) {
      v.action = "review";
      v.severity = "warning";
    } else {
      v.action = "ok";
      v.severity = "info";
    }
    return v;
  }
}
