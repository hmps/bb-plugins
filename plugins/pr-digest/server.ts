// bb-plugin-pr-digest — backend entry.
//
// Resolves the GitHub repos behind the user's bb projects, then fetches two
// lists per repo through the `gh` CLI and serves them over rpc:
//   - pull requests merged yesterday
//   - all open pull requests
//
// It also reports the release state of one Cloud Run service through the
// `gcloud` CLI: the commit that serves traffic, the revisions that are built
// but not live, and the commits on the default branch that are not released.
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const prSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  repo: z.string(),
  author: z.string(),
  /** mergedAt for merged PRs, createdAt for open ones (ISO). */
  at: z.string(),
  updatedAt: z.string(),
  isDraft: z.boolean(),
  reviewDecision: z.enum([
    "APPROVED",
    "CHANGES_REQUESTED",
    "REVIEW_REQUIRED",
    "",
  ]),
  reviewRequested: z.boolean(),
  labels: z.array(z.object({ name: z.string(), color: z.string() })),
  additions: z.number().int(),
  deletions: z.number().int(),
  branch: z.string(),
});

export type PullRequest = z.infer<typeof prSchema>;

const digestSchema = z.object({
  day: z.string(),
  viewer: z.string(),
  repos: z.array(z.string()),
  merged: z.array(prSchema),
  open: z.array(prSchema),
  errors: z.array(z.object({ repo: z.string(), message: z.string() })),
  fetchedAt: z.number(),
});

export type Digest = z.infer<typeof digestSchema>;

const commitStateSchema = z.enum(["built", "building", "failed", "pending"]);

export type CommitState = z.infer<typeof commitStateSchema>;

const releaseSchema = z.object({
  service: z.string(),
  project: z.string(),
  region: z.string(),
  repo: z.string(),
  live: z
    .object({
      revision: z.string(),
      sha: z.string().nullable(),
      shortSha: z.string().nullable(),
      message: z.string().nullable(),
      /** Revision creation timestamp (ISO). */
      deployedAt: z.string().nullable(),
      buildFinishedAt: z.string().nullable(),
      percent: z.number(),
    })
    .nullable(),
  /** Ready revisions newer than the live one, newest first. */
  waiting: z.array(
    z.object({
      revision: z.string(),
      sha: z.string().nullable(),
      shortSha: z.string().nullable(),
      createdAt: z.string(),
      ready: z.boolean(),
      /** First line of the head commit message, without a trailing (#N). */
      title: z.string().nullable(),
      /** Rest of the commit message, trimmed; null when empty. */
      body: z.string().nullable(),
      prNumber: z.number().int().nullable(),
      author: z.string().nullable(),
      /** Unreleased commits this revision carries (from live up to its head). */
      commitCount: z.number().int(),
    }),
  ),
  /** Builds for unreleased commits, newest first. */
  builds: z.array(
    z.object({
      id: z.string(),
      sha: z.string(),
      shortSha: z.string(),
      status: z.string(),
      startedAt: z.string().nullable(),
      finishedAt: z.string().nullable(),
      logUrl: z.string().nullable(),
    }),
  ),
  /** Commits on the default branch that are not live yet, newest first. */
  unreleased: z.array(
    z.object({
      sha: z.string(),
      shortSha: z.string(),
      message: z.string(),
      prNumber: z.number().int().nullable(),
      author: z.string(),
      date: z.string(),
      url: z.string(),
      state: commitStateSchema,
    }),
  ),
  aheadBy: z.number().int(),
  fetchedAt: z.number(),
  /** Partial failures. The rest of the payload still holds. */
  errors: z.array(z.string()),
});

export type Release = z.infer<typeof releaseSchema>;
export type ReleaseCommit = Release["unreleased"][number];
export type ReleaseBuild = Release["builds"][number];
export type ReleaseWaiting = Release["waiting"][number];

