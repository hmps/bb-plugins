// bb-plugin-starbase — the frontend bundle.
//
// The Mission Queue as a read-only board, in two places:
//   - a "Starbase" nav panel, "All projects" by default; the picked project
//     lives in the route's subPath, so back/forward walks the picks;
//   - a "Starbase board" thread panel tab, scoped to the thread's Command
//     project. A pick made on a Commander is saved for it.
// The server builds every column from a warm snapshot of the Starbase SITREP;
// this file only renders them. One card is one SITREP row: a mission, or a
// Crew thread that no mission bead claims. The board never writes.
import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRpc,
  type PluginNavPanelProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { BoardCard, BoardColumn, ColumnId } from "./board.js";
import type { MissionTone } from "./mission.js";
import type { starbaseRpcContract } from "./server.js";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Skeleton } from "./components/ui/skeleton";
import { cn } from "./lib/utils";

const PANEL_PATH = "starbase";
const ALL = "all";
/** How often an open board asks again. The server answers from its snapshot. */
const AUTO_REFRESH_MS = 30_000;
/** How soon to ask again while the server reads a newer snapshot. */
const FOLLOW_UP_MS = 2_000;
/** How many Done cards show before "Show all". */
const DONE_PREVIEW = 20;

/** SITREP row flags in words. A flag not named here shows as written. */
const FLAG_LABELS: Record<string, string> = {
  "needs-input": "Needs input",
  "thread-failed": "Thread failed",
  "thread-gone": "Thread gone",
  "bb-error": "bb error",
  "bb-unreachable": "bb unreachable",
  "forge-error": "Forge error",
  "source-error": "Source error",
  "bead-without-thread": "No thread",
  "thread-without-bead": "No mission bead",
};

const ATTENTION_LABELS: Record<string, string> = {
  decision: "Decision",
  blocker: "Blocker",
  "verification-failed": "Verification failed",
};

/** The dot before a card's stage. Only `alert` is a strong color. */
const TONE_DOTS: Record<MissionTone, string> = {
  alert: "bg-amber-500",
  warn: "bg-violet-500",
  working: "bg-primary",
  waiting: "bg-muted-foreground/40",
  quiet: "bg-emerald-500",
};

/**
 * The narrow (stacked) layout puts what needs the user first. The wide layout
 * keeps the server's left-to-right order.
 */
const NARROW_ORDER: Record<ColumnId, string> = {
  waiting: "order-1",
  blocked: "order-2",
  progress: "order-3",
  review: "order-4",
  deploy: "order-5",
  done: "order-6",
};

/** Columns that start collapsed in the narrow layout. */
const COLLAPSED_WHEN_NARROW = new Set<ColumnId>(["done"]);

