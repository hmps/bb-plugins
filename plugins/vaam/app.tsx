// bb-plugin-vaam — the frontend bundle.
//
// A "Vaam" nav panel. Its first section is a Beads viewer: the vaam
// monorepo's `bd` issues as a tree, a detail pane, and "Assign agent", which
// opens bb's own new-thread composer pre-filled with a prompt for that bead.
// The panel owns /plugins/vaam/vaam/*, so the selected bead lives in the
// route's subPath and browser back/forward walks the selection.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp,
  experimental_NewThreadComposer as NewThreadComposer,
  useBbNavigate,
  useRpc,
  type NewThreadRequest,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import {
  buildBeadTree,
  parseSubPath,
  pathToBead,
  routeToSubPath,
  type BeadTreeNode,
  type Route,
} from "./app-logic.js";
import type { Bead, BeadDetail, vaamRpcContract } from "./server.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { cn } from "@/lib/utils";

const PANEL_PATH = "vaam";

/** The status filter chips, in the order the toolbar shows them. */
const FILTERABLE_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "deferred",
] as const;
type FilterableStatus = (typeof FILTERABLE_STATUSES)[number];

const STATUS_GLYPH: Record<Bead["status"], string> = {
  open: "○",
  in_progress: "◐",
  closed: "●",
  deferred: "◇",
  blocked: "⊘",
};

