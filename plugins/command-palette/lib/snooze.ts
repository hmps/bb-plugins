/** Snooze wake times, in local time, as pure math over a `now` timestamp. */

const HOUR_MS = 3_600_000;
const MORNING_HOUR = 9;

export interface SnoozeChoice {
  id: string;
  label: string;
  snoozedUntil: number;
}

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

/** The choices the palette offers, newest-first by wake time. */
export function snoozeChoices(now: number): SnoozeChoice[] {
  return [
    { id: "snooze-1h", label: "Snooze 1 hour", snoozedUntil: inHours(now, 1) },
    { id: "snooze-3h", label: "Snooze 3 hours", snoozedUntil: inHours(now, 3) },
    {
      id: "snooze-tomorrow",
      label: "Snooze until tomorrow 9:00",
      snoozedUntil: tomorrowMorning(now),
    },
    {
      id: "snooze-monday",
      label: "Snooze until next Monday 9:00",
      snoozedUntil: nextMondayMorning(now),
    },
  ];
}
