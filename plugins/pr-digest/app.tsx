// bb-plugin-pr-digest — frontend entry.
//
// Homepage section with two lists side by side: PRs merged yesterday and
// every open PR across the user's bb project repos. Rows group by repo and
// use the host type scale (text-sm / text-xs) and tokens only.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { Digest, PullRequest, rpcContract } from "./server";
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

const PRESS =
  "transition-[background-color,color,transform] duration-150 ease-out motion-reduce:transition-none active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

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
        href={pr.url}
        target="_blank"
        rel="noreferrer"
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
  const [expanded, setExpanded] = useState(false);
  const hidden = limit && !expanded ? Math.max(0, items.length - limit) : 0;
  const visible = hidden > 0 ? items.slice(0, limit) : items;
  const groups = useMemo(() => groupByRepo(visible), [visible]);
  const collapsible = limit !== undefined && items.length > limit;

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
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
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
  const [now, setNow] = useState(() => Date.now());

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
    [rpc],
  );

  useEffect(() => {
    void load(false);
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(tick);
  }, [load]);

  const viewer = digest?.viewer ?? "";
  const repoNames = digest?.repos.map(repoShort).join(", ") ?? "";
  const dayLabel = digest ? formatDay(digest.day) : "";
  const initial = loading && !digest;

  const refresh = (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {digest ? (
        <span>
          updated{" "}
          <span className="font-mono tabular-nums">
            {timeAgo(new Date(digest.fetchedAt).toISOString(), now)}
          </span>
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => void load(true)}
        disabled={loading}
        aria-label="Refresh pull requests"
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

  return (
    <div className="space-y-4">
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

export default definePluginApp((app) => {
  app.slots.homepageSection({
    id: "pr-digest",
    title: "Pull requests",
    component: PrDigestSection,
  });
});
