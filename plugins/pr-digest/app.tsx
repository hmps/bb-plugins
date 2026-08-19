// bb-plugin-pr-digest — frontend entry.
//
// Two homepage sections:
//   - Pull requests: PRs merged yesterday and every open PR across the user's
//     bb project repos, grouped by repo.
//   - Release: the commit that is live on Cloud Run, the builds that wait, and
//     the commits on main that are not released.
// Both use the host type scale (text-sm / text-xs) and tokens only.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { MouseEvent } from "react";
import type {
  Digest,
  PullRequest,
  Release,
  ReleaseCommit,
  rpcContract,
} from "./server";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type Kind = "merged" | "open";

// ---------------------------------------------------------------- helpers

function timeAgo(iso: string, now: number): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const min = Math.round(diff / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function formatDay(day: string): string {
  const d = new Date(`${day}T12:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function repoShort(repo: string): string {
  return repo.split("/")[1] ?? repo;
}

function groupByRepo(items: PullRequest[]): Array<[string, PullRequest[]]> {
  const map = new Map<string, PullRequest[]>();
  for (const pr of items) {
    const list = map.get(pr.repo);
    if (list) list.push(pr);
    else map.set(pr.repo, [pr]);
  }
  return [...map.entries()];
}

/**
 * In-app route of the GitHub plugin's pull request view
 * (`/plugins/github/github/pulls/<owner>/<repo>/<n>`). bb's router owns the
 * history stack; a plain left click pushes the route and notifies the router
 * through `popstate`, so navigation stays inside the SPA. Modified clicks and
 * middle clicks keep native anchor behaviour and open the route in a new tab.
 */
export function githubPanelPath(repo: string, number: number): string {
  return `/plugins/github/github/pulls/${repo}/${number}`;
}

function navigateInApp(event: MouseEvent<HTMLAnchorElement>, path: string) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  event.preventDefault();
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * The host centres homepage sections in a 760px column inside the
 * `@container/page` scroll area. On large screens a section can use more of
 * that area: keep the column's left edge (where the host draws the section
 * title and the composer) and extend to the right, capped, leaving a gutter
 * before the page edge. `50cqw + 50%` is the distance from the column's left
 * edge to the page container's right edge. On narrow screens `max(100%, ...)`
 * keeps the normal column width, so no media query is needed.
 */
const wideStyle = {
  width: "max(100%, min(1240px, 50cqw + 50% - 2rem))",
} as const;

const PRESS =
  "transition-[background-color,color,transform] duration-150 ease-out motion-reduce:transition-none active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Wall clock that ticks once a minute, for the relative times. */
function useNow(): [number, (value: number) => void] {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(tick);
  }, []);
  return [now, setNow];
}

/** Caps a list at `limit` rows and keeps the show more / show fewer state. */
function useCappedList<T>(items: T[], limit: number | undefined) {
  const [expanded, setExpanded] = useState(false);
  const hidden =
    limit !== undefined && !expanded ? Math.max(0, items.length - limit) : 0;
  const visible = hidden > 0 ? items.slice(0, limit) : items;
  return {
    visible,
    hidden,
    expanded,
    collapsible: limit !== undefined && items.length > limit,
    toggle: useCallback(() => setExpanded((v) => !v), []),
  };
}

// ------------------------------------------------------------ primitives

function Pill({
  tone,
  icon,
  children,
}: {
  tone: "accent" | "danger" | "muted";
  icon?: IconName;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-xs font-medium leading-none",
        tone === "accent" && "bg-primary/10 text-primary",
        tone === "danger" && "bg-destructive/10 text-destructive",
        tone === "muted" && "border border-border text-muted-foreground",
      )}
    >
      {icon ? <Icon name={icon} className="size-3" aria-hidden /> : null}
      {children}
    </span>
  );
}

function MoreToggle({
  expanded,
  hidden,
  onToggle,
}: {
  expanded: boolean;
  hidden: number;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "-mx-2 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        PRESS,
      )}
    >
      <Icon
        name={expanded ? "ChevronUp" : "ChevronDown"}
        className="size-3.5"
        aria-hidden
      />
      {expanded ? "Show fewer" : `Show ${hidden} more`}
    </button>
  );
}

function RefreshControl({
  updatedAt,
  now,
  loading,
  label,
  onRefresh,
}: {
  updatedAt: number | null;
  now: number;
  loading: boolean;
  label: string;
  onRefresh: () => void;
}) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {updatedAt !== null ? (
        <span>
          updated{" "}
          <span className="font-mono tabular-nums">
            {timeAgo(new Date(updatedAt).toISOString(), now)}
          </span>
        </span>
      ) : null}
      <button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        aria-label={label}
        title="Refresh"
        className={cn(
          "inline-flex size-7 items-center justify-center rounded-md max-md:pointer-coarse:size-11 hover:bg-muted hover:text-foreground disabled:pointer-events-none",
          PRESS,
        )}
      >
        <Icon
          name="RotateCcw"
          aria-hidden
          className={cn(
            "size-3.5",
            loading && "animate-spin motion-reduce:animate-none",
          )}
        />
      </button>
    </span>
  );
}

function statePill(pr: PullRequest, kind: Kind): ReactNode {
  if (kind !== "open") return null;
  if (pr.reviewRequested) {
    return (
      <Pill tone="accent" icon="UserRound">
        review requested
      </Pill>
    );
  }
  if (pr.reviewDecision === "APPROVED") {
    return (
      <Pill tone="accent" icon="Check">
        approved
      </Pill>
    );
  }
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    return (
      <Pill tone="danger" icon="AlertCircle">
        changes requested
      </Pill>
    );
  }
  if (pr.isDraft) return <Pill tone="muted">draft</Pill>;
  return null;
}

function statusIcon(pr: PullRequest, kind: Kind): IconName {
  if (kind === "merged") return "GitMerge";
  return pr.isDraft ? "GitPullRequestDraft" : "GitPullRequest";
}

// --------------------------------------------------------------- rows

function PrRow({
  pr,
  kind,
  viewer,
  now,
}: {
  pr: PullRequest;
  kind: Kind;
  viewer: string;
  now: number;
}) {
  const pill = statePill(pr, kind);
  const showAuthor = viewer === "" || pr.author !== viewer;
  return (
    <li>
      <a
        href={githubPanelPath(pr.repo, pr.number)}
        onClick={(event) => navigateInApp(event, githubPanelPath(pr.repo, pr.number))}
        title={`${pr.repo}#${pr.number}: ${pr.title}`}
        className={cn(
          "-mx-2 flex items-start gap-2.5 rounded-md px-2 py-2 hover:bg-muted/60",
          PRESS,
        )}
      >
        <Icon
          name={statusIcon(pr, kind)}
          aria-hidden
          className={cn(
            "mt-1 size-3.5 shrink-0",
            kind === "merged" ? "text-primary" : "text-muted-foreground",
            pr.isDraft && "text-muted-foreground/70",
          )}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className={cn(
              "truncate text-sm leading-5 text-foreground",
              pr.isDraft && "text-muted-foreground",
            )}
          >
            {pr.title}
          </span>
          <span className="flex min-w-0 items-center gap-x-2 text-xs leading-4 text-muted-foreground">
            <span className="font-mono tabular-nums">#{pr.number}</span>
            {showAuthor ? <span className="truncate">{pr.author}</span> : null}
            <span className="font-mono tabular-nums">{timeAgo(pr.at, now)}</span>
            <span className="font-mono tabular-nums">
              +{pr.additions} −{pr.deletions}
            </span>
            {pill ? <span className="ml-auto">{pill}</span> : null}
          </span>
        </span>
      </a>
    </li>
  );
}

function RepoGroup({
  repo,
  items,
  kind,
  viewer,
  now,
}: {
  repo: string;
  items: PullRequest[];
  kind: Kind;
  viewer: string;
  now: number;
}) {
  return (
    <section>
      <h4 className="mb-0.5 text-xs font-medium text-muted-foreground">
        {repoShort(repo)}
      </h4>
      <ul className="divide-y divide-border/60">
        {items.map((pr) => (
          <PrRow key={pr.url} pr={pr} kind={kind} viewer={viewer} now={now} />
        ))}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------- states

function SkeletonList({ rows }: { rows: number }) {
  const widths = ["w-3/5", "w-4/5", "w-1/2", "w-2/3", "w-3/4"];
  return (
    <div aria-hidden>
      <div className="mb-0.5 h-4 w-14 animate-pulse rounded bg-muted motion-reduce:animate-none" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-start gap-2.5 py-2">
          <div className="mt-1 size-3.5 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
          <div className="flex flex-1 flex-col gap-1.5 py-0.5">
            <div
              className={cn(
                "h-3.5 animate-pulse rounded bg-muted motion-reduce:animate-none",
                widths[i % widths.length],
              )}
            />
            <div className="h-3 w-28 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          </div>
        </div>
      ))}
    </div>
  );
}

