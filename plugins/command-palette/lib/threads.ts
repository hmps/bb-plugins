/**
 * Thread mapping for the palette, as pure functions.
 *
 * The server holds no state of its own: every field here is derived from a bb
 * thread row, the project list, and the lifecycle rows the t3sidebar plugin
 * owns. Keeping the derivation pure keeps it testable without a host.
 */

/** The subset of bb's thread row the palette reads. */
export interface SourceThread {
  id: string;
  title: string | null;
  titleFallback: string | null;
  projectId: string;
  updatedAt: number;
  latestAttentionAt: number;
  lastReadAt: number | null;
  pinnedAt: number | null;
  archivedAt: number | null;
  visibility: "hidden" | "visible";
}

/** A lifecycle row as the t3sidebar plugin reports it. */
export interface LifecycleRow {
  threadId: string;
  settledAt: number | null;
  snoozedUntil: number | null;
}

export interface PaletteThread {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  updatedAt: number;
  isPinned: boolean;
  isUnread: boolean;
  settled: boolean;
  snoozedUntil: number | null;
}

const UNTITLED = "Untitled thread";

/** A thread the palette shows: not archived, not hidden. */
export function isListable(thread: SourceThread): boolean {
  return thread.archivedAt === null && thread.visibility === "visible";
}

/** bb reports attention separately from the read mark. */
function isUnread(thread: SourceThread): boolean {
  return thread.lastReadAt === null || thread.lastReadAt < thread.latestAttentionAt;
}

/** Map bb rows onto palette rows, newest first. */
export function toPaletteThreads(
  threads: readonly SourceThread[],
  projectNames: ReadonlyMap<string, string>,
  lifecycle: readonly LifecycleRow[],
): PaletteThread[] {
  const byThread = new Map(lifecycle.map((row) => [row.threadId, row]));
  return threads
    .filter(isListable)
    .map((thread) => {
      const row = byThread.get(thread.id);
      return {
        id: thread.id,
        title: thread.title ?? thread.titleFallback ?? UNTITLED,
        projectId: thread.projectId,
        projectName: projectNames.get(thread.projectId) ?? "",
        updatedAt: thread.updatedAt,
        isPinned: thread.pinnedAt !== null,
        isUnread: isUnread(thread),
        settled: row?.settledAt != null,
        snoozedUntil: row?.snoozedUntil ?? null,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** What cmdk matches a typed query against. */
export function searchValue(thread: PaletteThread): string {
  return `${thread.title} ${thread.projectName}`.trim();
}
