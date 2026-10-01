import { useMemo, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import {
  experimental_Icon as Icon,
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreadSplit,
  experimental_useSidebarThreads,
  useBbContext,
  useSidebarSplitLayout,
  type PluginSidebarSplitLayout,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { useSplitHosts } from "./useSplitHosts";

/**
 * bb's pane cap (`MAX_PANES` in the host split layout). At the cap the host
 * replaces the focused pane instead of splitting it, and the focused pane can
 * be the parent thread. The SDK does not expose the cap, so it is copied here.
 */
export const MAX_PANES = 8;

type SplitPane = PluginSidebarSplitLayout["panes"][number];

export function ChildThreadSplitOverlay() {
  const targets = useSplitHosts();
  const layout = useSidebarSplitLayout();
  const { threadId: routeThreadId } = useBbContext();
  const { threads } = experimental_useSidebarThreads();
  const threadsById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread])),
    [threads],
  );

  return (
    <>
      {targets.map((target) => {
        const pane = paneAround(target.paneIds, layout);
        if (target.kind === "message") {
          const containerThreadId = layout === null ? routeThreadId : (pane?.threadId ?? null);
          if (!isChildThread(threadsById.get(target.threadId), containerThreadId)) {
            return null;
          }
        }
        return createPortal(
          <OpenInSplitButton
            threadId={target.threadId}
            title={target.title}
            hidden={target.hidden}
            pane={pane}
          />,
          target.host,
          target.key,
        );
      })}
    </>
  );
}

interface OpenInSplitButtonProps {
  threadId: string;
  title: string;
  hidden: boolean;
  /** The split pane that shows the button, or null in a single-pane layout. */
  pane: SplitPane | null;
}

function OpenInSplitButton({ threadId, title, hidden, pane }: OpenInSplitButtonProps) {
  const split = experimental_useSidebarThreadSplit(threadId);
  const actions = experimental_useSidebarThreadActions();
  const layout = useSidebarSplitLayout();

  // False on compact viewports, with splits disabled, and for unknown threads.
  if (!split.isAvailable) {
    return null;
  }
  const isOpen = split.layout !== null;
  if (!isOpen && (layout?.panes.length ?? 1) >= MAX_PANES) {
    return null;
  }

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    // A portalled click does not reach the pane's own pointer handler, and a
    // keyboard press never does. Focus the pane that shows the button first,
    // so the split opens beside it and not beside another pane.
    if (!isOpen && pane !== null && !pane.isFocused && pane.threadId !== null) {
      actions.open(pane.threadId, { split: true });
    }
    actions.open(threadId, { split: true });
  };

  return (
    <button
      type="button"
      className="child-thread-split__button"
      aria-label={`Open ${title} in split`}
      title="Open in split"
      tabIndex={hidden ? -1 : undefined}
      onClick={handleClick}
    >
      <span className="child-thread-split__touch-target" aria-hidden="true" />
      <Icon name="Columns2" className="child-thread-split__icon" aria-hidden />
    </button>
  );
}

function paneAround(
  paneIds: readonly string[],
  layout: PluginSidebarSplitLayout | null,
): SplitPane | null {
  if (layout === null) {
    return null;
  }
  for (const paneId of paneIds) {
    const pane = layout.panes.find((candidate) => candidate.paneId === paneId);
    if (pane !== undefined) {
      return pane;
    }
  }
  return null;
}

/** A direct, visible, non-fork child of the thread that shows the message. */
function isChildThread(
  thread: PluginSidebarThread | undefined,
  containerThreadId: string | null,
): boolean {
  return (
    thread !== undefined &&
    containerThreadId !== null &&
    thread.parentThreadId === containerThreadId &&
    thread.originKind !== "fork" &&
    !thread.isHidden
  );
}