export const rpcContract = defineRpcContract({
  digest: {
    input: z.object({ force: z.boolean().optional() }).strict(),
    output: digestSchema,
  },
  release: {
    input: z.object({ force: z.boolean().optional() }).strict(),
    output: releaseSchema,
  },
});

const CACHE_KEY = "digest.v2";
const CACHE_TTL_MS = 5 * 60_000;
const GH_LIMIT = 50;
const RELEASE_CACHE_KEY = "release.v2";
const RELEASE_CACHE_TTL_MS = 2 * 60_000;
const RELEASE_COMMIT_LIMIT = 50;
const RUN_REVISION_LIMIT = 15;
const BUILD_LIMIT = 15;

/** Local calendar date of "yesterday" as YYYY-MM-DD. */
export function yesterday(now = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** `owner/name` for a GitHub remote URL, or null for anything else. */
export function parseGitHubRepo(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const m =
    /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Split a comma/space separated `owner/name` list. */
export function parseRepoList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^[^/\s]+\/[^/\s]+$/.test(s));
}

interface GhActor {
  login: string;
}

interface GhPrRow {
  number: number;
  title: string;
  url: string;
  author: GhActor | null;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string | null;
  isDraft: boolean;
  reviewDecision: string;
  reviewRequests?: Array<{ login?: string; name?: string; slug?: string }>;
  labels: Array<{ name: string; color: string }>;
  additions: number;
  deletions: number;
  headRefName: string;
}

const DECISIONS = new Set(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]);

function toPullRequest(
  row: GhPrRow,
  repo: string,
  viewer: string,
): PullRequest {
  const decision = DECISIONS.has(row.reviewDecision)
    ? (row.reviewDecision as PullRequest["reviewDecision"])
    : "";
  return {
    number: row.number,
    title: row.title,
    url: row.url,
    repo,
    author: row.author?.login ?? "unknown",
    at: row.mergedAt ?? row.createdAt,
    updatedAt: row.updatedAt,
    isDraft: row.isDraft,
    reviewDecision: decision,
    reviewRequested: (row.reviewRequests ?? []).some(
      (r) => r.login === viewer,
    ),
    labels: (row.labels ?? []).map((l) => ({ name: l.name, color: l.color })),
    additions: row.additions ?? 0,
    deletions: row.deletions ?? 0,
    branch: row.headRefName ?? "",
  };
}

function gh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      { maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * First executable named `name` on PATH. The Google Cloud SDK often installs
 * `/usr/local/bin/gcloud` as a *directory* that holds `bin/gcloud`, which makes
 * a plain `execFile("gcloud")` fail with EACCES, so check both shapes.
 */
function resolveBin(name: string): string {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const direct = join(dir, name);
    if (isExecutableFile(direct)) return direct;
    const nested = join(direct, "bin", name);
    if (isExecutableFile(nested)) return nested;
  }
  return name;
}

let gcloudBin: string | null = null;

