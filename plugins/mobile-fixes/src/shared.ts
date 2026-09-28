// Shared by every feature. All CSS applies only while the content script has
// put ROOT_CLASS on <html>, so reload, disable, and removal restore stock
// behavior at once.
import { useSyncExternalStore } from "react";

export const ROOT_CLASS = "bb-mobile-fixes";
// Mirrors COMPACT_VIEWPORT_QUERY in @bb/shared-ui.
export const COMPACT_VIEWPORT_QUERY = "(max-width: 767px)";
export const COARSE_POINTER_QUERY = "(pointer: coarse)";
// bb's recording bar while a voice recording or transcription runs.
export const VOICE_CONTROLS_SELECTOR = "[data-promptbox-voice-controls]:not([aria-hidden])";

export function useMediaQuery(query: string): boolean {
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

// A boolean shared by every mounted component and mirrored as a class on
// <html>, so CSS can follow it. `storageKey` persists it in localStorage.
export interface Flag {
  get(): boolean;
  set(next: boolean): void;
  use(): boolean;
  // Puts the class on <html> for the current value.
  sync(): void;
  className: string;
}

export function createFlag(className: string, storageKey?: string): Flag {
  let value = false;
  if (storageKey) {
    try {
      value = window.localStorage.getItem(storageKey) === "1";
    } catch {
      // No storage: start off.
    }
  }
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const sync = () => document.documentElement.classList.toggle(className, value);
  return {
    className,
    get: () => value,
    set(next) {
      if (value === next) return;
      value = next;
      sync();
      if (storageKey) {
        try {
          window.localStorage.setItem(storageKey, next ? "1" : "0");
        } catch {
          // Private mode: the choice lasts for this page only.
        }
      }
      for (const listener of listeners) listener();
    },
    use: () => useSyncExternalStore(subscribe, () => value, () => false),
    sync,
  };
}
