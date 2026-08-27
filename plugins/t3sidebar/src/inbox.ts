import type { PluginSidebarThread } from "@get-bb/plugin-sdk";

/**
 * The sort that defines this sidebar: newest thread on top, and NOTHING moves
 * it afterwards. Activity never re-orders the list, so a row holds its place
 * from creation until you park it and the screen only changes when you act.
 * Status is carried by the card, not by position.
 *
 * Ties break on id so the order is total and stable across renders.
 */
export function sortByCreatedAtDescending<
  T extends { readonly id: string; readonly createdAt: number },
>(threads: readonly T[]): T[] {
  return [...threads].sort(
    (left, right) =>
      right.createdAt - left.createdAt || left.id.localeCompare(right.id),
  );
}

/** Setting key, defined in server.ts and read with `useSettings`. */
export const ATTENTION_FIRST_SETTING = "attentionFirst";

/**
 * Agent work in progress, which blocks parking and wakes a parked thread.
 *
 * `activity.backgroundCommands` is deliberately NOT part of this. A background
 * command is a detached process the agent left behind — a dev server, a
 * watcher, a test run — and it outlives the turn that started it. Worse, a
 * command that never reports completion leaves the count stuck above zero on
 * an idle thread forever. Either way it says nothing about whether the agent
 * is working, and `descendantSignals` would then pin the whole branch above it
 * as "working" for good. The other counts all end with the turn.
 */
export function isWorking(thread: PluginSidebarThread): boolean {
  const { activity } = thread;
  return (
    activity.workflows > 0 ||
    activity.backgroundAgents > 0 ||
    activity.planMode > 0 ||
    activity.goals > 0 ||
    thread.indicator === "runtime" ||
    thread.indicator === "working-draft"
  );
}

/** Realtime channel that carries one `{ threadId, count }` per queue change. */
export const QUEUE_CHANNEL = "queue";

export interface QueueCountSignal {
  threadId: string;
  count: number;
}

/** Setting key for the Working shelf, defined in server.ts. */
export const WORKING_SHELF_SETTING = "workingShelf";

/** Live work and raised hands somewhere below one thread in the tree. */
export interface DescendantSignal {
  working: number;
  needsYou: number;
}

/**
 * What each thread's descendants are doing, rolled up to every ancestor.
 *
 * The flat list hides a child whose parent is on screen, so without this a
 * parent that is only waiting for its child reads as idle. A grandchild counts
 * for every ancestor above it: the user watches the row that is on screen, and
 * that row is the root of the whole branch.
 *
 * Feed this the FULL thread list, not the project-scoped one — a child spawned
 * into another project still works for its parent.
 *
 * Archived threads contribute nothing; the parent chain still runs through
 * them, so an archived middle thread does not cut a live grandchild off from
 * the ancestor the user can actually see.
 */
export function descendantSignals(
  threads: readonly PluginSidebarThread[],
): ReadonlyMap<string, DescendantSignal> {
  const parentIdOf = new Map<string, string | null>(
    threads.map((thread) => [thread.id, thread.parentThreadId]),
  );
  const signals = new Map<string, DescendantSignal>();
  for (const thread of threads) {
    if (thread.isArchived) continue;
    const working = isWorking(thread) ? 1 : 0;
    const needsYou = thread.hasPendingInteraction ? 1 : 0;
    if (working === 0 && needsYou === 0) continue;
    // `seen` guards a cyclic parent chain: bad data must not hang the render.
    const seen = new Set<string>([thread.id]);
    let ancestorId = parentIdOf.get(thread.id) ?? null;
    while (ancestorId !== null && !seen.has(ancestorId)) {
      seen.add(ancestorId);
      const total = signals.get(ancestorId) ?? { working: 0, needsYou: 0 };
      total.working += working;
      total.needsYou += needsYou;
      signals.set(ancestorId, total);
      ancestorId = parentIdOf.get(ancestorId) ?? null;
    }
  }
  return signals;
}

/**
 * The signals below are tree-aware: they read the thread AND everything under
 * it. Omit `signals` and they fall back to the thread alone, which is what a
 * caller that has no tree in hand wants.
 */
export function isWorkingTree(
  thread: PluginSidebarThread,
  signals?: ReadonlyMap<string, DescendantSignal>,
): boolean {
  return isWorking(thread) || (signals?.get(thread.id)?.working ?? 0) > 0;
}

/** A raised hand on the thread itself or on anything below it. */
export function needsYouTree(
  thread: PluginSidebarThread,
  signals?: ReadonlyMap<string, DescendantSignal>,
): boolean {
  return (
    thread.hasPendingInteraction || (signals?.get(thread.id)?.needsYou ?? 0) > 0
  );
}

