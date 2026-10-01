import { useEffect, useState } from "react";
import {
  findSplitTargets,
  HOST_ATTRIBUTE,
  OBSERVED_ATTRIBUTES,
  type SplitTarget,
} from "./targets";

export interface MountedSplitTarget extends SplitTarget {
  /** Stable React key for the portal. */
  key: string;
  /** The span this plugin owns; the button portals into it. */
  host: HTMLElement;
}

/**
 * Keeps one plugin-owned span next to each target and returns the targets.
 * A MutationObserver on the document rescans after every host commit, so new
 * messages, expanded banners, route changes, and new panes are picked up.
 * Unmount disconnects the observer and removes every span.
 */
export function useSplitHosts(): MountedSplitTarget[] {
  const [targets, setTargets] = useState<MountedSplitTarget[]>([]);

  useEffect(() => {
    const hosts = new Map<HTMLElement, { key: string; host: HTMLElement }>();
    let nextKey = 0;
    let signature = "";

    const sync = () => {
      const found = findSplitTargets(document);
      const live = new Set<HTMLElement>();
      const mounted: MountedSplitTarget[] = [];
      for (const target of found) {
        // A second match on the same anchor is a duplicate.
        if (live.has(target.anchor)) {
          continue;
        }
        live.add(target.anchor);
        let entry = hosts.get(target.anchor);
        if (entry === undefined) {
          const host = document.createElement("span");
          host.setAttribute(HOST_ATTRIBUTE, target.kind);
          entry = { key: `split-${nextKey++}`, host };
          hosts.set(target.anchor, entry);
        }
        placeHost(target, entry.host);
        mounted.push({ ...target, ...entry });
      }
      for (const [anchor, entry] of hosts) {
        if (!live.has(anchor)) {
          entry.host.remove();
          hosts.delete(anchor);
        }
      }
      const nextSignature = mounted
        .map((target) =>
          [target.key, target.threadId, target.title, target.hidden, target.paneIds.join(",")].join(
            "\u0000",
          ),
        )
        .join("\n");
      if (nextSignature !== signature) {
        signature = nextSignature;
        setTargets(mounted);
      }
    };

    const observer = new MutationObserver(sync);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRIBUTES,
    });
    sync();

    return () => {
      observer.disconnect();
      for (const { host } of hosts.values()) {
        host.remove();
      }
      hosts.clear();
    };
  }, []);

  return targets;
}

/**
 * Composer rows: the span follows the row link inside its `li`, so the button
 * is never inside the link. Message rows: the span is the last child of the
 * `group/timeline-row` wrapper, beside the header, so it is never inside the
 * header's toggle button. A host re-render can move or drop the span; the
 * next scan puts it back.
 */
function placeHost(target: SplitTarget, host: HTMLElement): void {
  if (target.kind === "composer") {
    if (target.anchor.nextElementSibling !== host) {
      target.anchor.after(host);
    }
    return;
  }
  if (target.anchor.lastElementChild !== host) {
    target.anchor.append(host);
  }
}
