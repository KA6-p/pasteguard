/**
 * Lookalike detection: is this package name suspiciously close to a popular one?
 *
 * Two kinds of lookalike:
 *  - typo:  a small edit-distance away from a popular name (`reqeusts`, `requestss`)
 *  - combo: a popular name plus extra words (`requests-helper`, `flask-gpt-helper`)
 *
 * Being a lookalike is only a SIGNAL. Plenty of real packages are lookalikes (`boto`, every `flask-*`
 * plugin). Module 3 only escalates a lookalike when it is combined with weak provenance (brand new,
 * one release, no repository).
 *
 * Not covered yet: Unicode homoglyphs (PyPI normalizes names to ASCII, so this is rare) and
 * "dependency confusion" with private package names.
 */

export interface PopularIndex {
  names: readonly string[];
  set: ReadonlySet<string>;
  /** Lower rank = more popular. */
  rank: ReadonlyMap<string, number>;
}

export function buildPopularIndex(names: readonly string[]): PopularIndex {
  const rank = new Map<string, number>();
  names.forEach((n, i) => {
    if (!rank.has(n)) {
      rank.set(n, i);
    }
  });
  return { names, set: new Set(names), rank };
}

/** Optimal string alignment distance: insert, delete, substitute, or swap two adjacent characters (each costs 1). */
export function damerauLevenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const la = a.length;
  const lb = b.length;
  if (la === 0) {
    return lb;
  }
  if (lb === 0) {
    return la;
  }
  const d: number[][] = Array.from({ length: la + 1 }, () => new Array<number>(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) {
    d[i][0] = i;
  }
  for (let j = 0; j <= lb; j++) {
    d[0][j] = j;
  }
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[la][lb];
}

export type LookalikeKind = "typo" | "combo";

export interface LookalikeMatch {
  name: string;
  kind: LookalikeKind;
  distance: number;
}

export type LookalikeLevel = "none" | "possible" | "strong";

const MIN_TYPO_LENGTH = 5;
const MIN_COMBO_LENGTH = 4;

function containsAsTokens(candidate: string, popular: string): boolean {
  return `-${candidate}-`.includes(`-${popular}-`);
}

/** All popular names this candidate resembles. `candidate` must be PEP 503 normalized. */
export function findLookalikes(candidate: string, index: PopularIndex): LookalikeMatch[] {
  const matches: LookalikeMatch[] = [];
  for (const p of index.names) {
    if (p === candidate) {
      continue;
    }
    if (candidate.length >= MIN_TYPO_LENGTH && p.length >= MIN_TYPO_LENGTH && Math.abs(candidate.length - p.length) <= 2) {
      const dist = damerauLevenshtein(candidate, p);
      const limit = candidate.length >= 8 && p.length >= 8 ? 2 : 1;
      if (dist >= 1 && dist <= limit) {
        matches.push({ name: p, kind: "typo", distance: dist });
        continue;
      }
    }
    if (p.length >= MIN_COMBO_LENGTH && containsAsTokens(candidate, p)) {
      matches.push({ name: p, kind: "combo", distance: 0 });
    }
  }
  return matches.sort((x, y) => (index.rank.get(x.name) ?? 1e9) - (index.rank.get(y.name) ?? 1e9));
}

/**
 * strong   = one edit away from a popular name (classic typosquat)
 * possible = a weaker typo (two edits on long names) or a popular name plus extra words
 */
export function lookalikeLevel(matches: readonly LookalikeMatch[]): LookalikeLevel {
  if (matches.some((m) => m.kind === "typo" && m.distance === 1)) {
    return "strong";
  }
  return matches.length > 0 ? "possible" : "none";
}

/**
 * "Did you mean" candidates for a name that does not exist on PyPI.
 * These are suggestions for the user to consider. Nothing is ever installed or rewritten automatically.
 */
export function suggestPackages(candidate: string, index: PopularIndex, limit = 5): string[] {
  const rank = (n: string): number => index.rank.get(n) ?? 1e9;
  const typos: { name: string; dist: number }[] = [];
  const tokens: string[] = [];

  for (const p of index.names) {
    if (p === candidate) {
      continue;
    }
    if (p.length >= 4 && candidate.length >= 4 && Math.abs(p.length - candidate.length) <= 2) {
      const dist = damerauLevenshtein(candidate, p);
      if (dist >= 1 && dist <= 2) {
        typos.push({ name: p, dist });
        continue;
      }
    }
    if (p.length >= 3 && containsAsTokens(candidate, p)) {
      tokens.push(p);
    }
  }

  typos.sort((a, b) => a.dist - b.dist || rank(a.name) - rank(b.name));
  // Longer matches first (more specific), then more popular.
  tokens.sort((a, b) => b.length - a.length || rank(a) - rank(b));

  const out: string[] = [];
  for (const n of [...typos.map((t) => t.name), ...tokens]) {
    if (!out.includes(n)) {
      out.push(n);
    }
    if (out.length >= limit) {
      break;
    }
  }
  return out;
}
