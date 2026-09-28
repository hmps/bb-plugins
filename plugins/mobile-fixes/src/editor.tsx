// Codex-style thread composer on compact viewports (<= 767px):
//   1. While empty, the editor is one row high with a short placeholder. It
//      grows with the text up to five rows, then scrolls (editor.css).
//   2. At five rows, an expand button shows in the top-right corner of the
//      editor. It is a composer action (host-rendered in the action row) that
//      editor.css moves to the corner.
//   3. Large mode fills the visible app shell with the editor, like Codex's
//      full-screen editor. The same corner button collapses it.
// bb has its own zen mode ("Make prompt box larger"), but the thread follow-up
// composer hides it on compact viewports: the mobile composer receives a
// `compact` config and `enterZenMode` bails out when it is set. The plugin SDK
// has no way to flip zen mode, so a class on <html> drives large mode instead.
// Large mode is transient, like the stock thread zen mode: it resets when a
// message is submitted. Enter already inserts a newline on coarse pointers,
// so no key handling changes are needed.
import { useEffect, useState, type ReactElement } from "react";
import { useComposerView } from "@get-bb/plugin-sdk/app";
import { COMPACT_VIEWPORT_QUERY, createFlag, useMediaQuery } from "./shared";
import "./editor.css";

// The editor grows up to this many rows, then scrolls and shows the button.
const MAX_ROWS = 5;

export const largeMode = createFlag("bb-mobile-fixes-large");

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

export function ExpandToggle(): ReactElement | null {
  const view = useComposerView();
  const isActive = largeMode.use();
  const isCompactViewport = useMediaQuery(COMPACT_VIEWPORT_QUERY);
  const isSubmitting = view.run.isSubmitting;
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const rows = useEditorRows(button);

  // Stock thread zen mode resets on submit (`resetOnSubmit: true`).
  useEffect(() => {
    if (isSubmitting) largeMode.set(false);
  }, [isSubmitting]);

  // Desktop keeps the stock toggle; the host only renders composer actions
  // in the expanded layout, but guard anyway.
  if (!isCompactViewport || view.layout !== "expanded") return null;

  const label = isActive ? "Make prompt box smaller" : "Make prompt box larger";
  return (
    <button
      ref={setButton}
      type="button"
      className="bb-mobile-fixes-action bb-mobile-fixes-expand"
      // Below the row cap the button stays mounted but invisible (editor.css):
      // the row count needs a mounted node to find the editor.
      data-idle={!isActive && rows < MAX_ROWS ? "" : undefined}
      aria-pressed={isActive}
      aria-label={label}
      title={label}
      // Keep focus (and the keyboard) in the editor, like the stock button.
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => largeMode.set(!isActive)}
    >
      {isActive ? <MinimizeIcon /> : <MaximizeIcon />}
    </button>
  );
}