const STATUS_LABEL: Record<Bead["status"], string> = {
  open: "open",
  in_progress: "in progress",
  closed: "closed",
  deferred: "deferred",
  blocked: "blocked",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortDate(value: string): string {
  if (value === "") return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Sub-routing. The section is the first segment so more sections can be added
// later without invalidating links already in browser history.
// ---------------------------------------------------------------------------

function useSubPathRoute(subPath: string): [Route, (next: Route) => void] {
  const bbNavigate = useBbNavigate();
  const route = useMemo(() => parseSubPath(subPath), [subPath]);
  const navigate = useCallback(
    (next: Route) => {
      bbNavigate.toPluginPanel(PANEL_PATH, { subPath: routeToSubPath(next) });
    },
    [bbNavigate],
  );
  return [route, navigate];
}

// ---------------------------------------------------------------------------
// Data.
// ---------------------------------------------------------------------------

interface BeadsState {
  beads: Bead[] | null;
  projectId: string | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

function useBeads(includeClosed: boolean): BeadsState {
  const rpc = useRpc<typeof vaamRpcContract>();
  const [beads, setBeads] = useState<Bead[] | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // The refresh button asks for a fresh bd run; everything else takes the
    // server's cache, which is served at once and refreshed in the background.
    rpc.call("listBeads", { includeClosed, force: nonce > 0 }).then(
      (result) => {
        if (cancelled) return;
        setBeads(result.beads as Bead[]);
        setProjectId(result.projectId);
        setError(null);
        setLoading(false);
      },
      (cause: unknown) => {
        if (cancelled) return;
        setError(errorText(cause));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, includeClosed, nonce]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  return { beads, projectId, error, loading, refresh };
}

function useBeadDetail(id: string | null): {
  detail: BeadDetail | null;
  error: string | null;
} {
  const rpc = useRpc<typeof vaamRpcContract>();
  const [detail, setDetail] = useState<BeadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (id === null) {
      setDetail(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setError(null);
    rpc.call("getBead", { id }).then(
      (result) => {
        if (!cancelled) setDetail(result.bead as BeadDetail);
      },
      (cause: unknown) => {
        if (!cancelled) setError(errorText(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, id]);

  return { detail, error };
}

// ---------------------------------------------------------------------------
// "Assign agent" — bb's own new-thread composer, seeded with the bead prompt.
// The composer resolves every execution selection; `spawnForBead` forwards
// that request verbatim to threads.spawn.
// ---------------------------------------------------------------------------

interface PromptSeed {
  projectId: string | null;
  prompt: string;
}

function AssignAgentDialog({
  bead,
  open,
  onOpenChange,
}: {
  bead: Bead;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rpc = useRpc<typeof vaamRpcContract>();
  const navigate = useBbNavigate();
  const [seed, setSeed] = useState<PromptSeed | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);

  // Re-seed on every open, so a bead edited since the last open opens with
  // its current description and acceptance criteria.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSeed(null);
    setSeedError(null);
    rpc.call("beadPrompt", { id: bead.id }).then(
      (result) => {
        if (cancelled) return;
        setSeed(result as PromptSeed);
        setFocusRequest((value) => value + 1);
      },
      (cause: unknown) => {
        if (!cancelled) setSeedError(errorText(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, bead.id, rpc]);

  const handleSubmit = useCallback(
    async (request: NewThreadRequest) => {
      try {
        const result = await rpc.call("spawnForBead", {
          id: bead.id,
          // The rpc schema is a loose object (index signature) so new host
          // fields ride through; `NewThreadRequest` is exact, hence the cast.
          request: request as unknown as Record<string, unknown> & {
            projectId: string;
            providerId: string;
            model: string;
            reasoningLevel: string;
            permissionMode: string;
            environment: Record<string, unknown> & { type: string };
            input: unknown[];
          },
        });
        const threadId = (result as { threadId?: unknown })?.threadId;
        if (typeof threadId !== "string") throw new Error("malformed spawn result");
        onOpenChange(false);
        navigate.toThread(threadId);
      } catch (error: unknown) {
        toast.error(errorText(error));
        // Rethrow: the composer keeps the draft only when onSubmit rejects.
        throw error;
      }
    },
    [rpc, bead.id, navigate, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Assign agent</DialogTitle>
          <DialogDescription>
            {bead.id} · {bead.title}
          </DialogDescription>
        </DialogHeader>
        {seedError !== null ? (
          <p className="text-sm text-destructive">{seedError}</p>
        ) : seed === null ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        ) : (
          <NewThreadComposer
            defaultProjectId={seed.projectId ?? undefined}
            initialPrompt={seed.prompt}
            layout="document"
            focusRequest={focusRequest}
            draftKey={`vaam:bead:${bead.id}`}
            onSubmit={handleSubmit}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// The tree.
// ---------------------------------------------------------------------------

function StatusGlyph({ status }: { status: Bead["status"] }) {
  return (
    <span
      aria-label={STATUS_LABEL[status]}
      title={STATUS_LABEL[status]}
      className={cn(
        "w-3 shrink-0 text-center font-mono text-xs leading-none",
        status === "in_progress" && "text-primary",
        status === "blocked" && "text-destructive",
        status === "closed" && "text-muted-foreground",
        status === "deferred" && "text-muted-foreground",
      )}
    >
      {STATUS_GLYPH[status]}
    </span>
  );
}

function BeadRow({
  node,
  depth,
  selectedId,
  expanded,
  onToggle,
  onSelect,
}: {
  node: BeadTreeNode<Bead>;
  depth: number;
  selectedId: string | null;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const { bead, children } = node;
  const isOpen = expanded.has(bead.id);
  const isSelected = bead.id === selectedId;
  return (
    <>
      <div
        className={cn(
          "flex w-full items-center gap-2 rounded-md py-2 pr-3 text-sm",
          isSelected ? "bg-state-active" : "hover:bg-state-hover",
        )}
        style={{ paddingLeft: `${depth * 1 + 0.5}rem` }}
      >
        {children.length > 0 ? (
          <button
            type="button"
            className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            aria-expanded={isOpen}
            aria-label={`${isOpen ? "Collapse" : "Expand"} ${bead.id}`}
            onClick={() => onToggle(bead.id)}
          >
            <Icon
              name={isOpen ? "ChevronDown" : "ChevronRight"}
              className="size-3.5"
            />
          </button>
        ) : (
          <span className="size-5 shrink-0" />
        )}
        <StatusGlyph status={bead.status} />
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => onSelect(bead.id)}
        >
          <span className="shrink-0 font-mono text-[0.65rem] text-muted-foreground">
            P{bead.priority}
          </span>
          {bead.issueType === "task" ? null : (
            <span className="shrink-0 font-mono text-[0.65rem] text-muted-foreground">
              [{bead.issueType}]
            </span>
          )}
          <span className="min-w-0 flex-1 truncate">{bead.title}</span>
          {bead.assignee === null ? null : (
            <span className="hidden shrink-0 text-xs text-muted-foreground lg:inline">
              {bead.assignee}
            </span>
          )}
          {children.length > 0 ? (
            <span className="shrink-0 text-[0.65rem] text-muted-foreground">
              {children.length}
            </span>
          ) : null}
        </button>
      </div>
      {isOpen
        ? children.map((child) => (
            <BeadRow
              key={child.bead.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))
        : null}
    </>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The detail pane.
// ---------------------------------------------------------------------------

function DetailSection({ title, body }: { title: string; body: string }) {
  if (body.trim() === "") return null;
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-card p-4 font-mono text-xs leading-relaxed">
        {body.trim()}
      </pre>
    </section>
  );
}

function BeadDetailPane({
  bead,
  childBeads,
  onSelect,
  onBack,
}: {
  bead: Bead;
  childBeads: Bead[];
  onSelect: (id: string) => void;
  onBack: (() => void) | null;
}) {
  const { detail, error } = useBeadDetail(bead.id);
  const [assignOpen, setAssignOpen] = useState(false);

  const copyId = useCallback(() => {
    void navigator.clipboard?.writeText(bead.id).then(
      () => toast.success(`Copied ${bead.id}`),
      (cause: unknown) => toast.error(errorText(cause)),
    );
  }, [bead.id]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-3 border-b border-border px-5 py-4">
        {onBack === null ? null : (
          <Button
            variant="ghost"
            size="sm"
            className="w-fit -ml-2"
            onClick={onBack}
          >
            <Icon name="ChevronLeft" className="size-4" />
            Beads
          </Button>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">
            {bead.id}
          </span>
          <Badge variant="secondary">{STATUS_LABEL[bead.status]}</Badge>
          <Badge variant="outline">P{bead.priority}</Badge>
          <Badge variant="outline">{bead.issueType}</Badge>
          {bead.assignee === null ? null : (
            <span className="text-xs text-muted-foreground">
              {bead.assignee}
            </span>
          )}
        </div>
        <h2 className="text-base font-semibold leading-snug">{bead.title}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setAssignOpen(true)}>
            <Icon name="Bot" className="size-4" />
            Assign agent
          </Button>
          <Button size="sm" variant="outline" onClick={copyId}>
            <Icon name="Copy" className="size-4" />
            Copy id
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
        {bead.labels.length === 0 ? null : (
          <div className="flex flex-wrap gap-1.5">
            {bead.labels.map((label) => (
              <Badge key={label} variant="outline">
                {label}
              </Badge>
            ))}
          </div>
        )}

        {bead.blockedBy.length === 0 ? null : (
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Blocked by
            </h3>
            <div className="flex flex-wrap gap-2">
              {bead.blockedBy.map((id) => (
                <button
                  key={id}
                  type="button"
                  className="font-mono text-xs text-primary underline-offset-4 hover:underline"
                  onClick={() => onSelect(id)}
                >
                  {id}
                </button>
              ))}
            </div>
          </section>
        )}

        {childBeads.length === 0 ? null : (
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Children ({childBeads.length})
            </h3>
            <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
              {childBeads.map((child) => (
                <li key={child.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-state-hover"
                    onClick={() => onSelect(child.id)}
                  >
                    <StatusGlyph status={child.status} />
                    <span className="shrink-0 font-mono text-[0.65rem] text-muted-foreground">
                      {child.id}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {child.title}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : detail === null ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : (
          <>
            <DetailSection title="Description" body={detail.description} />
            <DetailSection title="Design" body={detail.design} />
            <DetailSection
              title="Acceptance criteria"
              body={detail.acceptanceCriteria}
            />
            <DetailSection title="Notes" body={detail.notes} />
          </>
        )}

        <p className="text-xs text-muted-foreground">
          Created {shortDate(bead.createdAt)} · Updated{" "}
          {shortDate(bead.updatedAt)}
          {bead.closedAt === null ? null : ` · Closed ${shortDate(bead.closedAt)}`}
        </p>
      </div>

      <AssignAgentDialog
        bead={bead}
        open={assignOpen}
        onOpenChange={setAssignOpen}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The Beads section.
// ---------------------------------------------------------------------------

const EXPANDED_STORAGE_KEY = "vaam:beads:expanded";

/** The ids the user opened earlier in this browser session, else none. */
function readExpanded(): ReadonlySet<string> {
  try {
    const raw = window.sessionStorage.getItem(EXPANDED_STORAGE_KEY);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

function writeExpanded(expanded: ReadonlySet<string>): void {
  try {
    window.sessionStorage.setItem(
      EXPANDED_STORAGE_KEY,
      JSON.stringify([...expanded]),
    );
  } catch {
    // Storage can be full or blocked; the tree still works without it.
  }
}

function BeadsSection({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [includeClosed, setIncludeClosed] = useState(false);
  const [query, setQuery] = useState("");
  const [statuses, setStatuses] = useState<ReadonlySet<FilterableStatus>>(
    new Set(),
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(readExpanded);
  const isCompact = useIsCompactViewport();
  const { beads, error, loading, refresh } = useBeads(includeClosed);

  // Every node starts collapsed. What the user opens is kept for the browser
  // session, so leaving the page and coming back restores the same tree.
  useEffect(() => {
    writeExpanded(expanded);
  }, [expanded]);

  // A deep link must reveal its bead, so open every ancestor on the path.
  useEffect(() => {
    if (beads === null || selectedId === null) return;
    const ancestors = pathToBead(beads, selectedId).slice(0, -1);
    if (ancestors.length === 0) return;
    setExpanded((current) => {
      if (ancestors.every((id) => current.has(id))) return current;
      return new Set([...current, ...ancestors]);
    });
  }, [beads, selectedId]);

  const visible = useMemo(() => {
    if (beads === null) return [];
    const needle = query.trim().toLowerCase();
    return beads.filter((bead) => {
      if (statuses.size > 0) {
        const status = bead.status as FilterableStatus;
        if (!statuses.has(status)) return false;
      }
      if (needle === "") return true;
      return (
        bead.title.toLowerCase().includes(needle) ||
        bead.id.toLowerCase().includes(needle)
      );
    });
  }, [beads, query, statuses]);

  const tree = useMemo(() => buildBeadTree(visible), [visible]);
  const selected = useMemo(
    () => beads?.find((bead) => bead.id === selectedId) ?? null,
    [beads, selectedId],
  );
  const selectedChildren = useMemo(
    () =>
      selectedId === null
        ? []
        : (beads ?? []).filter((bead) => bead.parentId === selectedId),
    [beads, selectedId],
  );

  const toggle = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const toggleStatus = useCallback((status: FilterableStatus) => {
    setStatuses((current) => {
      const next = new Set(current);
      if (!next.delete(status)) next.add(status);
      return next;
    });
  }, []);

  const showDetailOnly = isCompact && selected !== null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {showDetailOnly ? null : (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <div className="relative min-w-[10rem] flex-1">
            <Icon
              name="Search"
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by title or id"
              aria-label="Filter beads"
              className="h-9 pl-8 text-sm"
            />
          </div>
          {FILTERABLE_STATUSES.map((status) => (
            <Button
              key={status}
              size="sm"
              variant="ghost"
              aria-pressed={statuses.has(status)}
              className="h-9 border border-border px-3 text-xs"
              onClick={() => toggleStatus(status)}
            >
              {STATUS_LABEL[status]}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={includeClosed}
            className="h-9 border border-border px-3 text-xs"
            onClick={() => setIncludeClosed((value) => !value)}
          >
            Show closed
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-9"
            aria-label="Refresh beads"
            onClick={refresh}
          >
            <Icon name="ArrowReloadHorizontal" className="size-4" />
          </Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {showDetailOnly ? null : (
          <div
            className={cn(
              "min-h-0 overflow-y-auto px-3 py-3",
              "md:w-[24rem] md:shrink-0 md:border-r md:border-border lg:w-[30rem]",
              selected === null ? "flex-1" : "flex-1 md:flex-none",
            )}
          >
            {error !== null ? (
              <p role="alert" className="p-2 text-sm text-destructive">
                {error}
              </p>
            ) : beads === null ? (
              <div className="space-y-2 p-2">
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-5/6" />
                <Skeleton className="h-5 w-4/6" />
              </div>
            ) : tree.length === 0 ? (
              <div className="p-2">
                <EmptyState>No beads match this filter.</EmptyState>
              </div>
            ) : (
              <>
                {tree.map((node) => (
                  <BeadRow
                    key={node.bead.id}
                    node={node}
                    depth={0}
                    selectedId={selectedId}
                    expanded={expanded}
                    onToggle={toggle}
                    onSelect={onSelect}
                  />
                ))}
                <p className="px-3 py-4 text-xs text-muted-foreground">
                  {visible.length} of {beads.length} beads
                  {loading ? " · refreshing…" : ""}
                </p>
              </>
            )}
          </div>
        )}

        <div
          className={cn(
            "min-h-0 flex-1 overflow-hidden",
            // On a compact viewport an empty detail slot must not take height
            // from the tree; it is only mounted once a bead is selected.
            selected === null && "hidden md:block",
          )}
        >
          {selected === null ? (
            <div className="flex h-full items-center justify-center p-6">
              <EmptyState>Select a bead to see its detail.</EmptyState>
            </div>
          ) : (
            <BeadDetailPane
              bead={selected}
              childBeads={selectedChildren}
              onSelect={onSelect}
              onBack={isCompact ? () => onSelect(null) : null}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The panel: a section strip plus the active section. Beads is the only
// section today; the strip is where the next one lands.
// ---------------------------------------------------------------------------

const SECTIONS = [{ id: "beads", title: "Beads" }] as const;

function VaamPanel({ subPath }: PluginNavPanelProps) {
  const [route, navigate] = useSubPathRoute(subPath);
  const select = useCallback(
    (beadId: string | null) => navigate({ section: "beads", beadId }),
    [navigate],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label="Vaam sections"
        className="flex items-center gap-1 border-b border-border px-4 py-2.5"
      >
        {SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            role="tab"
            aria-selected={route.section === section.id}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm",
              route.section === section.id
                ? "bg-state-active font-medium"
                : "text-muted-foreground hover:bg-state-hover",
            )}
          >
            {section.title}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        <BeadsSection selectedId={route.beadId} onSelect={select} />
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "vaam",
    title: "Vaam",
    icon: "Layers",
    path: PANEL_PATH,
    component: VaamPanel,
  });
});
