import {
  experimental_useSidebarThreadPullRequest as useSidebarThreadPullRequest,
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  type PluginSidebarPullRequest,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { Icon, type IconName } from "./components/Icon";
import { projectColor } from "./project-colors";
import { cn } from "./lib/utils";
import { RowContextMenu } from "./RowContextMenu";
import { ProviderGlyph } from "./ProviderGlyph";
import { STATUS_SLOT_CLASS, StatusOrTime } from "./StatusSlot";
import { threadDisplayTitle } from "./inbox";
import { resolveSnoozePresets } from "./lifecycle";

/** One look for every badge on the card's second line — project, counts,
    and PR — so the line reads as one set. Tabular digits keep counts from
    changing width as they tick. */
const BADGE_CLASS =
  "rounded px-1.5 text-[11px] leading-4 font-medium tabular-nums";

/**
 * One thread as a two-line card: title and status, then the project badge
 * and activity. The card is the whole point of this sidebar — status lives in the
 * row instead of in its position, which is what lets the list stay still.
 *
 * The row is a positioned container with a full-bleed anchor UNDER the
 * controls, the way bb's own thread row does it: a `<button>` inside an `<a>`
 * is invalid interactive nesting and breaks keyboard behaviour.
 */
export function ThreadCard({
  thread,
  projectName,
  projectColorId,
  isActive,
  canPark,
  onNavigate,
  onSettle,
  onSettleAndArchive,
  onSnooze,
  archiving = false,
  now,
  queuedMessages = 0,
  workingChildren = 0,
  childrenNeedYou = 0,
  spawnedChildren = 0,
}: {
  thread: PluginSidebarThread;
  projectName: string | null;
  /** Palette id the user gave the project; unknown or missing reads neutral. */
  projectColorId?: string | null;
  isActive: boolean;
  /** False while the thread is working or blocked on the user. */
  canPark: boolean;
  onNavigate: () => void;
  onSettle: () => void;
  onSettleAndArchive: () => void;
  onSnooze: (snoozedUntil: number) => void;
  /** A settle-and-archive is in flight: show progress and take no input. */
  archiving?: boolean;
  /** Quantized clock, so every card in one render agrees on "now". */
  now: number;
  /** Messages waiting in the thread's queue; zero draws nothing. */
  queuedMessages?: number;
  /** Descendants doing live work. The flat list hides them, so this row
      speaks for them: their count is a chip and their spinner fills an empty
      status slot. */
  workingChildren?: number;
  /** Descendants with a raised hand; they outrank their own work. */
  childrenNeedYou?: number;
  /** Child threads ever started below this thread, archived ones included;
      drawn with `workingChildren` as one "total (working)" badge. */
  spawnedChildren?: number;
}) {
  const actions = useSidebarThreadActions();
  const { splitProps, layout } = useSidebarThreadSplit(thread.id);
  // Opt-in per row: this costs a git-host lookup, and threads sharing a
  // worktree share one.
  const { pullRequest } = useSidebarThreadPullRequest(thread.id);

  const snoozeUntilTomorrow = () =>
    onSnooze(resolveSnoozePresets(new Date())[2]!.snoozedUntil);

  return (
    <RowContextMenu
      thread={thread}
      shelfItems={
        canPark && !archiving
          ? [
              { label: "Snooze until tomorrow", onSelect: snoozeUntilTomorrow },
              { label: "Settle", onSelect: onSettle },
              {
                label: "Settle and archive",
                onSelect: onSettleAndArchive,
              },
            ]
          : []
      }
    >
      <li className="list-none" aria-busy={archiving || undefined}>
        <div
          className={cn(
            // Each card is a box in the shelf's grid: a rule below every card, and
            // the shelf draws the outer edge.
            "group/card relative border-b border-sidebar-border px-4 py-3 transition-colors",
            isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
            // A thread open in another pane gets a weaker tint than the active
            // row, so the two states stay distinguishable.
            !isActive && layout !== null && "bg-sidebar-accent/30",
            // The whole card goes inert, so neither a second archive nor a
            // navigation to a thread on its way out can land.
            archiving && "pointer-events-none opacity-60",
          )}
        >
          <a
            // Both attributes, or bb's nine thread shortcuts stop finding rows.
            data-sidebar-thread-shortcut-target=""
            data-sidebar-thread-id={thread.id}
            href="#"
            aria-label={threadDisplayTitle(thread)}
            tabIndex={archiving ? -1 : undefined}
            {...splitProps}
            onClick={(event) => {
              event.preventDefault();
              actions.open(thread.id, {
                split: event.metaKey || event.ctrlKey,
              });
              onNavigate();
            }}
            className="absolute inset-0 cursor-pointer"
          />
          <div className="pointer-events-none relative flex min-h-5 items-center gap-1.5">
            <span
              className={cn(
                // Weight alone carries unread. Fading the title — or the whole
                // card — makes a thread at rest read as disabled, and at rest
                // is what most of the list is most of the time.
                "min-w-0 flex-1 truncate text-sm text-foreground",
                thread.isUnread && "font-medium",
              )}
            >
              {threadDisplayTitle(thread)}
            </span>
            {/* Status at rest, park actions on hover. Only the status yields,
                so the title never shifts. A touch screen has no hover, so
                there the buttons stay on and the status keeps its slot. */}
            {archiving ? (
              <span className={cn(STATUS_SLOT_CLASS, "relative")}>
                <Icon
                  name="Loading"
                  aria-label="Archiving thread"
                  className="size-3.5 animate-spin text-muted-foreground"
                />
              </span>
            ) : canPark ? (
              <span className="pointer-events-auto hidden items-center gap-0.5 group-hover/card:flex pointer-coarse:flex">
                <ParkButton
                  label="Snooze until tomorrow"
                  icon="Clock"
                  onActivate={snoozeUntilTomorrow}
                />
                <ParkButton
                  label="Settle and archive thread"
                  icon="Archive"
                  onActivate={onSettleAndArchive}
                />
                <ParkButton
                  label="Settle thread"
                  icon="Check"
                  onActivate={onSettle}
                />
              </span>
            ) : null}
            {archiving ? null : (
              <span
                className={cn(
                  STATUS_SLOT_CLASS,
                  canPark && "pointer-fine:group-hover/card:hidden",
                )}
              >
                <StatusOrTime
                  thread={thread}
                  now={now}
                  workingChildren={workingChildren}
                  childrenNeedYou={childrenNeedYou}
                />
              </span>
            )}
          </div>
          <div className="pointer-events-none relative mt-1.5 flex h-4 items-center gap-1.5 text-2xs text-muted-foreground">
            {/* The project, as a badge in the colour the user gave it: the row
                says which project it belongs to before it is read. The
                badge sits in a flexible cell, so the counts keep the right
                edge. */}
            <span className="flex min-w-0 flex-1">
              {projectName ? (
                <span
                  className={cn(
                    BADGE_CLASS,
                    "max-w-full truncate",
                    projectColor(projectColorId).badgeClass,
                  )}
                >
                  {projectName}
                </span>
              ) : null}
            </span>
            {thread.activity.workflows > 0 ? (
              <ActivityCount
                label="workflows"
                count={thread.activity.workflows}
              />
            ) : null}
            {thread.activity.backgroundAgents > 0 ? (
              <ActivityCount
                label="background agents"
                count={thread.activity.backgroundAgents}
              />
            ) : null}
            {queuedMessages > 0 ? (
              <ActivityCount
                label="queued messages"
                count={queuedMessages}
                icon="Queue"
              />
            ) : null}
            {pullRequest ? <PullRequestBadge pullRequest={pullRequest} /> : null}
            {spawnedChildren > 0 ? (
              <ChildrenCount
                total={spawnedChildren}
                working={workingChildren}
              />
            ) : null}
            {/* Always drawn, so the line has a fixed right edge. */}
            <ProviderGlyph providerId={thread.providerId} />
          </div>
        </div>
      </li>
    </RowContextMenu>
  );
}

function ParkButton({
  label,
  icon,
  onActivate,
}: {
  label: string;
  icon: Extract<IconName, "Clock" | "Check" | "Archive">;
  onActivate: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onActivate();
      }}
      className="rounded p-0.5 text-muted-foreground hover:text-foreground pointer-coarse:p-1.5"
    >
      <Icon name={icon} className="size-3.5" />
    </button>
  );
}

