// bb-plugin-pr-digest — backend entry.
//
// Resolves the GitHub repos behind the user's bb projects, then fetches two
// lists per repo through the `gh` CLI and serves them over rpc:
//   - pull requests merged yesterday
//   - all open pull requests
import { execFile } from "node:child_process";
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

export const rpcContract = defineRpcContract({
  digest: {
    input: z.object({ force: z.boolean().optional() }).strict(),
    output: digestSchema,
  },
});

const CACHE_KEY = "digest.v2";
const CACHE_TTL_MS = 5 * 60_000;
const GH_LIMIT = 50;

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

  settings.onChange(() => {
    void bb.storage.kv.delete(CACHE_KEY);
  });

  bb.rpc.register(rpcContract, {
    digest: ({ force }) => getDigest(force === true),
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
    ],
    async run(argv) {
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
