// bb-plugin-mobile-composer-bars — frontend entry.
//
// On a phone, bb stacks status bars above the thread composer: background
// commands, active child threads, the parent thread, and the changes summary.
// With the keyboard open they can take most of the space left for the
// conversation. This plugin hides them on compact viewports and adds a
// composer action button (host-rendered next to the mic/send buttons) that
// shows them again. The button carries the number of hidden bar items.
//   1. A content script puts ROOT_CLASS on <html>; app.css hides the bars only
//      while it is there, so reload, disable, and removal restore stock
//      behavior at once. OPEN_CLASS shows them again.
//   2. The choice persists in localStorage, so it holds across threads and
//      reloads. The queued-messages panel always stays visible.
import { useEffect, useState, useSyncExternalStore, type ReactElement } from "react";
import { definePluginApp, useComposerView } from "@get-bb/plugin-sdk/app";
import "./app.css";

const ROOT_CLASS = "bb-mobile-composer-bars";
const OPEN_CLASS = "bb-mobile-composer-bars-open";
const STORAGE_KEY = "bb-mobile-composer-bars:open";
// Mirrors COMPACT_VIEWPORT_QUERY in @bb/shared-ui.
const COMPACT_VIEWPORT_QUERY = "(max-width: 767px)";
// Each bar item has a disclosure toggle; the context bar has one per item.
const BAR_ITEM_SELECTOR =
  ":scope > div:not([data-follow-up-composer-anchor]) > section:not(:has([data-queued-messages-scroll-frame])) button[aria-controls][aria-expanded]";

// --- tiny external store so every mounted toggle agrees ---------------------
function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

let open = readStored();
const listeners = new Set<() => void>();

function setOpen(next: boolean) {
  if (open === next) return;
  open = next;
  document.documentElement.classList.toggle(OPEN_CLASS, next);
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  } catch {
    // Private mode: the choice lasts for this page only.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function useOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open, () => false);
}

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

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

function BarsToggle(): ReactElement | null {
  const view = useComposerView();
  const isOpen = useOpen();
  const isCompactViewport = useMediaQuery(COMPACT_VIEWPORT_QUERY);
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const count = useBarItemCount(button);
  const hidden = !isCompactViewport || view.layout !== "expanded";

  const label = isOpen ? "Hide status bars" : `Show ${count} status ${count === 1 ? "item" : "items"}`;
  if (hidden) return null;

  return (
    <button
      ref={setButton}
      type="button"
      className="bb-mobile-composer-bars-toggle"
      // With no bar items the button stays mounted but invisible (app.css):
      // the count needs a mounted node to find the shell.
      data-empty={count === 0 ? "" : undefined}
      aria-pressed={isOpen}
      aria-label={label}
      title={label}
      // Keep focus (and the keyboard) in the editor, like the stock buttons.
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => setOpen(!isOpen)}
    >
      <BarsIcon open={isOpen} />
      {!isOpen && count > 0 ? <span className="bb-mobile-composer-bars-count">{count}</span> : null}
    </button>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "mobile-composer-bars",
    mount({ signal }) {
      const root = document.documentElement;
      root.classList.add(ROOT_CLASS);
      root.classList.toggle(OPEN_CLASS, open);
      const clear = () => {
        root.classList.remove(ROOT_CLASS, OPEN_CLASS);
      };
      signal.addEventListener("abort", clear, { once: true });
      return clear;
    },
  });

  app.composer.customize({
    id: "mobile-composer-bars",
    scopes: ["thread"],
    actions: [{ id: "toggle", component: BarsToggle }],
  });
});
