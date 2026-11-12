// Display formats for token counts, days and times. Pure functions; the app and
// tests share them. Dates use the viewer's local time zone.

const UNITS = [
  { value: 1e9, suffix: "B" },
  { value: 1e6, suffix: "M" },
  { value: 1e3, suffix: "k" },
] as const;

/**
 * Compact token count: 999, 1.2k, 45.3k, 340k, 1.2M, 18.2M, 1.5B.
 * One decimal below 100 of a unit, none from 100. A value that rounds up to
 * 1000 of a unit moves to the next unit (999,960 is 1M, not 1000k).
 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const sign = value < 0 ? "-" : "";
  const n = Math.abs(Math.round(value));
  if (n < 1000) return `${sign}${n}`;
  for (let i = UNITS.length - 1; i >= 0; i--) {
    const unit = UNITS[i];
    const next = UNITS[i - 1];
    const scaled = n / unit.value;
    const text = trim(scaled.toFixed(scaled < 100 ? 1 : 0));
    if (Number(text) < 1000 || !next) return `${sign}${text}${unit.suffix}`;
  }
  return `${sign}${n}`;
}

function trim(text: string): string {
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

/** Exact count with thousands separators: 18,239,216. */
export function formatExact(value: number): string {
  return Math.round(Number.isFinite(value) ? value : 0).toLocaleString("en-US");
}

/** Hover text for a compact count: "18,239,216 tokens". */
export function exactTitle(value: number): string {
  return `${formatExact(value)} ${Math.round(value) === 1 ? "token" : "tokens"}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" for a time in the viewer's zone. */
export function dayKey(time: number): string {
  const d = new Date(time);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse "YYYY-MM-DD" as local midnight. */
export function parseDayKey(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** "Thu 12 Nov" for a day key. */
export function formatDay(day: string): string {
  const d = parseDayKey(day);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "07:02" today, "11 Nov 07:02" this year, "11 Nov 2025 07:02" before. */
export function formatMoment(time: number, now: number): string {
  const d = new Date(time);
  const n = new Date(now);
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (dayKey(time) === dayKey(now)) return clock;
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === n.getFullYear() ? `${date} ${clock}` : `${date} ${d.getFullYear()} ${clock}`;
}

/** Full local timestamp for hover text: "2026-11-12 07:02". */
export function formatTimestamp(time: number): string {
  const d = new Date(time);
  return `${dayKey(time)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
