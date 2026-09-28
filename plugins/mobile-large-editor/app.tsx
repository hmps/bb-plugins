// bb-plugin-mobile-large-editor — frontend entry.
//
// A Codex-style thread composer on compact viewports (<= 767px):
//   1. While empty, the editor is one row high with a short placeholder. It
//      grows with the text up to five rows, then scrolls (app.css).
//   2. At five rows, an expand button shows in the top-right corner of the
//      editor. It is a composer action (host-rendered in the action row) that
//      app.css moves to the corner.
//   3. Large mode fills the visible app shell with the editor, like Codex's
//      full-screen editor. The same corner button collapses it.
// bb has its own zen mode ("Make prompt box larger"), but the thread follow-up
// composer hides it on compact viewports: the mobile composer receives a
// `compact` config and `enterZenMode` bails out when it is set. The plugin SDK
// has no way to flip zen mode, so a class on <html> drives large mode instead.
// Large mode is transient, like the stock thread zen mode: it resets when a
// message is submitted. Enter already inserts a newline on coarse pointers,
// so no key handling changes are needed.
import { useEffect, useState, useSyncExternalStore, type ReactElement } from "react";
import { definePluginApp, useComposerView } from "@get-bb/plugin-sdk/app";
import "./app.css";

const ROOT_CLASS = "bb-mobile-large-editor";
const ACTIVE_CLASS = "bb-mobile-large-editor-active";
// The editor grows up to this many rows, then scrolls (app.css) and shows the
// toggle.
const MAX_ROWS = 5;
// Mirrors COMPACT_VIEWPORT_QUERY in @bb/shared-ui.
const COMPACT_VIEWPORT_QUERY = "(max-width: 767px)";

// --- tiny external store so every mounted toggle agrees ---------------------
let active = false;
const listeners = new Set<() => void>();

function setActive(next: boolean) {
  if (active === next) return;
  active = next;
  document.documentElement.classList.toggle(ACTIVE_CLASS, next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function useActive(): boolean {
  return useSyncExternalStore(subscribe, () => active, () => false);
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

// Lucide Maximize2 / Minimize2, the same glyphs the stock toggle uses.
function MaximizeIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

function MinimizeIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="14" y1="10" x2="21" y2="3" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

// Rows of text in the editor, from the ProseMirror height and line height.
function useEditorRows(anchor: HTMLElement | null): number {
  const [rows, setRows] = useState(1);
  useEffect(() => {
    const editor = anchor?.closest("form[data-promptbox]")?.querySelector<HTMLElement>(".ProseMirror");
    if (!editor) return;
    const update = () => {
      const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 1;
      setRows(Math.max(1, Math.round(editor.getBoundingClientRect().height / lineHeight)));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(editor);
    return () => observer.disconnect();
  }, [anchor]);
  return rows;
}

function LargeEditorToggle(): ReactElement | null {
  const view = useComposerView();
  const isActive = useActive();
  const isCompactViewport = useMediaQuery(COMPACT_VIEWPORT_QUERY);
  const isSubmitting = view.run.isSubmitting;
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const rows = useEditorRows(button);

  // Stock thread zen mode resets on submit (`resetOnSubmit: true`).
  useEffect(() => {
    if (isSubmitting) setActive(false);
  }, [isSubmitting]);

  // Desktop already has the stock toggle; the host only renders composer
  // actions in the expanded layout, but guard anyway.
  if (!isCompactViewport || view.layout !== "expanded") return null;

  return (
    <button
      ref={setButton}
      type="button"
      className="bb-mobile-large-editor-toggle"
      // Below the row cap the button stays mounted but invisible (app.css):
      // the row count needs a mounted node to find the editor.
      data-idle={!isActive && rows < MAX_ROWS ? "" : undefined}
      aria-pressed={isActive}
      aria-label={isActive ? "Make prompt box smaller" : "Make prompt box larger"}
      title={isActive ? "Make prompt box smaller" : "Make prompt box larger"}
      // Keep focus (and the keyboard) in the editor, like the stock button.
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => setActive(!isActive)}
    >
      {isActive ? <MinimizeIcon /> : <MaximizeIcon />}
    </button>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "mobile-large-editor",
    mount({ signal }) {
      const root = document.documentElement;
      root.classList.add(ROOT_CLASS);
      root.classList.toggle(ACTIVE_CLASS, active);
      const clear = () => {
        root.classList.remove(ROOT_CLASS, ACTIVE_CLASS);
      };
      signal.addEventListener("abort", clear, { once: true });
      return clear;
    },
  });

  app.composer.customize({
    id: "mobile-large-editor",
    scopes: ["thread", "side-chat"],
    actions: [{ id: "toggle", component: LargeEditorToggle }],
  });
});
