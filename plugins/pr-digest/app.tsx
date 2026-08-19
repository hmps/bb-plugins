// bb-plugin-pr-digest — frontend entry.
//
// Homepage section: a stat strip, then two asymmetric columns — PRs merged
// yesterday and every open PR across the user's bb project repos. Rows are
// grouped by repo and separated by hairlines instead of nested cards.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { Digest, PullRequest, rpcContract } from "./server";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

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

// ------------------------------------------------------------ primitives

function Stat({
  value,
  label,
  hint,
  loading,
}: {
  value: number;
  label: string;
  hint?: string;
  loading: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {loading ? (
        <div className="h-7 w-10 animate-pulse rounded bg-muted" />
      ) : (
        <span className="font-mono text-2xl font-medium tabular-nums leading-7 tracking-tight text-foreground">
          {value}
        </span>
      )}
      <span className="text-xs text-muted-foreground">
        {label}
        {hint ? <span className="text-muted-foreground/60"> · {hint}</span> : null}
      </span>
    </div>
  );
}

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
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px] font-medium leading-none",
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

function DiffStat({ additions, deletions }: PullRequest) {
  return (
    <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
      <span className="text-foreground/80">+{additions}</span>
      <span className="mx-0.5 text-muted-foreground/50">/</span>
      <span>−{deletions}</span>
    </span>
  );
}

function Labels({ labels }: { labels: PullRequest["labels"] }) {
  if (labels.length === 0) return null;
  const shown = labels.slice(0, 3);
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {shown.map((l) => (
        <span
          key={l.name}
          title={l.name}
          className="size-2 rounded-full ring-1 ring-border"
          style={{ backgroundColor: `#${l.color}` }}
        />
      ))}
      {labels.length > shown.length ? (
        <span className="text-[10px] text-muted-foreground">
          +{labels.length - shown.length}
        </span>
      ) : null}
    </span>
  );
}

// --------------------------------------------------------------- rows

function statusIcon(pr: PullRequest, kind: "merged" | "open"): IconName {
  if (kind === "merged") return "GitMerge";
  if (pr.isDraft) return "GitPullRequestDraft";
  return "GitPullRequest";
}