function gcloud(args: string[]): Promise<string> {
  gcloudBin ??= resolveBin("gcloud");
  return new Promise((resolve, reject) => {
    execFile(
      gcloudBin as string,
      args,
      { maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

// ------------------------------------------------------------- release

interface RunTraffic {
  revisionName?: string;
  percent?: number;
  tag?: string;
}

interface RunService {
  status?: { traffic?: RunTraffic[] };
}

interface RunRevision {
  metadata?: {
    name?: string;
    creationTimestamp?: string;
  };
  status?: {
    conditions?: Array<{ type?: string; status?: string }>;
  };
}

interface CloudBuild {
  id?: string;
  status?: string;
  substitutions?: Record<string, string>;
  createTime?: string;
  startTime?: string;
  finishTime?: string;
  logUrl?: string;
}

interface CompareCommit {
  sha: string;
  html_url: string;
  author: { login?: string } | null;
  commit: {
    message: string;
    author?: { name?: string };
    committer?: { date?: string };
  };
}

interface CompareResult {
  ahead_by?: number;
  commits?: CompareCommit[];
}

const FAILED_BUILD = new Set(["FAILURE", "TIMEOUT", "CANCELLED", "EXPIRED"]);
const RUNNING_BUILD = new Set(["QUEUED", "WORKING", "PENDING"]);

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Cloud Build id inside a `<service>-build-<id>` revision name, else null. */
export function buildIdFromRevision(
  revision: string,
  service: string,
): string | null {
  const prefix = `${service}-build-`;
  return revision.startsWith(prefix)
    ? revision.slice(prefix.length) || null
    : null;
}

/** First line of a commit message, with a trailing `(#123)` split off. */
export function splitCommitTitle(message: string): {
  message: string;
  prNumber: number | null;
} {
  const first = message.split("\n")[0]?.trim() ?? "";
  const m = /^(.*?)\s*\(#(\d+)\)$/.exec(first);
  if (!m) return { message: first, prNumber: null };
  return { message: m[1].trim(), prNumber: Number(m[2]) };
}

function isReady(revision: RunRevision): boolean {
  return (revision.status?.conditions ?? []).some(
    (c) => c.type === "Ready" && c.status === "True",
  );
}

const OPEN_FIELDS =
  "number,title,url,author,createdAt,updatedAt,isDraft,reviewDecision,reviewRequests,labels,additions,deletions,headRefName";
const MERGED_FIELDS =
  "number,title,url,author,createdAt,updatedAt,mergedAt,isDraft,reviewDecision,labels,additions,deletions,headRefName";

async function listPrs(
  repo: string,
  args: string[],
  fields: string,
): Promise<GhPrRow[]> {
  const out = await gh([
    "pr",
    "list",
    "--repo",
    repo,
    ...args,
    "--json",
    fields,
    "--limit",
    String(GH_LIMIT),
  ]);
  return JSON.parse(out) as GhPrRow[];
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    extraRepos: {
      type: "string",
      label: "Extra repositories",
      description:
        "Comma-separated `owner/name` repos to include beside your bb projects' GitHub remotes.",
      default: "",
    },
    hideOwnOpen: {
      type: "boolean",
      label: "Hide my own open PRs",
      description: "Show only other people's open pull requests.",
      default: false,
    },
    gcpProject: {
      type: "string",
      label: "Google Cloud project",
      description: "Project that holds the Cloud Run service and the builds.",
      default: "vaam-286504",
    },
    runRegion: {
      type: "string",
      label: "Cloud Run region",
      description: "Region of the Cloud Run service.",
      default: "europe-west1",
    },
    runService: {
      type: "string",
      label: "Cloud Run service",
      description: "Name of the Cloud Run service to report on.",
      default: "vaam-web",
    },
    buildRegion: {
      type: "string",
      label: "Cloud Build region",
      description: "Region of the Cloud Build builds.",
      default: "europe-west1",
    },
    releaseRepo: {
      type: "string",
      label: "Release repository",
      description: "`owner/name` repo that the service is built from.",
      default: "vaam-io/vaam",
    },
  });

  let viewerCache: string | null = null;
  async function viewerLogin(): Promise<string> {
    if (viewerCache) return viewerCache;
    try {
      viewerCache = (await gh(["api", "user", "--jq", ".login"])).trim();
    } catch {
      viewerCache = "";
    }
    return viewerCache;
  }

  async function resolveRepos(): Promise<string[]> {
    const { extraRepos } = await settings.get();
    const repos = new Set<string>(parseRepoList(extraRepos));
    try {
      const projects = await bb.sdk.projects.list();
      for (const p of projects) {
        const repo = parseGitHubRepo(p.gitRemoteUrl);
        if (repo) repos.add(repo);
      }
    } catch (error) {
      bb.log.warn(`projects.list failed: ${String(error)}`);
    }
    return [...repos].sort();
  }

  async function fetchDigest(): Promise<Digest> {
    const { hideOwnOpen } = await settings.get();
    const day = yesterday();
    const fetchedAt = Date.now();
    const [viewer, repos] = await Promise.all([viewerLogin(), resolveRepos()]);
    const merged: PullRequest[] = [];
    const open: PullRequest[] = [];
    const errors: Digest["errors"] = [];

    await Promise.all(
      repos.map(async (repo) => {
        try {
          const [m, o] = await Promise.all([
            listPrs(
              repo,
              ["--state", "merged", "--search", `merged:${day}`],
              MERGED_FIELDS,
            ),
            listPrs(repo, ["--state", "open"], OPEN_FIELDS),
          ]);
          merged.push(...m.map((r) => toPullRequest(r, repo, viewer)));
          open.push(...o.map((r) => toPullRequest(r, repo, viewer)));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          bb.log.warn(`gh pr list failed for ${repo}: ${message}`);
          errors.push({ repo, message });
        }
      }),
    );

    merged.sort((a, b) => b.at.localeCompare(a.at));
    open.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const visibleOpen =
      hideOwnOpen && viewer ? open.filter((pr) => pr.author !== viewer) : open;

    return { day, viewer, repos, merged, open: visibleOpen, errors, fetchedAt };
  }

  let inflight: Promise<Digest> | null = null;

  async function getDigest(force: boolean): Promise<Digest> {
    if (!force) {
      const cached = await bb.storage.kv.get<Digest>(CACHE_KEY);
      if (
        cached &&
        cached.day === yesterday() &&
        Date.now() - cached.fetchedAt < CACHE_TTL_MS
      ) {
        return cached;
      }
    }
    if (!inflight) {
      inflight = fetchDigest()
        .then(async (digest) => {
          if (digest.errors.length === 0) {
            await bb.storage.kv.set(CACHE_KEY, digest);
          }
          return digest;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  async function fetchRelease(): Promise<Release> {
    const { gcpProject, runRegion, runService, buildRegion, releaseRepo } =
      await settings.get();
    const fetchedAt = Date.now();
    const errors: string[] = [];

    const note = (what: string, error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      bb.log.warn(`${what} failed: ${message}`);
      errors.push(`${what}: ${message}`);
    };

    const runArgs = ["--region", runRegion, "--project", gcpProject];
    const buildArgs = ["--region", buildRegion, "--project", gcpProject];

    const describeBuild = async (id: string): Promise<CloudBuild | null> => {
      try {
        const out = await gcloud([
          "builds",
          "describe",
          id,
          ...buildArgs,
          "--format",
          "json",
        ]);
        return JSON.parse(out) as CloudBuild;
      } catch (error) {
        note(`gcloud builds describe ${id}`, error);
        return null;
      }
    };

    const [service, revisions, buildList] = await Promise.all([
      gcloud([
        "run",
        "services",
        "describe",
        runService,
        ...runArgs,
        "--format",
        "json",
      ])
        .then((out) => JSON.parse(out) as RunService)
        .catch((error: unknown) => {
          note("gcloud run services describe", error);
          return null;
        }),
      gcloud([
        "run",
        "revisions",
        "list",
        "--service",
        runService,
        ...runArgs,
        "--limit",
        String(RUN_REVISION_LIMIT),
        "--format",
        "json",
      ])
        .then((out) => JSON.parse(out) as RunRevision[])
        .catch((error: unknown) => {
          note("gcloud run revisions list", error);
          return [] as RunRevision[];
        }),
      gcloud([
        "builds",
        "list",
        ...buildArgs,
        "--limit",
        String(BUILD_LIMIT),
        "--format",
        "json",
      ])
        .then((out) => JSON.parse(out) as CloudBuild[])
        .catch((error: unknown) => {
          note("gcloud builds list", error);
          return [] as CloudBuild[];
        }),
    ]);

    const base: Release = {
      service: runService,
      project: gcpProject,
      region: runRegion,
      repo: releaseRepo,
      live: null,
      waiting: [],
      builds: [],
      unreleased: [],
      aheadBy: 0,
      fetchedAt,
      errors,
    };

    const serving = (service?.status?.traffic ?? [])
      .filter(
        (t) => typeof t.percent === "number" && t.percent > 0 && t.revisionName,
      )
      .sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0));
    const liveName = serving[0]?.revisionName ?? null;
    if (!liveName) return base;

    const livePercent = serving
      .filter((t) => t.revisionName === liveName)
      .reduce((sum, t) => sum + (t.percent ?? 0), 0);

    const byName = new Map<string, RunRevision>();
    for (const r of revisions) {
      const name = r.metadata?.name;
      if (name) byName.set(name, r);
    }
    const liveCreated = byName.get(liveName)?.metadata?.creationTimestamp ?? null;

    const newer = revisions
      .filter((r) => {
        const name = r.metadata?.name;
        const created = r.metadata?.creationTimestamp;
        if (!name || !created || name === liveName) return false;
        if (!isReady(r)) return false;
        return liveCreated === null || created > liveCreated;
      })
      .sort((a, b) =>
        (b.metadata?.creationTimestamp ?? "").localeCompare(
          a.metadata?.creationTimestamp ?? "",
        ),
      );

    // One describe per revision build id. The list call above already holds
    // most of them, so only ask gcloud for the ones it did not return.
    const listedBuilds = new Map<string, CloudBuild>();
    for (const b of buildList) if (b.id) listedBuilds.set(b.id, b);

    const wanted = new Map<string, string>(); // revision -> build id
    const liveBuildId = buildIdFromRevision(liveName, runService);
    if (liveBuildId) wanted.set(liveName, liveBuildId);
    for (const r of newer) {
      const name = r.metadata?.name;
      if (!name) continue;
      const id = buildIdFromRevision(name, runService);
      if (id) wanted.set(name, id);
    }
    const missing = [...new Set(wanted.values())].filter(
      (id) => !listedBuilds.has(id),
    );
    const fetched = await Promise.all(missing.map((id) => describeBuild(id)));
    for (const b of fetched) if (b?.id) listedBuilds.set(b.id, b);

    const shaOfRevision = (revision: string): string | null => {
      const id = wanted.get(revision);
      if (!id) return null;
      return listedBuilds.get(id)?.substitutions?.COMMIT_SHA ?? null;
    };

    const liveBuild = liveBuildId ? listedBuilds.get(liveBuildId) : undefined;
    const liveSha = shaOfRevision(liveName);
    base.live = {
      revision: liveName,
      sha: liveSha,
      shortSha: liveSha ? shortSha(liveSha) : null,
      message: null,
      deployedAt: liveCreated,
      buildFinishedAt: liveBuild?.finishTime ?? null,
      percent: livePercent,
    };

    base.waiting = newer.map((r) => {
      const revision = r.metadata?.name ?? "";
      const sha = shaOfRevision(revision);
      return {
        revision,
        sha,
        shortSha: sha ? shortSha(sha) : null,
        createdAt: r.metadata?.creationTimestamp ?? "",
        ready: true,
        title: null,
        body: null,
        prNumber: null,
        author: null,
        commitCount: 0,
      };
    });

    if (!liveSha) return base;

    let compare: CompareResult | null = null;
    try {
      const out = await gh([
        "api",
        `repos/${releaseRepo}/compare/${liveSha}...main?per_page=100`,
      ]);
      compare = JSON.parse(out) as CompareResult;
    } catch (error) {
      note("gh api compare", error);
    }

    const commits = (compare?.commits ?? []).slice(-RELEASE_COMMIT_LIMIT);
    base.aheadBy = compare?.ahead_by ?? 0;

    // Chronological index, oldest first. A commit counts as built when a ready
    // revision holds it or any later commit.
    const order = new Map<string, number>();
    commits.forEach((c, i) => order.set(c.sha, i));
    let builtUpTo = -1;
    for (const w of base.waiting) {
      const i = w.sha ? (order.get(w.sha) ?? -1) : -1;
      if (i > builtUpTo) builtUpTo = i;
      w.commitCount = i + 1;
    }

    const buildsBySha = new Map<string, CloudBuild[]>();
    for (const b of buildList) {
      const sha = b.substitutions?.COMMIT_SHA;
      if (!sha || !order.has(sha)) continue;
      const list = buildsBySha.get(sha);
      if (list) list.push(b);
      else buildsBySha.set(sha, [b]);
    }
    for (const list of buildsBySha.values()) {
      list.sort((a, b) => (b.createTime ?? "").localeCompare(a.createTime ?? ""));
    }

    const stateOf = (sha: string, index: number): CommitState => {
      if (index <= builtUpTo) return "built";
      const list = buildsBySha.get(sha) ?? [];
      if (list.some((b) => RUNNING_BUILD.has(b.status ?? ""))) return "building";
      if (list[0] && FAILED_BUILD.has(list[0].status ?? "")) return "failed";
      return "pending";
    };

    base.unreleased = commits
      .map((c, index) => {
        const title = splitCommitTitle(c.commit.message);
        return {
          sha: c.sha,
          shortSha: shortSha(c.sha),
          message: title.message,
          prNumber: title.prNumber,
          author: c.author?.login ?? c.commit.author?.name ?? "unknown",
          date: c.commit.committer?.date ?? "",
          url: c.html_url,
          state: stateOf(c.sha, index),
        };
      })
      .reverse();

    base.builds = [...buildsBySha.values()]
      .flat()
      .sort((a, b) => (b.createTime ?? "").localeCompare(a.createTime ?? ""))
      .map((b) => {
        const sha = b.substitutions?.COMMIT_SHA ?? "";
        return {
          id: b.id ?? "",
          sha,
          shortSha: shortSha(sha),
          status: b.status ?? "UNKNOWN",
          startedAt: b.startTime ?? b.createTime ?? null,
          finishedAt: b.finishTime ?? null,
          logUrl: b.logUrl ?? null,
        };
      });

    // Commit messages for the live head and every waiting head, in parallel.
    const describeCommit = async (
      sha: string,
    ): Promise<CompareCommit | null> => {
      try {
        const out = await gh(["api", `repos/${releaseRepo}/commits/${sha}`]);
        return JSON.parse(out) as CompareCommit;
      } catch (error) {
        bb.log.warn(`gh api commit ${shortSha(sha)} failed: ${String(error)}`);
        return null;
      }
    };
    const waitingShas = base.waiting
      .map((w) => w.sha)
      .filter((sha): sha is string => sha !== null);
    const [liveCommit, ...waitingCommits] = await Promise.all([
      describeCommit(liveSha),
      ...waitingShas.map((sha) => describeCommit(sha)),
    ]);
    if (liveCommit) {
      base.live.message = splitCommitTitle(liveCommit.commit.message).message || null;
    }
    const bySha = new Map<string, CompareCommit>();
    for (const c of waitingCommits) if (c) bySha.set(c.sha, c);
    for (const w of base.waiting) {
      const c = w.sha ? bySha.get(w.sha) : undefined;
      if (!c) continue;
      const title = splitCommitTitle(c.commit.message);
      const body = c.commit.message.split("\n").slice(1).join("\n").trim();
      w.title = title.message || null;
      w.body = body || null;
      w.prNumber = title.prNumber;
      w.author = c.author?.login ?? c.commit.author?.name ?? null;
    }

    return base;
  }

  let releaseInflight: Promise<Release> | null = null;

  async function getRelease(force: boolean): Promise<Release> {
    if (!force) {
      const cached = await bb.storage.kv.get<Release>(RELEASE_CACHE_KEY);
      if (cached && Date.now() - cached.fetchedAt < RELEASE_CACHE_TTL_MS) {
        return cached;
      }
    }
    if (!releaseInflight) {
      releaseInflight = fetchRelease()
        .then(async (release) => {
          if (release.errors.length === 0) {
            await bb.storage.kv.set(RELEASE_CACHE_KEY, release);
          }
          return release;
        })
        .finally(() => {
          releaseInflight = null;
        });
    }
    return releaseInflight;
  }

  settings.onChange(() => {
    void bb.storage.kv.delete(CACHE_KEY);
    void bb.storage.kv.delete(RELEASE_CACHE_KEY);
  });

  bb.rpc.register(rpcContract, {
    digest: ({ force }) => getDigest(force === true),
    release: ({ force }) => getRelease(force === true),
  });

  bb.cli.register({
    name: "pr-digest",
    summary: "Yesterday's merged PRs and open PRs across your bb projects",
    commands: [
      {
        name: "show",
        summary: "Print the digest",
        usage: "bb pr-digest show [--refresh] [--json]",
      },
      {
        name: "release",
        summary: "Print what is live, what waits, and what is not released",
        usage: "bb pr-digest release [--refresh] [--json]",
      },
    ],
    async run(argv) {
      if (argv[0] === "release") {
        const release = await getRelease(argv.includes("--refresh"));
        if (argv.includes("--json")) {
          return { exitCode: 0, stdout: JSON.stringify(release, null, 2) };
        }
        const out: string[] = [];
        for (const e of release.errors) out.push(`error ${e}`);
        out.push(
          `${release.service} (${release.project} / ${release.region}) from ${release.repo}`,
        );
        out.push("");
        if (release.live) {
          const l = release.live;
          out.push(
            `Live ${l.shortSha ?? "unknown"} ${l.message ?? ""}`.trimEnd(),
          );
          out.push(`  revision ${l.revision} at ${l.percent}%`);
          if (l.deployedAt) out.push(`  deployed ${l.deployedAt}`);
        } else {
          out.push("Live: no revision serves traffic.");
        }
        out.push("");
        out.push(`Built, not live (${release.waiting.length})`);
        for (const w of release.waiting) {
          const pr = w.prNumber ? ` (#${w.prNumber})` : "";
          out.push(
            `  ${w.shortSha ?? "unknown"} ${w.title ?? w.revision}${pr} by ${w.author ?? "unknown"}, ${w.commitCount} commits since live, built ${w.createdAt}`,
          );
        }
        const running = release.builds.filter((b) =>
          RUNNING_BUILD.has(b.status),
        );
        if (running.length) {
          out.push("");
          out.push(`Building (${running.length})`);
          for (const b of running) out.push(`  ${b.shortSha} ${b.status}`);
        }
        out.push("");
        out.push(`Not yet released (${release.unreleased.length})`);
        for (const c of release.unreleased) {
          const pr = c.prNumber ? ` (#${c.prNumber})` : "";
          out.push(
            `  ${c.shortSha} [${c.state}] ${c.message}${pr} by ${c.author}`,
          );
        }
        return {
          exitCode: release.errors.length ? 1 : 0,
          stdout: out.join("\n"),
        };
      }
      const digest = await getDigest(argv.includes("--refresh"));
      if (argv.includes("--json")) {
        return { exitCode: 0, stdout: JSON.stringify(digest, null, 2) };
      }
      const lines: string[] = [];
      for (const e of digest.errors) lines.push(`error ${e.repo}: ${e.message}`);
      lines.push(`Repos: ${digest.repos.join(", ") || "(none)"}`);
      lines.push("");
      lines.push(`Merged on ${digest.day} (${digest.merged.length})`);
      for (const pr of digest.merged) {
        lines.push(`  ${pr.repo}#${pr.number} ${pr.title} by ${pr.author}`);
      }
      lines.push("");
      lines.push(`Open (${digest.open.length})`);
      for (const pr of digest.open) {
        const flags = [
          pr.isDraft ? "draft" : "",
          pr.reviewDecision.toLowerCase().replace("_", " "),
          pr.reviewRequested ? "review requested" : "",
        ]
          .filter(Boolean)
          .join(", ");
        lines.push(
          `  ${pr.repo}#${pr.number} ${pr.title} by ${pr.author}${flags ? ` (${flags})` : ""}`,
        );
      }
      return {
        exitCode: digest.errors.length ? 1 : 0,
        stdout: lines.join("\n"),
      };
    },
  });
}
