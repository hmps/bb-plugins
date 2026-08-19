import { formatWeekdayTime, type UsageWindow } from "./usage.ts";

export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Projected usage at or above this percent is a "watch" window. */
export const WATCH_THRESHOLD = 85;
/** Below this elapsed share of a window, the burn rate is still noise. */
export const MIN_ELAPSED_FRACTION = 0.05;

export type PaceStatus = "on_track" | "watch" | "at_risk" | "unknown";

/** Why a pace is unknown. It selects the copy in `formatPace`. */
export type PaceUnknownReason = "too_early" | "unavailable";

export interface WindowPace {
  status: PaceStatus;
  elapsedPercent: number;
  projectedPercent: number;
  runsOutAt: string | null;
  reason: PaceUnknownReason | null;
}

function unknownPace(
  reason: PaceUnknownReason,
  elapsedPercent = 0,
): WindowPace {
  return {
    status: "unknown",
    elapsedPercent,
    projectedPercent: 0,
    runsOutAt: null,
    reason,
  };
}

function paceStatusFor(projectedPercent: number): PaceStatus {
  if (projectedPercent >= 100) return "at_risk";
  if (projectedPercent >= WATCH_THRESHOLD) return "watch";
  return "on_track";
}

/**
 * Projects a usage window forward to its reset time. The window start is not
 * reported, so the elapsed share is derived from `resetsAt` and the known
 * window duration.
 */
export function windowPace(
  window: UsageWindow,
  durationMs: number,
  now: Date,
): WindowPace {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs) || !Number.isFinite(durationMs) || durationMs <= 0) {
    return unknownPace("unavailable");
  }

  const resetMs =
    window.resetsAt === null ? Number.NaN : new Date(window.resetsAt).getTime();
  // A reset in the past clamps the remaining time to zero, which would read as
  // a fully elapsed window. Report it as unavailable instead.
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) {
    return unknownPace("unavailable");
  }

  const remainingMs = Math.min(durationMs, resetMs - nowMs);
  const elapsedFraction = 1 - remainingMs / durationMs;
  const elapsedPercent = elapsedFraction * 100;
  const usedPercent = window.usedPercent;
  if (!Number.isFinite(usedPercent) || usedPercent < 0) {
    return unknownPace("unavailable", elapsedPercent);
  }
  // A window that is already used up is at risk no matter how early it is.
  if (usedPercent < 100 && elapsedFraction < MIN_ELAPSED_FRACTION) {
    return unknownPace("too_early", elapsedPercent);
  }

  const projectedPercent = usedPercent / elapsedFraction;
  const status = paceStatusFor(projectedPercent);
  let runsOutAt: string | null = null;
  if (status === "at_risk") {
    if (usedPercent >= 100) {
      runsOutAt = new Date(nowMs).toISOString();
    } else {
      const elapsedMs = elapsedFraction * durationMs;
      const percentPerMs = usedPercent / elapsedMs;
      runsOutAt = new Date(
        nowMs + (100 - usedPercent) / percentPerMs,
      ).toISOString();
    }
  }

  return { status, elapsedPercent, projectedPercent, runsOutAt, reason: null };
}

const STATUS_SEVERITY: Record<PaceStatus, number> = {
  unknown: 0,
  on_track: 1,
  watch: 2,
  at_risk: 3,
};

/** The most severe status of the given paces. */
export function worstPaceStatus(paces: readonly WindowPace[]): PaceStatus {
  let worst: PaceStatus = "unknown";
  for (const pace of paces) {
    if (STATUS_SEVERITY[pace.status] > STATUS_SEVERITY[worst]) {
      worst = pace.status;
    }
  }
  return worst;
}

export function formatPace(pace: WindowPace, locale?: string): string {
  if (pace.status === "unknown") {
    return pace.reason === "too_early" ? "Too early to tell" : "Pace unavailable";
  }

  const projected = `~${Math.round(pace.projectedPercent)}% at reset`;
  if (pace.status === "on_track") return `On track · ${projected}`;
  if (pace.status === "watch") return `Watch · ${projected}`;

  const runsOut = formatWeekdayTime(pace.runsOutAt, locale);
  return runsOut === null
    ? `At risk · ${projected}`
    : `At risk · ${projected} · runs out ${runsOut}`;
}