function Empty({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <p className="flex items-center gap-2.5 rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
      <Icon name={icon} className="size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

function Column({
  heading,
  hint,
  kind,
  items,
  viewer,
  now,
  loading,
  empty,
  limit,
  action,
}: {
  heading: string;
  hint?: string;
  kind: Kind;
  items: PullRequest[];
  viewer: string;
  now: number;
  loading: boolean;
  empty: ReactNode;
  limit?: number;
  action?: ReactNode;
}) {
  const { visible, hidden, expanded, collapsible, toggle } = useCappedList(
    items,
    limit,
  );
  const groups = useMemo(() => groupByRepo(visible), [visible]);

  return (
    <div className="min-w-0">
      <div className="mb-3 flex h-8 items-center gap-2 border-b border-border">
        <h3 className="text-sm font-medium text-foreground">{heading}</h3>
        {!loading ? (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {items.length}
          </span>
        ) : null}
        {hint ? (
          <span className="truncate text-xs text-muted-foreground">{hint}</span>
        ) : null}
        {action ? <span className="ml-auto">{action}</span> : null}
      </div>
      {loading ? (
        <SkeletonList rows={kind === "open" ? 4 : 2} />
      ) : items.length === 0 ? (
        <Empty icon={kind === "merged" ? "GitMerge" : "GitPullRequest"}>
          {empty}
        </Empty>
      ) : (
        <div className="space-y-3">
          {groups.map(([repo, list]) => (
            <RepoGroup
              key={repo}
              repo={repo}
              items={list}
              kind={kind}
              viewer={viewer}
              now={now}
            />
          ))}
          {collapsible ? (
            <MoreToggle expanded={expanded} hidden={hidden} onToggle={toggle} />
          ) : null}
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------- section

function PrDigestSection() {
  const rpc = useRpc<typeof rpcContract>();
  const [digest, setDigest] = useState<Digest | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [now, setNow] = useNow();

  const load = useCallback(
    async (force: boolean) => {
      setLoading(true);
      try {
        setDigest(await rpc.call("digest", { force }));
        setFailure(null);
        setNow(Date.now());
      } catch (error) {
        setFailure(error instanceof Error ? error.message : String(error));
      } finally {
        setLoading(false);
      }
    },
    [rpc, setNow],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const viewer = digest?.viewer ?? "";
  const repoNames = digest?.repos.map(repoShort).join(", ") ?? "";
  const dayLabel = digest ? formatDay(digest.day) : "";
  const initial = loading && !digest;

  const refresh = (
    <RefreshControl
      updatedAt={digest ? digest.fetchedAt : null}
      now={now}
      loading={loading}
      label="Refresh pull requests"
      onRefresh={() => void load(true)}
    />
  );

  return (
    <div className="space-y-4" style={wideStyle}>
      {failure ? (
        <p className="flex items-center gap-2 text-xs text-destructive">
          <Icon name="AlertCircle" className="size-3.5 shrink-0" aria-hidden />
          Could not load pull requests: {failure}
        </p>
      ) : null}
      {digest?.errors.map((e) => (
        <p
          key={e.repo}
          className="flex items-center gap-2 text-xs text-destructive"
        >
          <Icon name="AlertCircle" className="size-3.5 shrink-0" aria-hidden />
          <span className="font-mono">{e.repo}</span>
          <span className="truncate">{e.message}</span>
        </p>
      ))}

      {digest && digest.repos.length === 0 ? (
        <Empty icon="Github">
          No GitHub repositories found. Add a bb project with a GitHub remote,
          or set Extra repositories in the plugin settings.
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-x-10 gap-y-6 md:grid-cols-[2fr_3fr]">
          <Column
            heading="Merged yesterday"
            hint={dayLabel || undefined}
            kind="merged"
            items={digest?.merged ?? []}
            viewer={viewer}
            now={now}
            loading={initial}
            empty={`Nothing merged on ${dayLabel || "that day"}.`}
          />
          <Column
            heading="Open"
            kind="open"
            items={digest?.open ?? []}
            viewer={viewer}
            now={now}
            loading={initial}
            limit={8}
            empty={
              repoNames
                ? `No open pull requests in ${repoNames}.`
                : "No open pull requests."
            }
            action={refresh}
          />
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------- release

const RUNNING_STATUS = new Set(["QUEUED", "WORKING", "PENDING"]);
const FAILED_STATUS = new Set(["FAILURE", "TIMEOUT", "CANCELLED", "EXPIRED"]);

type PipelineState = "ready" | "building" | "failed";

const STATE_TONE: Record<ReleaseCommit["state"], "accent" | "danger" | "muted"> =
  {
    built: "accent",
    building: "muted",
    failed: "danger",
    pending: "muted",
  };

function commitUrl(repo: string, sha: string): string {
  return `https://github.com/${repo}/commit/${sha}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

interface PipelineItem {
  key: string;
  shortSha: string;
  state: PipelineState;
  at: string;
  logUrl: string | null;
}

function pipelineItems(release: Release): PipelineItem[] {
  const seen = new Set<string>();
  const items: PipelineItem[] = [];
  for (const w of release.waiting) {
    if (w.sha) seen.add(w.sha);
    items.push({
      key: w.revision,
      shortSha: w.shortSha ?? "unknown",
      state: "ready",
      at: w.createdAt,
      logUrl: null,
    });
  }
  for (const b of release.builds) {
    if (seen.has(b.sha)) continue;
    if (RUNNING_STATUS.has(b.status)) {
      items.push({
        key: b.id,
        shortSha: b.shortSha,
        state: "building",
        at: b.startedAt ?? "",
        logUrl: b.logUrl,
      });
    } else if (FAILED_STATUS.has(b.status)) {
      items.push({
        key: b.id,
        shortSha: b.shortSha,
        state: "failed",
        at: b.finishedAt ?? b.startedAt ?? "",
        logUrl: b.logUrl,
      });
    }
  }
  return items;
}

function pipelineSummary(release: Release, items: PipelineItem[]): string {
  const ready = release.waiting.length;
  const building = items.filter((i) => i.state === "building").length;
  const failed = items.filter((i) => i.state === "failed").length;
  const parts: string[] = [];
  if (ready > 0) {
    parts.push(
      building + failed > 0
        ? `${plural(ready, "build")} ready`
        : `${plural(ready, "build")} ready to go live`,
    );
  }
  if (building > 0) parts.push(`${building} building`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(", ");
}

function PipelineRow({ item, now }: { item: PipelineItem; now: number }) {
  const tone =
    item.state === "ready"
      ? "accent"
      : item.state === "failed"
        ? "danger"
        : "muted";
  const body = (
    <>
      <span className="font-mono tabular-nums text-foreground">
        {item.shortSha}
      </span>
      <Pill tone={tone}>{item.state}</Pill>
      {item.at ? (
        <span className="font-mono tabular-nums">{timeAgo(item.at, now)}</span>
      ) : null}
    </>
  );
  return (
    <li className="flex items-center gap-2 text-xs leading-4 text-muted-foreground">
      {item.logUrl ? (
        <a
          href={item.logUrl}
          target="_blank"
          rel="noreferrer"
          title="Open the build log"
          className={cn(
            "-mx-2 flex flex-1 items-center gap-2 rounded-md px-2 py-1 hover:bg-muted/60",
            PRESS,
          )}
        >
          {body}
        </a>
      ) : (
        <span className="flex flex-1 items-center gap-2 px-0 py-1">{body}</span>
      )}
    </li>
  );
}

function CommitRow({
  commit,
  repo,
  now,
}: {
  commit: ReleaseCommit;
  repo: string;
  now: number;
}) {
  const prNumber = commit.prNumber;
  const href =
    prNumber !== null
      ? githubPanelPath(repo, prNumber)
      : commitUrl(repo, commit.sha);
  return (
    <li>
      <a
        href={href}
        {...(prNumber !== null
          ? {
              onClick: (event: MouseEvent<HTMLAnchorElement>) =>
                navigateInApp(event, href),
            }
          : { target: "_blank", rel: "noreferrer" })}
        title={`${commit.shortSha}: ${commit.message}`}
        className={cn(
          "-mx-2 flex min-w-0 flex-col rounded-md px-2 py-2 hover:bg-muted/60",
          PRESS,
        )}
      >
        <span className="truncate text-sm leading-5 text-foreground">
          {commit.message}
        </span>
        <span className="flex min-w-0 items-center gap-x-2 text-xs leading-4 text-muted-foreground">
          <span className="font-mono tabular-nums">{commit.shortSha}</span>
          <span className="truncate">{commit.author}</span>
          {commit.date ? (
            <span className="font-mono tabular-nums">
              {timeAgo(commit.date, now)}
            </span>
          ) : null}
          <span className="ml-auto">
            <Pill tone={STATE_TONE[commit.state]}>{commit.state}</Pill>
          </span>
        </span>
      </a>
    </li>
  );
}

function ReleaseSkeleton() {
  const widths = ["w-2/5", "w-3/5", "w-1/2"];
  return (
    <div aria-hidden className="space-y-4">
      <div className="flex items-center gap-2 py-1">
        <div className="size-2 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
        <div className="h-3.5 w-64 animate-pulse rounded bg-muted motion-reduce:animate-none" />
      </div>
      <div>
        <div className="mb-1 h-4 w-28 animate-pulse rounded bg-muted motion-reduce:animate-none" />
        {widths.map((w, i) => (
          <div key={i} className="flex flex-col gap-1.5 py-2">
            <div
              className={cn(
                "h-3.5 animate-pulse rounded bg-muted motion-reduce:animate-none",
                w,
              )}
            />
            <div className="h-3 w-32 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          </div>
        ))}
      </div>
    </div>
  );
}

function ReleaseSection() {
  const rpc = useRpc<typeof rpcContract>();
  const [release, setRelease] = useState<Release | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [now, setNow] = useNow();

  const load = useCallback(
    async (force: boolean) => {
      setLoading(true);
      try {
        setRelease(await rpc.call("release", { force }));
        setFailure(null);
        setNow(Date.now());
      } catch (error) {
        setFailure(error instanceof Error ? error.message : String(error));
      } finally {
        setLoading(false);
      }
    },
    [rpc, setNow],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const items = useMemo(
    () => (release ? pipelineItems(release) : []),
    [release],
  );
  const summary = useMemo(
    () => (release ? pipelineSummary(release, items) : ""),
    [release, items],
  );
  const unreleased = release?.unreleased ?? [];
  const { visible, hidden, expanded, collapsible, toggle } = useCappedList(
    unreleased,
    8,
  );
  const initial = loading && !release;
  const repo = release?.repo ?? "";
  const live = release?.live ?? null;

  return (
    <div className="space-y-4" style={wideStyle}>
      <div className="flex h-8 items-center gap-2 border-b border-border">
        <h3 className="text-sm font-medium text-foreground">
          {release?.service ?? "Release"}
        </h3>
        {release ? (
          <span className="truncate text-xs text-muted-foreground">
            {release.project} · {release.region}
          </span>
        ) : null}
        <span className="ml-auto">
          <RefreshControl
            updatedAt={release ? release.fetchedAt : null}
            now={now}
            loading={loading}
            label="Refresh release state"
            onRefresh={() => void load(true)}
          />
        </span>
      </div>

      {failure ? (
        <p className="flex items-center gap-2 text-xs text-destructive">
          <Icon name="AlertCircle" className="size-3.5 shrink-0" aria-hidden />
          Could not load the release state: {failure}
        </p>
      ) : null}
      {release?.errors.map((message) => (
        <p
          key={message}
          className="flex items-center gap-2 text-xs text-destructive"
        >
          <Icon name="AlertCircle" className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{message}</span>
        </p>
      ))}

      {initial ? (
        <ReleaseSkeleton />
      ) : (
        <div className="grid grid-cols-1 gap-x-10 gap-y-4 @min-[1000px]/page:grid-cols-[2fr_3fr]">
          <div className="min-w-0 space-y-4">
          {live ? (
            <p className="flex min-w-0 items-center gap-2 text-sm leading-5">
              <span
                className="size-2 shrink-0 rounded-full bg-primary"
                aria-hidden
              />
              <span className="shrink-0 text-foreground">Live</span>
              {live.sha ? (
                <a
                  href={commitUrl(repo, live.sha)}
                  target="_blank"
                  rel="noreferrer"
                  title={`${live.sha} on GitHub`}
                  className={cn(
                    "shrink-0 rounded-sm font-mono tabular-nums text-foreground underline-offset-2 hover:underline",
                    PRESS,
                  )}
                >
                  {live.shortSha}
                </a>
              ) : (
                <span className="shrink-0 font-mono text-muted-foreground">
                  unknown commit
                </span>
              )}
              {live.message ? (
                <span className="truncate text-muted-foreground">
                  {live.message}
                </span>
              ) : null}
              {live.deployedAt ? (
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  deployed{" "}
                  <span className="font-mono tabular-nums">
                    {timeAgo(live.deployedAt, now)}
                  </span>
                </span>
              ) : null}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              No live revision found.
            </p>
          )}

          {items.length > 0 ? (
            <div>
              <p className="text-sm text-foreground">{summary}</p>
              <ul className="mt-0.5">
                {items.map((item) => (
                  <PipelineRow key={item.key} item={item} now={now} />
                ))}
              </ul>
            </div>
          ) : null}
          </div>

          <div className="min-w-0">
            <div className="mb-0.5 flex items-center gap-2">
              <h4 className="text-sm font-medium text-foreground">
                Not yet released
              </h4>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {unreleased.length}
              </span>
            </div>
            {unreleased.length === 0 ? (
              <Empty icon="Check">Everything on main is live.</Empty>
            ) : (
              <div className="space-y-1">
                <ul className="divide-y divide-border/60">
                  {visible.map((commit) => (
                    <CommitRow
                      key={commit.sha}
                      commit={commit}
                      repo={repo}
                      now={now}
                    />
                  ))}
                </ul>
                {collapsible ? (
                  <MoreToggle
                    expanded={expanded}
                    hidden={hidden}
                    onToggle={toggle}
                  />
                ) : null}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.homepageSection({
    id: "pr-digest",
    title: "Pull requests",
    component: PrDigestSection,
  });
  app.slots.homepageSection({
    id: "release",
    title: "Release",
    component: ReleaseSection,
  });
});
