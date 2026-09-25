import { createContext, useContext, useEffect, useState } from "react";

/**
 * bb shows its keyboard hints once the shortcut modifier is held alone this
 * long. The sidebar waits the same time, so its hints and bb's appear
 * together.
 */
const HOLD_MS = 700;

/** bb's thread shortcuts: modifier+1 opens the first row, up to 9. */
export const THREAD_SHORTCUT_COUNT = 9;

/** The anchors bb counts, in DOM order, for its thread shortcuts. */
export const THREAD_SHORTCUT_TARGET = "[data-sidebar-thread-shortcut-target]";

const isMac = (): boolean =>
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/**
 * True while the shortcut modifier (Command on a Mac, Control elsewhere) is
 * held on its own. bb draws its hints on the same gesture, but it does not
 * expose that state to plugins, so the sidebar watches the key itself with
 * bb's rules: any other key, a second modifier, a release, or leaving the
 * window hides the hints.
 */
export function useShortcutHintsVisible(): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const modifier = isMac() ? "Meta" : "Control";
    let timer: ReturnType<typeof setTimeout> | null = null;
    let shown = false;

    const hide = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      shown = false;
      setVisible(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== modifier) {
        if (timer !== null || shown) hide();
        return;
      }
      if (timer !== null || shown) return;
      const otherModifier =
        event.shiftKey ||
        event.altKey ||
        (modifier === "Meta" ? event.ctrlKey : event.metaKey);
      if (otherModifier) return hide();
      timer = setTimeout(() => {
        timer = null;
        shown = true;
        setVisible(true);
      }, HOLD_MS);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === modifier) hide();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", hide);
    return () => {
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", hide);
    };
  }, []);

  return visible;
}

/**
 * The first nine shortcut targets under `root`, in the order bb walks them:
 * thread id to its hint label ("⌘ 1" on a Mac, "Ctrl + 1" elsewhere). Rows
 * in a collapsed shelf are not rendered, so bb skips them too.
 */
export function readThreadShortcuts(
  root: ParentNode,
): ReadonlyMap<string, string> {
  const mac = isMac();
  const labels = new Map<string, string>();
  for (const target of Array.from(
    root.querySelectorAll<HTMLElement>(THREAD_SHORTCUT_TARGET),
  )) {
    if (target.closest("[data-sidebar-overflow='true']")) continue;
    const threadId = target.dataset.sidebarThreadId;
    if (!threadId) continue;
    const key = String(labels.size + 1);
    labels.set(threadId, mac ? `⌘ ${key}` : `Ctrl + ${key}`);
    if (labels.size === THREAD_SHORTCUT_COUNT) break;
  }
  return labels;
}

/** Thread id to hint label while the hints show; empty otherwise. */
export const ThreadShortcutHints = createContext<ReadonlyMap<string, string>>(
  new Map(),
);

export const useThreadShortcutHint = (threadId: string): string | undefined =>
  useContext(ThreadShortcutHints).get(threadId);

/** bb's own hint chip, so the sidebar's hints read as bb's. */
export const SHORTCUT_HINT_CLASS =
  "pointer-events-none inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-sm bg-state-hover/50 px-1.5 py-1 font-sans text-xs font-normal leading-none tabular-nums text-subtle-foreground";