function PrRow({
  pr,
  kind,
  viewer,
  now,
  index,
}: {
  pr: PullRequest;
  kind: "merged" | "open";
  viewer: string;
  now: number;
  index: number;
}) {
  const mine = viewer !== "" && pr.author === viewer;
  const pill =
    kind !== "open" ? null : pr.reviewRequested ? (
      <Pill tone="accent" icon="UserRound">
        review requested
      </Pill>
    ) : pr.reviewDecision === "APPROVED" ? (
      <Pill tone="accent" icon="Check">
        approved
      </Pill>
    ) : pr.reviewDecision === "CHANGES_REQUESTED" ? (
      <Pill tone="danger" icon="AlertCircle">
        changes requested
      </Pill>
    ) : pr.isDraft ? (
      <Pill tone="muted">draft</Pill>
    ) : null;
  return (
    <li
      className="animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both duration-300"
      style={{ animationDelay: `${Math.min(index, 12) * 28}ms` }}
    >
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        title={`${pr.repo}#${pr.number} — ${pr.title}`}
        className={cn(
          "group -mx-2 grid grid-cols-[auto_1fr] items-start gap-x-2.5 rounded-md px-2 py-2",
          "transition-[background-color,transform] duration-200 ease-out",
          "hover:bg-muted/60 active:scale-[0.995]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <Icon
          name={statusIcon(pr, kind)}
          aria-hidden
          className={cn(
            "mt-[3px] size-3.5",
            kind === "merged"
              ? "text-primary"
              : pr.isDraft
                ? "text-muted-foreground/60"
                : "text-muted-foreground",
          )}
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span
              className={cn(
                "truncate text-[13px] leading-5 text-foreground",
                pr.isDraft && "text-muted-foreground",
              )}
            >
              {pr.title}
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-x-2 text-[11px] leading-4 text-muted-foreground">
            <span className="shrink-0 font-mono tabular-nums">#{pr.number}</span>
            <span className="shrink-0 truncate">
              <span className={cn(mine && "text-foreground/80")}>
                {mine ? "you" : pr.author}
              </span>
              <span className="text-muted-foreground/50"> · </span>
              <span className="font-mono tabular-nums">
                {timeAgo(pr.at, now)}
              </span>
            </span>
            <DiffStat {...pr} />
            <Labels labels={pr.labels} />
            {pill ? <span className="ml-auto shrink-0">{pill}</span> : null}
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
  offset,
}: {
  repo: string;
  items: PullRequest[];
  kind: "merged" | "open";
  viewer: string;
  now: number;
  offset: number;
}) {
  return (
    <section>
      <div className="mb-1 flex items-center gap-2 px-0.5">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {repoShort(repo)}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground/60">
          {items.length}
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
      <ul className="divide-y divide-border/60">
        {items.map((pr, i) => (
          <PrRow
            key={pr.url}
            pr={pr}
            kind={kind}
            viewer={viewer}
            now={now}
            index={offset + i}
          />
        ))}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------- states

function SkeletonList({ rows }: { rows: number }) {
  const widths = ["w-3/5", "w-4/5", "w-1/2", "w-2/3", "w-3/4", "w-1/3"];
  return (
    <div className="space-y-2 pt-1" aria-hidden>
      <div className="h-3 w-16 animate-pulse rounded bg-muted" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-2.5 py-1.5">
          <div className="size-3.5 animate-pulse rounded-full bg-muted" />
          <div
            className={cn(
              "h-3.5 animate-pulse rounded bg-muted",
              widths[i % widths.length],
            )}
          />
          <div className="ml-auto h-3 w-14 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

function Empty({ icon, title, detail }: { icon: IconName; title: string; detail: string }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-dashed border-border px-3 py-3">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon name={icon} className="size-3.5" aria-hidden />
      </span>
      <div className="min-w-0">
        <p className="text-[13px] text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

function Column({
  heading,
  kind,
  items,
  viewer,
  now,
  loading,
  empty,
  limit,
}: {
  heading: string;
  kind: "merged" | "open";
  items: PullRequest[];
  viewer: string;
  now: number;
  loading: boolean;
  empty: { title: string; detail: string };
  limit?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const hidden = limit && !expanded ? Math.max(0, items.length - limit) : 0;
  const visible = hidden > 0 ? items.slice(0, limit) : items;
  const groups = useMemo(() => groupByRepo(visible), [visible]);
  let offset = 0;
  return (
    <div className="min-w-0">
      <h3 className="mb-2 text-sm font-medium tracking-tight text-foreground">
        {heading}
      </h3>
      {loading ? (
        <SkeletonList rows={kind === "open" ? 5 : 3} />
      ) : items.length === 0 ? (
        <Empty
          icon={kind === "merged" ? "GitMerge" : "GitPullRequest"}
          title={empty.title}
          detail={empty.detail}
        />
      ) : (
        <div className="space-y-4">
          {groups.map(([repo, list]) => {
            const node = (
              <RepoGroup
                key={repo}
                repo={repo}
                items={list}
                kind={kind}
                viewer={viewer}
                now={now}
                offset={offset}
              />
            );
            offset += list.length;
            return node;
          })}
          {hidden > 0 || (limit && expanded && items.length > limit) ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className={cn(
                "-mx-2 flex w-[calc(100%+1rem)] items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground",
                "transition-[background-color,color,transform] duration-200 ease-out",
                "hover:bg-muted/60 hover:text-foreground active:scale-[0.995]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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

  return (
    <div className="space-y-5">
      {/* Stat strip */}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-border pb-4">
        <div className="flex items-end gap-6">
          <Stat
            value={digest?.merged.length ?? 0}
            label="merged"
            hint={dayLabel || undefined}
            loading={initial}
          />
          <span className="mb-1 h-8 w-px bg-border" aria-hidden />
          <Stat
            value={digest?.open.length ?? 0}
            label="open"
            hint={repoNames || undefined}
            loading={initial}
          />
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {digest ? (
            <span className="font-mono tabular-nums">
              updated {timeAgo(new Date(digest.fetchedAt).toISOString(), now)} ago
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={loading}
            aria-label="Refresh pull requests"
            className={cn(
              "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground",
              "transition-[background-color,color,transform] duration-200 ease-out",
              "hover:bg-muted hover:text-foreground active:scale-[0.96]",
              "disabled:pointer-events-none",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <Icon
              name="RotateCcw"
              aria-hidden
              className={cn("size-3.5", loading && "animate-spin")}
            />
          </button>
        </div>
      </div>

      {/* Errors */}
      {failure ? (
        <p className="flex items-center gap-2 text-xs text-destructive">
          <Icon name="AlertCircle" className="size-3.5" aria-hidden />
          Could not load: {failure}
        </p>
      ) : null}
      {digest?.errors.map((e) => (
        <p
          key={e.repo}
          className="flex items-center gap-2 text-xs text-destructive"
        >
          <Icon name="AlertCircle" className="size-3.5" aria-hidden />
          <span className="font-mono">{e.repo}</span>
          <span className="truncate">{e.message}</span>
        </p>
      ))}
      {digest && digest.repos.length === 0 ? (
        <Empty
          icon="Github"
          title="No GitHub repositories found"
          detail="Add a bb project with a GitHub remote, or set “Extra repositories” in the plugin settings."
        />
      ) : null}

      {/* Columns: 2fr / 3fr, single column on narrow viewports */}
      <div className="grid grid-cols-1 gap-x-10 gap-y-6 md:grid-cols-5">
        <div className="md:col-span-2">
          <Column
            heading="Merged yesterday"
            kind="merged"
            items={digest?.merged ?? []}
            viewer={viewer}
            now={now}
            loading={initial}
            empty={{
              title: `Nothing merged on ${dayLabel || "that day"}`,
              detail: repoNames ? `Across ${repoNames}.` : "No repositories to check.",
            }}
          />
        </div>
        <div className="md:col-span-3">
          <Column
            heading="Open pull requests"
            kind="open"
            items={digest?.open ?? []}
            viewer={viewer}
            now={now}
            loading={initial}
            limit={8}
            empty={{
              title: "No open pull requests",
              detail: repoNames ? `Clean slate in ${repoNames}.` : "No repositories to check.",
            }}
          />
        </div>
      </div>
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
