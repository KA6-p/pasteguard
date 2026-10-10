/**
 * Minimal PyPI client. Only the package NAME is ever sent to the registry, never any source code.
 *
 * Everything that comes back is untrusted input: we parse it defensively and keep only a few
 * structured facts. Free-text fields (summary, description) are deliberately dropped so they can
 * never reach a UI string or an LLM prompt through this module.
 */

export interface ProjectFacts {
  name: string;
  latestVersion: string;
  /** ISO timestamp of the earliest uploaded file across all releases. */
  firstReleaseTime?: string;
  lastReleaseTime?: string;
  /** Number of versions that have at least one uploaded file. */
  releaseCount: number;
  repoUrls: string[];
  /** True if a project URL points at a well-known code host. This does NOT prove the link is genuine. */
  hasRepoUrl: boolean;
  /** Every uploaded file has been yanked. */
  allYanked: boolean;
}

export type UnavailableReason = "timeout" | "network-error" | "bad-response" | "invalid-name" | `http-${number}`;

export type PyPILookup =
  | { status: "found"; facts: ProjectFacts }
  | { status: "not-found" }
  | { status: "unavailable"; reason: UnavailableReason };

export interface FetchResponseLike {
  status: number;
  json(): Promise<unknown>;
}
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<FetchResponseLike>;

export interface LookupOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  baseUrl?: string;
}

const USER_AGENT = "PasteGuard-VSCode-Extension (https://github.com/KA6-p/pasteguard)";
const VALID_NAME = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const CODE_HOSTS = /^(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|git\.sr\.ht|sr\.ht|sourceforge\.net|foss\.heptapod\.net)$/i;

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function isCodeHostUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return (url.protocol === "https:" || url.protocol === "http:") && CODE_HOSTS.test(url.hostname);
  } catch {
    return false;
  }
}

/** Turn a raw PyPI JSON document into our small facts object. Returns undefined if the shape is unusable. */
export function parseProject(json: unknown): ProjectFacts | undefined {
  const root = asRecord(json);
  const info = asRecord(root?.info);
  if (!root || !info) {
    return undefined;
  }
  const name = asString(info.name);
  if (!name) {
    return undefined;
  }

  const times: number[] = [];
  let releaseCount = 0;
  let totalFiles = 0;
  let yankedFiles = 0;

  const releases = asRecord(root.releases) ?? {};
  for (const files of Object.values(releases)) {
    if (!Array.isArray(files) || files.length === 0) {
      continue; // a version with no uploaded files (deleted or placeholder)
    }
    releaseCount++;
    for (const f of files) {
      const file = asRecord(f);
      if (!file) {
        continue;
      }
      totalFiles++;
      if (file.yanked === true) {
        yankedFiles++;
      }
      const t = asString(file.upload_time_iso_8601) ?? asString(file.upload_time);
      const ms = t ? Date.parse(t.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`) : NaN;
      if (Number.isFinite(ms)) {
        times.push(ms);
      }
    }
  }

  const urls = new Set<string>();
  const home = asString(info.home_page);
  if (home) {
    urls.add(home);
  }
  const projectUrls = asRecord(info.project_urls);
  if (projectUrls) {
    for (const v of Object.values(projectUrls)) {
      const s = asString(v);
      if (s) {
        urls.add(s);
      }
    }
  }
  const repoUrls = [...urls].filter(isCodeHostUrl);

  return {
    name,
    latestVersion: asString(info.version) ?? "",
    firstReleaseTime: times.length ? new Date(Math.min(...times)).toISOString() : undefined,
    lastReleaseTime: times.length ? new Date(Math.max(...times)).toISOString() : undefined,
    releaseCount,
    repoUrls,
    hasRepoUrl: repoUrls.length > 0,
    allYanked: totalFiles > 0 && yankedFiles === totalFiles,
  };
}

/** Look one project up on PyPI. `normalizedName` must already be PEP 503 normalized. Never throws. */
export async function lookupProject(normalizedName: string, opts: LookupOptions = {}): Promise<PyPILookup> {
  if (!VALID_NAME.test(normalizedName)) {
    return { status: "unavailable", reason: "invalid-name" };
  }
  const fetchImpl = opts.fetchImpl ?? ((globalThis as unknown as { fetch: FetchLike }).fetch);
  if (typeof fetchImpl !== "function") {
    return { status: "unavailable", reason: "network-error" };
  }
  const base = opts.baseUrl ?? "https://pypi.org";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 4000);

  try {
    const res = await fetchImpl(`${base}/pypi/${encodeURIComponent(normalizedName)}/json`, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    if (res.status === 404) {
      return { status: "not-found" };
    }
    if (res.status !== 200) {
      return { status: "unavailable", reason: `http-${res.status}` };
    }
    const facts = parseProject(await res.json());
    return facts ? { status: "found", facts } : { status: "unavailable", reason: "bad-response" };
  } catch (err) {
    const aborted = controller.signal.aborted || (err as { name?: string })?.name === "AbortError";
    return { status: "unavailable", reason: aborted ? "timeout" : "network-error" };
  } finally {
    clearTimeout(timer);
  }
}
