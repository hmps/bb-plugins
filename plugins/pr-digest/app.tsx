// bb-plugin-pr-digest — frontend entry.
//
// Two homepage sections:
//   - Pull requests: PRs merged yesterday and every open PR across the user's
//     bb project repos, grouped by repo.
//   - Release: the commit that is live on Cloud Run, the builds that wait, and
//     the commits on main that are not released.
// Both use the host type scale (text-sm / text-xs) and tokens only.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { MouseEvent } from "react";
import type {
  Digest,
  PullRequest,
  Release,
  ReleaseBuild,
  ReleaseCommit,
  ReleaseWaiting,
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
 * that area: grow to the page container width (minus a gutter, capped) and
 * stay centred with a negative margin. On narrow screens `max(100%, ...)`
 * keeps the normal column width, so no media query is needed.
 */
const WIDE_WIDTH = "max(100%, min(1360px, 100cqw - 2rem))";
const wideStyle = {
  width: WIDE_WIDTH,
  marginLeft: `calc(50% - (${WIDE_WIDTH}) / 2)`,
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

  // The server announces every finished refresh; pick it up without polling.
  useRealtime("digest", () => {
    void load(false);
  });

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

const STATE_TONE: Record<ReleaseCommit["state"], "accent" | "danger" | "muted"> =
  {
    built: "accent",
    building: "muted",
    failed: "danger",
    "not built": "muted",
  };

function commitUrl(repo: string, sha: string): string {
  return `https://github.com/${repo}/commit/${sha}`;
}

/** Cloud Run revisions page: where traffic is moved to a new revision. */
function revisionsUrl(release: Release): string {
  return `https://console.cloud.google.com/run/detail/${release.region}/${release.service}/revisions?project=${release.project}`;
}

/** Cloud Build history for the project and region. */
function buildsUrl(release: Release): string {
  return `https://console.cloud.google.com/cloud-build/builds;region=${release.region}?project=${release.project}`;
}

/** Short sha that opens the commit on GitHub in a new tab. */
function ShaLink({ repo, sha, className }: { repo: string; sha: string; className?: string }) {
  return (
    <a
      href={commitUrl(repo, sha)}
      target="_blank"
      rel="noreferrer"
      title={`${sha} on GitHub`}
      onClick={(event) => event.stopPropagation()}
      className={cn(
        "rounded-sm font-mono tabular-nums underline-offset-2 hover:text-foreground hover:underline",
        PRESS,
        className,
      )}
    >
      {shortSha(sha)}
    </a>
  );
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function ConsoleLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground",
        PRESS,
      )}
    >
      {children}
      <Icon name="ArrowUpRight" className="size-3" aria-hidden />
    </a>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Running builds plus the latest build, so a failure stays visible. */
function visibleBuilds(release: Release): ReleaseBuild[] {
  const running = release.builds.filter((b) => RUNNING_STATUS.has(b.status));
  const latest = release.builds[0];
  if (latest && !running.some((b) => b.id === latest.id)) {
    return [...running, latest];
  }
  return running;
}

function buildStatus(build: ReleaseBuild): {
  label: string;
  tone: "accent" | "danger" | "muted";
} {
  if (RUNNING_STATUS.has(build.status)) return { label: "building", tone: "muted" };
  if (FAILED_STATUS.has(build.status)) {
    return { label: build.status.toLowerCase(), tone: "danger" };
  }
  if (build.status === "SUCCESS") return { label: "built", tone: "accent" };
  return { label: build.status.toLowerCase(), tone: "muted" };
}

function waitingSummary(release: Release): string {
  const ready = release.waiting.length;
  const building = release.builds.filter((b) => RUNNING_STATUS.has(b.status)).length;
  const parts: string[] = [];
  if (ready > 0) {
    parts.push(
      building > 0
        ? `${plural(ready, "build")} ready`
        : `${plural(ready, "build")} ready to go live`,
    );
  }
  if (building > 0) parts.push(`${building} building`);
  return parts.join(", ");
}

function BuildRow({
  build,
  repo,
  now,
}: {
  build: ReleaseBuild;
  repo: string;
  now: number;
}) {
  const status = buildStatus(build);
  const running = RUNNING_STATUS.has(build.status);
  const at = running ? build.startedAt : (build.finishedAt ?? build.startedAt);
  const href =
    build.prNumber !== null
      ? githubPanelPath(repo, build.prNumber)
      : commitUrl(repo, build.sha);
  return (
    <li className="flex min-w-0 flex-col py-2">
      <span className="flex min-w-0 items-center gap-2">
        {running ? (
          <Icon
            name="RotateCcw"
            aria-hidden
            className="size-3 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
          />
        ) : null}
        <a
          href={href}
          {...(build.prNumber !== null
            ? {
                onClick: (event: MouseEvent<HTMLAnchorElement>) =>
                  navigateInApp(event, href),
              }
            : { target: "_blank", rel: "noreferrer" })}
          title={build.prNumber !== null ? `Open #${build.prNumber}` : "Open the commit on GitHub"}
          className={cn(
            "min-w-0 truncate rounded-sm text-sm leading-5 text-foreground underline-offset-2 hover:underline",
            PRESS,
          )}
        >
          {build.title ?? build.shortSha}
        </a>
        <span className="ml-auto shrink-0">
          <Pill tone={status.tone}>{status.label}</Pill>
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-x-2 text-xs leading-4 text-muted-foreground">
        <ShaLink repo={repo} sha={build.sha} />
        {at ? (
          <span className="font-mono tabular-nums">
            {running ? "started " : ""}
            {timeAgo(at, now)}
          </span>
        ) : null}
        {build.logUrl ? <ConsoleLink href={build.logUrl}>build log</ConsoleLink> : null}
      </span>
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
    <li className="flex min-w-0 flex-col py-2">
      <a
        href={href}
        {...(prNumber !== null
          ? {
              onClick: (event: MouseEvent<HTMLAnchorElement>) =>
                navigateInApp(event, href),
            }
          : { target: "_blank", rel: "noreferrer" })}
        title={prNumber !== null ? `Open #${prNumber}` : "Open the commit on GitHub"}
        className={cn(
          "truncate rounded-sm text-sm leading-5 text-foreground underline-offset-2 hover:underline",
          PRESS,
        )}
      >
        {commit.message}
      </a>
      <span className="flex min-w-0 items-center gap-x-2 text-xs leading-4 text-muted-foreground">
        <ShaLink repo={repo} sha={commit.sha} />
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
    </li>
  );
}

function WaitingRow({
  item,
  repo,
  now,
}: {
  item: ReleaseWaiting;
  repo: string;
  now: number;
}) {
  const title = item.title ?? item.revision;
  const href =
    item.prNumber !== null
      ? githubPanelPath(repo, item.prNumber)
      : item.sha
        ? commitUrl(repo, item.sha)
        : null;
  return (
    <li className="flex min-w-0 flex-col py-2">
      {href === null ? (
        <span className="truncate text-sm leading-5 text-foreground">{title}</span>
      ) : (
        <a
          href={href}
          {...(item.prNumber !== null
            ? {
                onClick: (event: MouseEvent<HTMLAnchorElement>) =>
                  navigateInApp(event, href),
              }
            : { target: "_blank", rel: "noreferrer" })}
          title={item.prNumber !== null ? `Open #${item.prNumber}` : "Open the commit on GitHub"}
          className={cn(
            "truncate rounded-sm text-sm leading-5 text-foreground underline-offset-2 hover:underline",
            PRESS,
          )}
        >
          {title}
        </a>
      )}
      <span className="flex min-w-0 items-center gap-x-2 text-xs leading-4 text-muted-foreground">
        {item.sha ? <ShaLink repo={repo} sha={item.sha} /> : null}
        {item.author ? <span className="truncate">{item.author}</span> : null}
        <span className="font-mono tabular-nums">
          {timeAgo(item.createdAt, now)}
        </span>
        {item.commitCount > 1 ? (
          <span>{plural(item.commitCount, "commit")} since live</span>
        ) : null}
        <span className="ml-auto">
          <Pill tone="accent">ready</Pill>
        </span>
      </span>
      {item.body ? (
        <span
          className="mt-1 line-clamp-2 text-xs leading-4 text-muted-foreground"
          title={item.body}
        >
          {item.body}
        </span>
      ) : null}
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

  // The server announces every finished refresh; pick it up without polling.
  useRealtime("release", () => {
    void load(false);
  });

  const builds = useMemo(
    () => (release ? visibleBuilds(release) : []),
    [release],
  );
  const summary = release ? waitingSummary(release) : "";
  const latestBuild = release?.builds[0] ?? null;
  const latestFailed = latestBuild !== null && FAILED_STATUS.has(latestBuild.status);
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
        <span className="ml-auto flex items-center gap-3">
          {release ? (
            <>
              <ConsoleLink href={revisionsUrl(release)}>Cloud Run</ConsoleLink>
              <ConsoleLink href={buildsUrl(release)}>Builds</ConsoleLink>
            </>
          ) : null}
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
      {release?.authRequired ? (
        <p className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm text-foreground">
          <Icon name="AlertCircle" className="size-4 shrink-0 text-destructive" aria-hidden />
          <span>
            Google Cloud needs you to sign in again. Run{" "}
            <code className="rounded-sm bg-muted px-1 font-mono text-xs">
              gcloud auth login
            </code>{" "}
            in a terminal, then refresh.
          </span>
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
      ) : release?.authRequired ? null : (
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
                <ShaLink repo={repo} sha={live.sha} className="shrink-0 text-foreground" />
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

          {release && release.waiting.length > 0 ? (
            <div>
              <p className="flex items-center gap-3 text-sm text-foreground">
                <span>{summary}</span>
                <ConsoleLink href={revisionsUrl(release)}>
                  Deploy in Cloud Run
                </ConsoleLink>
              </p>
              <ul className="mt-1 divide-y divide-border/60">
                {release.waiting.map((w) => (
                  <WaitingRow key={w.revision} item={w} repo={repo} now={now} />
                ))}
              </ul>
            </div>
          ) : null}

          {release && builds.length > 0 ? (
            <div>
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-medium text-foreground">Builds</h4>
                {latestFailed ? (
                  <span className="flex items-center gap-1 text-xs text-destructive">
                    <Icon name="AlertCircle" className="size-3.5" aria-hidden />
                    latest build failed
                  </span>
                ) : null}
                <span className="ml-auto">
                  <ConsoleLink href={buildsUrl(release)}>All builds</ConsoleLink>
                </span>
              </div>
              <ul className="mt-0.5 divide-y divide-border/60">
                {builds.map((b) => (
                  <BuildRow key={b.id} build={b} repo={repo} now={now} />
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
