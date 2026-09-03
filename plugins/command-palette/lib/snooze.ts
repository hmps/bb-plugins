/** Snooze wake times, in local time, as pure math over a `now` timestamp. */

const HOUR_MS = 3_600_000;
const MORNING_HOUR = 9;

/** `hours` from now. */
export function inHours(now: number, hours: number): number {
  return now + hours * HOUR_MS;
}

/** The next calendar day at 09:00 local time. */
export function tomorrowMorning(now: number): number {
  const date = new Date(now);
  date.setDate(date.getDate() + 1);
  date.setHours(MORNING_HOUR, 0, 0, 0);
  return date.getTime();
}

/**
 * The next Monday at 09:00 local time.
 *
 * On a Monday this means the Monday a week ahead, never today: a snooze that
 * wakes in the past would be pointless.
 */
export function nextMondayMorning(now: number): number {
  const date = new Date(now);
  const daysAhead = (8 - date.getDay()) % 7 || 7;
  date.setDate(date.getDate() + daysAhead);
  date.setHours(MORNING_HOUR, 0, 0, 0);
  return date.getTime();
}

/**
 * The snooze rows the palette registers.
 *
 * Registration runs once at startup, so an id and a label must not depend on
 * the clock. `snoozeWakeTime` resolves the time when the user picks a row.
 */
export const snoozePresets = [
  { id: "snooze-1h", label: "Snooze thread 1 hour" },
  { id: "snooze-3h", label: "Snooze thread 3 hours" },
  { id: "snooze-tomorrow", label: "Snooze thread until tomorrow 9:00" },
  { id: "snooze-monday", label: "Snooze thread until next Monday 9:00" },
] as const;

export type SnoozePresetId = (typeof snoozePresets)[number]["id"];

/** When `preset` wakes a thread, measured from `now`. */
export function snoozeWakeTime(preset: SnoozePresetId, now: number): number {
  switch (preset) {
    case "snooze-1h":
      return inHours(now, 1);
    case "snooze-3h":
      return inHours(now, 3);
    case "snooze-tomorrow":
      return tomorrowMorning(now);
    case "snooze-monday":
      return nextMondayMorning(now);
  }
}
