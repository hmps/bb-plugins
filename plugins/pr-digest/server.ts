// bb-plugin-pr-digest — backend entry.
//
// Fetches two GitHub lists through the `gh` CLI and serves them to the
// homepage section over rpc:
//   - pull requests merged yesterday
//   - open pull requests that wait for the user's review
import { execFile } from "node:child_process";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const prSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  repo: z.string(),
  author: z.string(),
  at: z.string(),
  isDraft: z.boolean(),
});

export type PullRequest = z.infer<typeof prSchema>;

const digestSchema = z.object({
  day: z.string(),
  merged: z.array(prSchema),
  reviewQueue: z.array(prSchema),
  fetchedAt: z.number(),
  error: z.string().nullable(),
});

export type Digest = z.infer<typeof digestSchema>;

export const rpcContract = defineRpcContract({
  digest: {
    input: z.object({ force: z.boolean().optional() }).strict(),
    output: digestSchema,
  },
});

const CACHE_KEY = "digest";
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

/** Split a free-text qualifier setting into argv tokens. */
export function splitQualifiers(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

interface GhSearchRow {
  number: number;
  title: string;
  url: string;
  repository: { nameWithOwner: string };
  author: { login: string } | null;
  closedAt: string | null;
  createdAt: string;
  isDraft: boolean;
}

function toPullRequest(row: GhSearchRow): PullRequest {
  return {
    number: row.number,
    title: row.title,
    url: row.url,
    repo: row.repository.nameWithOwner,
    author: row.author?.login ?? "unknown",
    at: row.closedAt ?? row.createdAt,
    isDraft: row.isDraft,
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

const JSON_FIELDS =
  "number,title,url,repository,author,closedAt,createdAt,isDraft";

async function searchPrs(args: string[]): Promise<PullRequest[]> {
  const out = await gh([
    "search",
    "prs",
    ...args,
    "--json",
    JSON_FIELDS,
    "--limit",
    String(GH_LIMIT),
  ]);
  const rows = JSON.parse(out) as GhSearchRow[];
  return rows.map(toPullRequest);
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    mergedScope: {
      type: "string",
      label: "Merged PRs scope",
      description:
        "GitHub search qualifiers for yesterday's merged PRs, e.g. `involves:@me` or `org:acme`.",
      default: "involves:@me",
    },
    reviewScope: {
      type: "string",
      label: "Review queue extra qualifiers",
      description:
        "Optional qualifiers added to `review-requested:@me`, e.g. `org:acme` or `team-review-requested:acme/core`.",
      default: "",
    },
  });

  async function fetchDigest(): Promise<Digest> {
    const { mergedScope, reviewScope } = await settings.get();
    const day = yesterday();
    const fetchedAt = Date.now();
    try {
      const [merged, reviewQueue] = await Promise.all([
        searchPrs([
          "--merged",
          "--merged-at",
          day,
          "--sort",
          "updated",
          ...splitQualifiers(mergedScope),
        ]),
        searchPrs([
          "--state",
          "open",
          "--review-requested",
          "@me",
          "--sort",
          "updated",
          ...splitQualifiers(reviewScope),
        ]),
      ]);
      return { day, merged, reviewQueue, fetchedAt, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      bb.log.warn(`gh search failed: ${message}`);
      return { day, merged: [], reviewQueue: [], fetchedAt, error: message };
    }
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
          if (!digest.error) await bb.storage.kv.set(CACHE_KEY, digest);
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
    summary: "Yesterday's merged PRs and your GitHub review queue",
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
      if (digest.error) lines.push(`error: ${digest.error}`);
      lines.push(`Merged on ${digest.day} (${digest.merged.length})`);
      for (const pr of digest.merged) {
        lines.push(`  ${pr.repo}#${pr.number} ${pr.title} — ${pr.author}`);
      }
      lines.push("");
      lines.push(`Review queue (${digest.reviewQueue.length})`);
      for (const pr of digest.reviewQueue) {
        const draft = pr.isDraft ? " (draft)" : "";
        lines.push(`  ${pr.repo}#${pr.number} ${pr.title} — ${pr.author}${draft}`);
      }
      return { exitCode: digest.error ? 1 : 0, stdout: lines.join("\n") };
    },
  });
}
