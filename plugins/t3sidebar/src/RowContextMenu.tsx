import type { ReactNode } from "react";
import {
  experimental_ThreadActionsContextMenu as ThreadActionsContextMenu,
  type PluginSidebarThread,
  type PluginThreadActionsInlineItem,
  type PluginThreadActionTarget,
} from "@get-bb/plugin-sdk/app";

/**
 * This sidebar's right-click and long-press menu: bb's own thread menu, so
 * split, read, pin, rename, archive, delete, and every plugin's thread
 * actions behave exactly as they do on bb's rows. Delete keeps bb's
 * confirmation rather than deleting a subtree silently.
 *
 * The row's shelf actions ride along as inline items.
 */
/** One shelf action for the menu: settle, snooze, wake, or un-settle. */
export interface RowMenuShelfItem {
  label: string;
  icon: string;
  onSelect: () => void;
}

/** Sorts ahead of bb's groups, so the shelf actions lead the menu. */
const SHELF_GROUP = "0_shelf";

export function RowContextMenu({
  thread,
  shelfItems = [],
  children,
}: {
  thread: PluginSidebarThread;
  /**
   * The row's shelf actions, so a touch screen — where the row's hover
   * buttons never show — still reaches them through a long-press.
   */
  shelfItems?: readonly RowMenuShelfItem[];
  children: ReactNode;
}) {
  const inline: PluginThreadActionsInlineItem[] = shelfItems.map((item) => ({
    key: `shelf:${item.label}`,
    group: SHELF_GROUP,
    action: { label: item.label, icon: item.icon, run: item.onSelect },
  }));

  return (
    <ThreadActionsContextMenu thread={actionTarget(thread)} inline={inline}>
      {children}
    </ThreadActionsContextMenu>
  );
}

/** The fields bb's thread menu reads, from a sidebar row. */
function actionTarget(thread: PluginSidebarThread): PluginThreadActionTarget {
  const { environment } = thread;
  return {
    id: thread.id,
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    sectionId: thread.sectionId,
    isUnread: thread.isUnread,
    status: thread.status,
    environment:
      environment?.id != null
        ? { id: environment.id, path: environment.path ?? null }
        : null,
  };
}
