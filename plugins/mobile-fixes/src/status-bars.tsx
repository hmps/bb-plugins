// On a phone, bb stacks status bars above the thread composer: background
// commands, active child threads, the parent thread, and the changes summary.
// With the keyboard open they can take most of the space left for the
// conversation. On compact viewports status-bars.css hides them, and a
// composer action button (host-rendered next to the mic/send buttons) shows
// them again. The button carries the number of hidden bar items. The choice
// persists in localStorage. The queued-messages panel always stays visible.
import { useEffect, useState, type ReactElement } from "react";
import { useComposerView } from "@get-bb/plugin-sdk/app";
import { COMPACT_VIEWPORT_QUERY, createFlag, useMediaQuery } from "./shared";
import "./status-bars.css";

// Each bar item has a disclosure toggle; the context bar has one per item.
const BAR_ITEM_SELECTOR =
  ":scope > div:not([data-follow-up-composer-anchor]) > section:not(:has([data-queued-messages-scroll-frame])) button[aria-controls][aria-expanded]";

export const barsOpen = createFlag("bb-mobile-fixes-bars-open", "bb-mobile-fixes:bars-open");

// Counts the bar items in the composer shell that holds `anchor`.
function useBarItemCount(anchor: HTMLElement | null): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const shell = anchor?.closest<HTMLElement>("[data-promptbox-shell]");
    if (!shell) return;
    const update = () => setCount(shell.querySelectorAll(BAR_ITEM_SELECTOR).length);
    update();
    const observer = new MutationObserver(update);
    observer.observe(shell, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [anchor]);
  return count;
}

// Lucide PanelTopClose / PanelTopOpen.
function BarsIcon({ open }: { open: boolean }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M3 9h18" />
      {open ? <path d="m9 16 3-3 3 3" /> : <path d="m15 14-3 3-3-3" />}
    </svg>
  );
}

export function StatusBarsToggle(): ReactElement | null {
  const view = useComposerView();
  const isOpen = barsOpen.use();
  const isCompactViewport = useMediaQuery(COMPACT_VIEWPORT_QUERY);
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const count = useBarItemCount(button);

  if (!isCompactViewport || view.layout !== "expanded") return null;

  const label = isOpen ? "Hide status bars" : `Show ${count} status ${count === 1 ? "item" : "items"}`;
  return (
    <button
      ref={setButton}
      type="button"
      className="bb-mobile-fixes-action bb-mobile-fixes-bars"
      // With no bar items the button stays mounted but invisible
      // (status-bars.css): the count needs a mounted node to find the shell.
      data-empty={count === 0 ? "" : undefined}
      aria-pressed={isOpen}
      aria-label={label}
      title={label}
      // Keep focus (and the keyboard) in the editor, like the stock buttons.
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => barsOpen.set(!isOpen)}
    >
      <BarsIcon open={isOpen} />
      {!isOpen && count > 0 ? <span className="bb-mobile-fixes-bars-count">{count}</span> : null}
    </button>
  );
}
