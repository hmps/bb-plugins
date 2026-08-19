// bb-plugin-pr-digest — frontend entry.
//
// One homepage section with two columns: PRs merged yesterday and the
// user's open review queue. Data comes from the backend `digest` rpc.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { Digest, PullRequest, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

function timeAgo(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const min = Math.round(diff / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function PrRow({ pr }: { pr: PullRequest }) {
  return (
    <li className="flex items-baseline gap-2 text-sm leading-5">
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 flex-1 truncate hover:underline"
        title={`${pr.repo}#${pr.number} — ${pr.title}`}
      >
        <span className="text-muted-foreground">
          {pr.repo.split("/")[1] ?? pr.repo}#{pr.number}
        </span>{" "}
        <span className="text-foreground">{pr.title}</span>
        {pr.isDraft ? (
          <span className="ml-1 text-xs text-muted-foreground">(draft)</span>
        ) : null}
      </a>
      <span className="shrink-0 text-xs text-muted-foreground">
        {pr.author} · {timeAgo(pr.at)}
      </span>
    </li>
  );
}

function PrList({
  heading,
  items,
  empty,
}: {
  heading: string;
  items: PullRequest[];
  empty: string;
}) {
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-sm font-medium text-foreground">{heading}</h3>
        <span className="rounded-full bg-muted px-2 text-xs text-muted-foreground">
          {items.length}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-1">
          {items.map((pr) => (
            <PrRow key={pr.url} pr={pr} />
          ))}
        </ul>
      )}
    </div>
  );
}

function PrDigestSection() {
  const rpc = useRpc<typeof rpcContract>();
  const [digest, setDigest] = useState<Digest | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(
    async (force: boolean) => {
      setLoading(true);
      try {
        setDigest(await rpc.call("digest", { force }));
        setFailure(null);
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
  }, [load]);

  const error = failure ?? digest?.error ?? null;

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {digest ? `Merged on ${digest.day}` : "Loading…"}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={loading}
            onClick={() => void load(true)}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
        {error ? (
          <p className="text-sm text-destructive">
            Could not load from GitHub: {error}
          </p>
        ) : null}
        {digest ? (
          <div className="flex flex-col gap-4 md:flex-row md:gap-6">
            <PrList
              heading="Merged yesterday"
              items={digest.merged}
              empty="No PRs merged yesterday."
            />
            <PrList
              heading="Review queue"
              items={digest.reviewQueue}
              empty="Nothing waits for your review."
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default definePluginApp((app) => {
  app.slots.homepageSection({
    id: "pr-digest",
    title: "Pull requests",
    component: PrDigestSection,
  });
});