function ActivityCount({
  label,
  count,
  icon,
}: {
  label: string;
  count: number;
  /** A glyph in front of the number, so two counts on one line read apart. */
  icon?: Extract<IconName, "Queue">;
}) {
  return (
    <span
      aria-label={`${count} ${label}`}
      className={cn(BADGE_CLASS, "flex shrink-0 items-center gap-0.5 bg-muted text-muted-foreground")}
    >
      {icon ? <Icon name={icon} className="size-3" aria-hidden /> : null}
      {count}
    </span>
  );
}

/** Every child ever started, then the ones working now in brackets. */
function ChildrenCount({ total, working }: { total: number; working: number }) {
  return (
    <span
      aria-label={
        working > 0
          ? `${total} child agents, ${working} working`
          : `${total} child agents`
      }
      className={cn(BADGE_CLASS, "flex shrink-0 items-center gap-0.5 bg-muted text-muted-foreground")}
    >
      <Icon name="Bot" className="size-3" aria-hidden />
      {working > 0 ? `${total}(${working})` : total}
    </span>
  );
}

/** Icon and colour for a PR badge, keyed off state first, then attention. */
function pullRequestBadgeParts(
  pullRequest: PluginSidebarPullRequest,
): { icon: IconName; className: string } {
  if (pullRequest.state === "merged") {
    return {
      icon: "Merge",
      className: "bg-[color:var(--pr-merged)]/15 text-[color:var(--pr-merged)]",
    };
  }
  if (pullRequest.attention === "checks_failed" || pullRequest.attention === "conflicts") {
    return { icon: "Alert", className: "bg-destructive-text/15 text-destructive-text" };
  }
  if (pullRequest.attention === "ready_to_merge") {
    return { icon: "Check", className: "bg-success-foreground/15 text-success-foreground" };
  }
  return { icon: "PullRequest", className: "bg-muted text-muted-foreground" };
}

function PullRequestBadge({ pullRequest }: { pullRequest: PluginSidebarPullRequest }) {
  const { icon, className } = pullRequestBadgeParts(pullRequest);
  return (
    <a
      href={pullRequest.url}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => event.stopPropagation()}
      title={pullRequest.title}
      className={cn(
        BADGE_CLASS,
        "flex shrink-0 items-center gap-0.5 hover:underline",
        className,
      )}
    >
      <Icon name={icon} className="size-3" aria-hidden />
      {pullRequest.number}
    </a>
  );
}
