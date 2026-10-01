import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";

export type ThreadContextResult = Awaited<ReturnType<PluginBrowserBbSdk["threads"]["context"]>>;

export interface ContextUsage {
  usedTokens: number;
  modelContextWindow: number;
  estimated: boolean;
}

/**
 * The usage from `threads.context`, or null when the thread reports none or
 * the numbers cannot give a percent. A null hides the ring, so missing data
 * never shows as 0% used.
 */
export function readUsage(result: ThreadContextResult | null | undefined): ContextUsage | null {
  const usage = result?.usage;
  if (!usage) return null;
  const { usedTokens, modelContextWindow } = usage;
  if (!Number.isFinite(usedTokens) || usedTokens < 0) return null;
  if (!Number.isFinite(modelContextWindow) || modelContextWindow <= 0) return null;
  return { usedTokens, modelContextWindow, estimated: usage.estimated === true };
}

/** The same rounding as the bb context indicator. */
export function usagePercent(usage: ContextUsage): number {
  const ratio = usage.usedTokens / usage.modelContextWindow;
  return Math.round(Math.min(Math.max(ratio, 0), 1) * 100);
}

export type UsageTone = "normal" | "warning" | "destructive";

export function usageTone(percent: number): UsageTone {
  if (percent >= 90) return "destructive";
  if (percent >= 75) return "warning";
  return "normal";
}

const COMPACT_TOKENS = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 0,
});

export function formatTokens(value: number): string {
  return COMPACT_TOKENS.format(Math.max(0, Math.round(value))).toLowerCase();
}

/**
 * Thread events after which `threads.context` can report a different value.
 * A run sends `thread/contextWindowUsage/updated` as the context grows.
 */
const USAGE_EVENT_TYPES = new Set<string>([
  "thread/contextWindowUsage/updated",
  "thread/compacted",
  "thread/context/cleared",
  "turn/completed",
]);

export function changesUsage(event: {
  changes: readonly string[];
  metadata?: { eventTypes?: readonly string[] };
}): boolean {
  if (event.changes.includes("history-rewritten")) return true;
  if (!event.changes.includes("events-appended")) return false;
  return event.metadata?.eventTypes?.some((type) => USAGE_EVENT_TYPES.has(type)) ?? false;
}