/**
 * Whether a thread belongs on the Working shelf: live work that does not need
 * the user. A raised hand outranks the work behind it, so a working thread
 * that is also blocked on you stays in the inbox where you will see it.
 *
 * A parent waiting on a working child counts as working: the branch is live,
 * and the parent row is the only place the user can see it.
 */
export function isOnWorkingShelf(
  thread: PluginSidebarThread,
  signals?: ReadonlyMap<string, DescendantSignal>,
): boolean {
  return isWorkingTree(thread, signals) && !needsYouTree(thread, signals);
}

/**
 * Urgency tiers for the "needs attention first" setting. Lower comes first:
 * a raised hand, then a finished result you have not read, then live work,
 * then everything you have already read.
 */
export function attentionRank(
  thread: PluginSidebarThread,
  signals?: ReadonlyMap<string, DescendantSignal>,
): number {
  if (needsYouTree(thread, signals)) return 0;
  if (thread.isUnread) return 1;
  if (isWorkingTree(thread, signals)) return 2;
  return 3;
}

/**
 * The one opt-in exception to the static order: sort by urgency tier and keep
 * the incoming order inside each tier. With the static sort applied first
 * this is newest-first inside every tier.
 */
export function attentionFirst(
  threads: readonly PluginSidebarThread[],
  signals?: ReadonlyMap<string, DescendantSignal>,
): PluginSidebarThread[] {
  return threads
    .map((thread, index) => ({
      thread,
      index,
      rank: attentionRank(thread, signals),
    }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.thread);
}

export function threadDisplayTitle(thread: PluginSidebarThread): string {
  const title = thread.title?.trim();
  if (title) return title;
  const fallback = thread.titleFallback?.trim();
  return fallback ? fallback : "Untitled thread";
}

/** Substring match on the visible title only, preserving the incoming order. */
export function searchThreadsByTitle(
  threads: readonly PluginSidebarThread[],
  query: string,
): PluginSidebarThread[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return [...threads];
  return threads.filter((thread) =>
    threadDisplayTitle(thread).toLowerCase().includes(normalized),
  );
}

export interface ProjectScope {
  /** Project id, or null for "all projects". */
  id: string | null;
  name: string;
}

/** Threads in the chosen scope; every thread when the scope is null. */
export function filterByProject(
  threads: readonly PluginSidebarThread[],
  projectId: string | null,
): PluginSidebarThread[] {
  if (projectId === null) return [...threads];
  return threads.filter((thread) => thread.projectId === projectId);
}

/** Archived threads never belong in the inbox. */
export function visibleInboxThreads(
  threads: readonly PluginSidebarThread[],
): PluginSidebarThread[] {
  return threads.filter((thread) => !thread.isArchived);
}

/** Pinned first (they are the user's own ordering), then the static sort. */
export function partitionPinned(threads: readonly PluginSidebarThread[]): {
  pinned: PluginSidebarThread[];
  inbox: PluginSidebarThread[];
} {
  const pinned: PluginSidebarThread[] = [];
  const inbox: PluginSidebarThread[] = [];
  for (const thread of threads) {
    (thread.isPinned ? pinned : inbox).push(thread);
  }
  return { pinned, inbox };
}

/**
 * Child threads leave the flat list and live in their parent's header chip
 * instead — a flat inbox has nowhere to nest them.
 *
 * A child is only hidden when its parent is actually on screen. An orphan
 * (parent archived, deleted, or filtered out by the project scope) stays in
 * the list, because hiding it would make it unreachable everywhere.
 */
export function hideChildrenOfVisibleParents(
  threads: readonly PluginSidebarThread[],
): PluginSidebarThread[] {
  const visibleIds = new Set(threads.map((thread) => thread.id));
  return threads.filter(
    (thread) =>
      thread.parentThreadId === null || !visibleIds.has(thread.parentThreadId),
  );
}

/**
 * The parent of one thread, or null when the thread is a root, when the id is
 * unknown, or when the parent row is gone (deleted). The parent may be
 * archived or in another project: the flat list hides those, but the child
 * still needs a way back to them.
 */
export function parentOf(
  threads: readonly PluginSidebarThread[],
  threadId: string,
): PluginSidebarThread | null {
  const thread = threads.find((candidate) => candidate.id === threadId);
  const parentThreadId = thread?.parentThreadId;
  if (!parentThreadId) return null;
  return threads.find((candidate) => candidate.id === parentThreadId) ?? null;
}

/** The children of one thread, oldest first (the order they were spawned). */
export function childrenOf(
  threads: readonly PluginSidebarThread[],
  parentThreadId: string,
): PluginSidebarThread[] {
  return threads
    .filter((thread) => thread.parentThreadId === parentThreadId)
    .sort((left, right) => left.createdAt - right.createdAt);
}
