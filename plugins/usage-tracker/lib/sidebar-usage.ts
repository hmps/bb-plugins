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
  session: UsageWindow | null;
  weekly: UsageWindow | null;
}

export interface SidebarWindowPace {
  window: UsageWindow;
  pace: WindowPace;
}

export interface SidebarWindowPaces {
  session: SidebarWindowPace | null;
  weekly: SidebarWindowPace | null;
  extras: SidebarWindowPace[];
}

function isSessionLabel(label: string): boolean {
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
    session:
      provider.windows.find((window) => isSessionLabel(window.label)) ?? null,
    weekly:
      provider.windows.find((window) => isWeeklyLabel(window.label)) ?? null,
  };
}

/**
 * Windows beyond the five-hour and weekly pair, such as model-scoped quotas
 * (for example a Fable limit). They render as extra rows in the details card.
 */
export function extraSidebarWindows(provider: ProviderUsage): UsageWindow[] {
  const { session, weekly } = sidebarUsageWindows(provider);
  return provider.windows.filter(
    (window) => window !== session && window !== weekly,
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
  const { session, weekly } = sidebarUsageWindows(provider);
  return {
    session: pacedWindow(session, FIVE_HOUR_MS, now),
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
    [paces.session, paces.weekly, ...paces.extras]
      .filter((entry): entry is SidebarWindowPace => entry !== null)
      .map((entry) => entry.pace),
  );
}

export function sidebarUsageSummary(provider: ProviderUsage): string {
  const { session, weekly } = sidebarUsageWindows(provider);
  const parts: string[] = [];
  if (session !== null) {
    parts.push(`${formatUsedPercent(session.usedPercent)}% session`);
  }
  if (weekly !== null) {
    parts.push(`${formatUsedPercent(weekly.usedPercent)}% wk`);
  }
  return parts.length === 0 ? "—" : parts.join(" · ");
}

export function sidebarUsagePrimarySummary(provider: ProviderUsage): string {
  const { session, weekly } = sidebarUsageWindows(provider);
  const primary = session ?? weekly;
  return primary === null ? "—%" : `${formatUsedPercent(primary.usedPercent)}%`;
}

export function mergeLastKnownWindows(
  current: ProviderUsage,
  previous: ProviderUsage | undefined,
): ProviderUsage {
  if (
    current.status === "ok" ||
    previous === undefined ||
    previous.windows.length === 0
  ) {
    return current;
  }

  const labels = new Set(current.windows.map((window) => window.label));
  return {
    ...current,
    windows: [
      ...current.windows,
      ...previous.windows.filter((window) => !labels.has(window.label)),
    ],
  };
}
