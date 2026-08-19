import {
  formatUsedPercent,
  type ProviderUsage,
  type UsageWindow,
} from "./usage.ts";

import {
  FIVE_HOUR_MS,
  WEEK_MS,
  windowPace,
  worstPaceStatus,
  type PaceStatus,
  type WindowPace,
} from "./pace.ts";

export interface SidebarUsageWindows {
  fiveHour: UsageWindow | null;
  weekly: UsageWindow | null;
}

export interface SidebarWindowPace {
  window: UsageWindow;
  pace: WindowPace;
}

export interface SidebarWindowPaces {
  fiveHour: SidebarWindowPace | null;
  weekly: SidebarWindowPace | null;
  extras: SidebarWindowPace[];
}

function isFiveHourLabel(label: string): boolean {
  const normalized = label.toLowerCase();
  return (
    normalized.includes("five") ||
    normalized.includes("5 hour") ||
    normalized.includes("5-hour") ||
    normalized.includes("current session")
  );
}

function isWeeklyLabel(label: string): boolean {
  const normalized = label.toLowerCase();
  return (
    normalized.includes("week") ||
    normalized.includes("seven day") ||
    normalized.includes("7 day") ||
    normalized.includes("7-day")
  );
}

export function sidebarUsageWindows(
  provider: ProviderUsage,
): SidebarUsageWindows {
  return {
    fiveHour:
      provider.windows.find((window) => isFiveHourLabel(window.label)) ?? null,
    weekly:
      provider.windows.find((window) => isWeeklyLabel(window.label)) ?? null,
  };
}

/**
 * Windows beyond the five-hour and weekly pair, such as model-scoped quotas
 * (for example a Fable limit). They render as extra rows in the details card.
 */
export function extraSidebarWindows(provider: ProviderUsage): UsageWindow[] {
  const { fiveHour, weekly } = sidebarUsageWindows(provider);
  return provider.windows.filter(
    (window) => window !== fiveHour && window !== weekly,
  );
}

function pacedWindow(
  window: UsageWindow | null,
  durationMs: number,
  now: Date,
): SidebarWindowPace | null {
  return window === null
    ? null
    : { window, pace: windowPace(window, durationMs, now) };
}

/**
 * Pace for every sidebar window. Model-scoped quotas (for example Fable) are
 * weekly windows, like the weekly limit.
 */
export function sidebarWindowPaces(
  provider: ProviderUsage,
  now: Date,
): SidebarWindowPaces {
  const { fiveHour, weekly } = sidebarUsageWindows(provider);
  return {
    fiveHour: pacedWindow(fiveHour, FIVE_HOUR_MS, now),
    weekly: pacedWindow(weekly, WEEK_MS, now),
    extras: extraSidebarWindows(provider).map((window) => ({
      window,
      pace: windowPace(window, WEEK_MS, now),
    })),
  };
}

/** The most severe window pace of a provider, for the collapsed strip. */
export function providerPaceStatus(
  provider: ProviderUsage,
  now: Date,
): PaceStatus {
  const paces = sidebarWindowPaces(provider, now);
  return worstPaceStatus(
    [paces.fiveHour, paces.weekly, ...paces.extras]
      .filter((entry): entry is SidebarWindowPace => entry !== null)
      .map((entry) => entry.pace),
  );
}

export function sidebarUsageSummary(provider: ProviderUsage): string {
  const { fiveHour, weekly } = sidebarUsageWindows(provider);
  const fiveHourValue =
    fiveHour === null ? "—" : formatUsedPercent(fiveHour.usedPercent);
  const weeklyValue =
    weekly === null ? "—" : formatUsedPercent(weekly.usedPercent);
  return `${fiveHourValue}% 5h · ${weeklyValue}% wk`;
}

export function sidebarUsagePrimarySummary(provider: ProviderUsage): string {
  const { fiveHour, weekly } = sidebarUsageWindows(provider);
  const primary = fiveHour ?? weekly;
  return primary === null ? "—%" : `${formatUsedPercent(primary.usedPercent)}%`;
}

export function mergeLastKnownWindows(
  current: ProviderUsage,
  previous: ProviderUsage | undefined,
): ProviderUsage {
  if (previous === undefined || previous.windows.length === 0) return current;

  const currentPair = sidebarUsageWindows(current);
  const previousPair = sidebarUsageWindows(previous);
  const windows = [...current.windows];

  if (currentPair.fiveHour === null && previousPair.fiveHour !== null) {
    windows.unshift(previousPair.fiveHour);
  }
  if (currentPair.weekly === null && previousPair.weekly !== null) {
    windows.push(previousPair.weekly);
  }
  if (extraSidebarWindows(current).length === 0) {
    windows.push(...extraSidebarWindows(previous));
  }

  return { ...current, windows };
}