const COLUMN_DOTS: Record<ColumnId, string> = {
  progress: "bg-primary",
  waiting: "bg-amber-500",
  blocked: "bg-destructive",
  review: "bg-violet-500",
  deploy: "bg-sky-500",
  done: "bg-emerald-500",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** "5m", "3h", "2d" since a time; "" when it does not parse. */
function age(value: string | number | null, now: number): string {
  if (value === null) return "";
  const time = typeof value === "number" ? value : Date.parse(value);
  if (Number.isNaN(time)) return "";
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

type SourceState = "current" | "partial" | "stale" | "unavailable";

interface BoardData {
  project: string;
  generatedAt: number;
  refreshing: boolean;
  source: SourceState;
  error: string | null;
  projects: string[];
  columns: BoardColumn[];
}

interface ScopeData {
  scope: string | null;
  source: "commander" | "saved" | "posture" | "unresolved";
  commanderId: string | null;
  canSave: boolean;
  projects: string[];
}

interface PanelData {
  scope: ScopeData;
  board: BoardData | null;
}

/**
 * Load `key`'s data, again every AUTO_REFRESH_MS, and again shortly while the
 * server reports that it reads a newer snapshot. `refresh` forces a new read.
 * `data` is null until the current key has answered; `last` is the latest
 * answer for any key, for the parts of the view that may lag a pick.
 */
function useLive<T>(
  key: string | null,
  load: (force: boolean) => Promise<T>,
  refreshing: (data: T) => boolean,
) {
  const loadRef = useRef(load);
  loadRef.current = load;
  const refreshingRef = useRef(refreshing);
  refreshingRef.current = refreshing;
  const [answer, setAnswer] = useState<{ key: string; data: T } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [request, setRequest] = useState(0);
  /** Set by `refresh`; the next load forces a new read, and only that one. */
  const forceNext = useRef(false);
  const again = useCallback(() => setRequest((count) => count + 1), []);

  useEffect(() => {
    if (key === null) return;
    const timer = setInterval(again, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [key, again]);

  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    let followUp: ReturnType<typeof setTimeout> | undefined;
    const force = forceNext.current;
    forceNext.current = false;
    setLoading(true);
    loadRef.current(force).then(
      (data) => {
        if (cancelled) return;
        setAnswer({ key, data });
        setError(null);
        setLoading(false);
        if (refreshingRef.current(data)) {
          followUp = setTimeout(again, FOLLOW_UP_MS);
        }
      },
      (cause: unknown) => {
        if (cancelled) return;
        setError(errorText(cause));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
      clearTimeout(followUp);
    };
  }, [key, request, again]);

  const refresh = useCallback(() => {
    forceNext.current = true;
    again();
  }, [again]);
  return {
    data: answer !== null && answer.key === key ? answer.data : null,
    last: answer?.data ?? null,
    error,
    loading,
    refresh,
  };
}

function ProjectPicker(props: {
  projects: readonly string[];
  value: string | null;
  onChange: (project: string) => void;
}) {
  return (
    <select
      aria-label="Project"
      className="h-8 min-w-0 max-w-full rounded-md border border-input bg-transparent px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      value={props.value ?? ""}
      onChange={(event) => props.onChange(event.target.value)}
    >
      {props.value === null ? (
        <option value="" disabled>
          Pick a project
        </option>
      ) : null}
      <option value={ALL}>All projects</option>
      {props.projects.map((slug) => (
        <option key={slug} value={slug}>
          {slug}
        </option>
      ))}
    </select>
  );
}

function Freshness(props: { board: BoardData | null }) {
  const { board } = props;
  if (board === null) return null;
  const ago = age(board.generatedAt, Date.now());
  const when = ago === "0m" ? "just now" : `${ago} ago`;
  // Old rows never read as a fresh update.
  const label = board.refreshing
    ? "Updating…"
    : board.source === "unavailable"
      ? `Tried ${when}`
      : board.source === "stale"
        ? `Last good read ${when}`
        : `Updated ${when}`;
  return <span className="text-xs text-muted-foreground">{label}</span>;
}

function Toolbar(props: {
  children: ReactNode;
  board: BoardData | null;
  onRefresh?: () => void;
  loading: boolean;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      {props.children}
      <div className="flex-1" />
      <Freshness board={props.board} />
      {props.onRefresh === undefined ? null : (
        <Button
          variant="ghost"
          size="sm"
          onClick={props.onRefresh}
          disabled={props.loading}
          aria-label="Refresh"
        >
          {props.loading ? "Loading…" : "Refresh"}
        </Button>
      )}
    </div>
  );
}

const SOURCE_NOTES: Record<Exclude<SourceState, "current">, string> = {
  partial:
    "A source failed during the last SITREP run. Some cards may be incomplete.",
  stale:
    "The last SITREP run failed. These cards are from the last good read and may be out of date.",
  unavailable:
    "No SITREP run has given missions yet. The missions are unknown, not empty.",
};

/** How far to trust the board, shown in the page, never as a notification. */
function SourceNotice(props: { board: BoardData }) {
  const { board } = props;
  if (board.source === "current") return null;
  return (
    <div
      role="status"
      className={cn(
        "mx-3 mt-3 rounded-md border px-3 py-2 text-xs",
        board.source === "unavailable"
          ? "border-destructive/40 text-destructive"
          : "border-amber-500/40 text-foreground",
      )}
    >
      <div className="font-medium">{SOURCE_NOTES[board.source]}</div>
      {board.error === null ? null : (
        <div className="mt-0.5 break-words text-muted-foreground">
          {board.error}
        </div>
      )}
    </div>
  );
}

function Message(props: { children: ReactNode; tone?: "error" }) {
  return (
    <div
      className={cn(
        "px-3 py-6 text-center text-sm",
        props.tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {props.children}
    </div>
  );
}

/** An arrow out of a box: "open elsewhere". */
function OpenIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V13H3V5h3.5" />
    </svg>
  );
}

function CardView(props: { card: BoardCard; showProject: boolean }) {
  const { card } = props;
  const navigate = useBbNavigate();
  const [open, setOpen] = useState(false);
  const openPr = (event: MouseEvent<HTMLAnchorElement>) => {
    if (card.pr !== null && navigate.openUrl(card.pr.url))
      event.preventDefault();
  };
  const details: [string, string | null][] = [
    ["Outcome", card.outcome],
    ["Note", card.note],
    ["Thread status", card.threadStatus],
  ];
  return (
    <div className="rounded-md border border-border bg-background text-sm">
      <button
        type="button"
        className="flex w-full flex-col gap-1 px-2.5 pt-2 pb-1.5 text-left hover:bg-state-hover"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate font-mono">{card.id}</span>
          <span className="shrink-0">{card.mission ?? "no bead"}</span>
          {props.showProject ? (
            <span className="truncate">{card.project}</span>
          ) : null}
        </div>
        <div className="break-words font-medium text-foreground">
          {card.title || "(untitled)"}
        </div>
        <div className="flex items-start gap-1.5 text-xs text-foreground">
          <span
            aria-hidden="true"
            className={cn(
              "mt-1 size-1.5 shrink-0 rounded-full",
              TONE_DOTS[card.tone],
            )}
          />
          <span className="break-words">{card.stage}</span>
        </div>
        {card.nextAction === null ? null : (
          <div
            className={cn(
              "break-words text-xs text-foreground",
              !open && "line-clamp-2",
            )}
          >
            <span className="text-muted-foreground">Next: </span>
            {card.nextAction}
          </div>
        )}
        <div className="break-words text-xs text-muted-foreground">
          {card.owner === null
            ? "No owner"
            : `Owner: ${card.owner}${card.ownerIdle ? " · idle" : ""}`}
        </div>
      </button>
      {card.attention.length === 0 ? null : (
        <ul className="flex flex-col gap-1 px-2.5 pb-1.5 text-xs">
          {card.attention.map((event, index) => (
            <li key={index} className="break-words text-foreground">
              <span className="font-medium">
                {ATTENTION_LABELS[event.kind] ?? event.kind}
              </span>
              {event.surfaced ? (
                <span className="text-muted-foreground"> · seen</span>
              ) : null}
              <span className="text-muted-foreground">: </span>
              {event.summary}
            </li>
          ))}
        </ul>
      )}
      {(card.pr !== null ||
        card.integrity !== null ||
        card.flags.length > 0 ||
        card.threadId !== null) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 pb-2 text-xs">
          {card.integrity === null ? null : (
            <Badge
              variant="outline"
              className="px-1.5 py-0 text-[11px] font-medium text-foreground"
            >
              {card.integrity}
            </Badge>
          )}
          {card.pr === null ? null : (
            <a
              href={card.pr.url}
              target="_blank"
              rel="noreferrer"
              onClick={openPr}
              className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              PR · {card.pr.state}
            </a>
          )}
          {card.flags.map((flag) => (
            <Badge
              key={flag}
              variant="outline"
              className="px-1.5 py-0 text-[11px] font-medium text-muted-foreground"
            >
              {FLAG_LABELS[flag] ?? flag}
            </Badge>
          ))}
          {card.threadId === null ? null : (
            <button
              type="button"
              className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-state-hover hover:text-foreground"
              title="Open thread"
              aria-label="Open thread"
              onClick={() => navigate.toThread(card.threadId as string)}
            >
              <OpenIcon />
            </button>
          )}
        </div>
      )}
      {open ? (
        <div className="flex flex-col gap-1.5 border-t border-border px-2.5 py-2 text-xs">
          <div>
            <span className="text-muted-foreground">Problems: </span>
            {card.problems.length === 0 ? (
              <span className="text-foreground">—</span>
            ) : (
              <ul className="mt-0.5 list-disc pl-4 text-foreground">
                {card.problems.map((problem, index) => (
                  <li key={index} className="break-words">
                    {problem}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {details.map(([label, value]) => (
            <div key={label}>
              <span className="text-muted-foreground">{label}: </span>
              <span className="whitespace-pre-wrap break-words text-foreground">
                {value ?? "—"}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ColumnView(props: { column: BoardColumn; showProject: boolean }) {
  const { column } = props;
  const collapsible = COLLAPSED_WHEN_NARROW.has(column.id);
  const [collapsed, setCollapsed] = useState(collapsible);
  const [showAll, setShowAll] = useState(false);
  const preview = column.id === "done" && !showAll;
  const cards = preview ? column.cards.slice(0, DONE_PREVIEW) : column.cards;
  const hidden = column.cards.length - cards.length;
  const unsent = column.total - column.cards.length;
  const heading = (
    <>
      <span className={cn("size-2 rounded-full", COLUMN_DOTS[column.id])} />
      {column.title}
      <span className="font-normal">{column.total}</span>
    </>
  );
  const headingClass =
    "flex items-center gap-2 px-0.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground";
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col gap-2 @2xl:order-none @2xl:w-72 @2xl:shrink-0",
        NARROW_ORDER[column.id],
      )}
    >
      {collapsible ? (
        <h2>
          <button
            type="button"
            className={cn(headingClass, "w-full hover:text-foreground")}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
          >
            {heading}
            <span className="ml-auto font-normal normal-case @2xl:hidden">
              {collapsed ? "Show" : "Hide"}
            </span>
          </button>
        </h2>
      ) : (
        <h2 className={headingClass}>{heading}</h2>
      )}
      {/* Collapsing only applies to the narrow layout. */}
      <div
        className={cn(
          "flex-col gap-2 @2xl:flex",
          collapsed ? "hidden" : "flex",
        )}
      >
        {cards.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-2.5 py-3 text-xs text-muted-foreground">
            Empty
          </div>
        ) : (
          cards.map((card) => (
            <CardView
              key={card.id}
              card={card}
              showProject={props.showProject}
            />
          ))
        )}
        {hidden > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
            Show all {column.cards.length}
          </Button>
        ) : null}
        {!preview && unsent > 0 ? (
          <div className="px-0.5 text-xs text-muted-foreground">
            {unsent} more not shown
          </div>
        ) : null}
      </div>
    </section>
  );
}

function BoardView(props: { board: BoardData | null; error: string | null }) {
  const { board } = props;
  if (board === null) {
    if (props.error !== null) {
      return <Message tone="error">{props.error}</Message>;
    }
    return (
      <div className="flex flex-col gap-2 p-3">
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      {props.error === null ? null : (
        <Message tone="error">{props.error}</Message>
      )}
      <SourceNotice board={board} />
      {/* With no rows, empty columns would read as an empty queue. */}
      {board.source === "unavailable" ? null : (
        <div className="flex flex-col gap-4 p-3 @2xl:flex-row @2xl:items-start">
          {board.columns.map((column) => (
            <ColumnView
              key={column.id}
              column={column}
              showProject={board.project === ALL}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function StarbasePanel({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof starbaseRpcContract>();
  const navigate = useBbNavigate();
  const project = subPath === "" ? ALL : subPath.split("/")[0];
  const live = useLive<BoardData>(
    project,
    (force) => rpc.call("board", { project, force }) as Promise<BoardData>,
    (board) => board.refreshing,
  );
  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <Toolbar
        board={live.data}
        onRefresh={live.refresh}
        loading={live.loading}
      >
        <h1 className="text-sm font-semibold">Mission Queue</h1>
        <ProjectPicker
          projects={live.last?.projects ?? []}
          value={project}
          onChange={(next) =>
            navigate.toPluginPanel(PANEL_PATH, {
              subPath: next === ALL ? "" : next,
            })
          }
        />
      </Toolbar>
      <BoardView board={live.data} error={live.error} />
    </div>
  );
}

const SOURCE_LABELS: Record<ScopeData["source"], string> = {
  commander: "from this Commander's Crew",
  saved: "saved for this Commander",
  posture: "from this thread's project",
  unresolved: "",
};

function ThreadBoard({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof starbaseRpcContract>();
  const [picked, setPicked] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // One round trip gives the scope and its board together.
  const live = useLive<PanelData>(
    picked ?? "",
    (force) =>
      rpc.call("panel", {
        threadId,
        ...(picked === null ? {} : { project: picked }),
        force,
      }) as Promise<PanelData>,
    (panel) => panel.board?.refreshing === true,
  );
  const scope = live.last?.scope ?? null;
  const project = picked ?? scope?.scope ?? null;

  const pick = (next: string) => {
    setPicked(next);
    if (scope?.canSave === true) {
      rpc
        .call("saveScope", { threadId, project: next })
        .catch((cause: unknown) => {
          setSaveError(errorText(cause));
        });
    }
  };

  const board = live.data?.board ?? null;
  const note =
    picked === null && scope !== null ? SOURCE_LABELS[scope.source] : "";
  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <Toolbar board={board} onRefresh={live.refresh} loading={live.loading}>
        <ProjectPicker
          projects={live.last?.board?.projects ?? scope?.projects ?? []}
          value={project}
          onChange={pick}
        />
        {note === "" ? null : (
          <span className="text-xs text-muted-foreground">{note}</span>
        )}
      </Toolbar>
      {saveError === null ? null : <Message tone="error">{saveError}</Message>}
      {live.data !== null && project === null ? (
        <Message>Pick a project to show its missions.</Message>
      ) : (
        <BoardView board={board} error={live.error} />
      )}
    </div>
  );
}

/** A new thread starts over: no pick, no answer. */
function ThreadBoardPanel({ threadId }: PluginThreadPanelProps) {
  return <ThreadBoard key={threadId} threadId={threadId} />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "starbase",
    title: "Starbase",
    icon: "Columns2",
    path: PANEL_PATH,
    component: StarbasePanel,
  });
  app.slots.threadPanelAction({
    id: "board",
    title: "Starbase board",
    icon: "Columns2",
    layout: "flush",
    component: ThreadBoardPanel,
  });
});
