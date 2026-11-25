// Pure helpers for the inbox UI: ordering, grouping, the badge, snooze
// times, and short labels. No React and no runtime import from contract.ts,
// so zod stays out of the app bundle.
import type { CardAnswer, Item, ItemKind, ItemSource } from "../contract";

export const KIND_LABELS: Record<ItemKind, string> = {
  decide: "Decide",
  approve: "Approve",
  do: "Do",
};

export const SOURCE_LABELS: Record<ItemSource, string> = {
  card: "card",
  tool: "tool",
  detected: "detected",
};

/** Snoozed until a future time. A snooze that has passed counts as open. */
export function isSnoozed(item: Item, now: number): boolean {
  return item.status === "snoozed" && (item.snoozedUntil ?? 0) > now;
}

export function isOpen(item: Item, now: number): boolean {
  return item.status !== "closed" && !isSnoozed(item, now);
}

export function isUnread(item: Item): boolean {
  return item.readAt === null;
}

/** Unread first, then the newest ask first. */
export function compareItems(a: Item, b: Item): number {
  const unread = Number(isUnread(b)) - Number(isUnread(a));
  if (unread !== 0) return unread;
  return b.lastAskedAt - a.lastAskedAt;
}

/** Splits the list into the open group and the snoozed group, each sorted. */
export function groupItems(
  items: readonly Item[],
  now: number,
): { open: Item[]; snoozed: Item[] } {
  const open: Item[] = [];
  const snoozed: Item[] = [];
  for (const item of items) {
    if (item.status === "closed") continue;
    (isSnoozed(item, now) ? snoozed : open).push(item);
  }
  open.sort(compareItems);
  // Snoozed items wake soonest first.
  snoozed.sort((a, b) => (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0));
  return { open, snoozed };
}

export interface InboxBadge {
  count: number;
  label: string;
  tone: "neutral" | "warning";
}

/** The rail badge: open items, warning tone while one of them is unread. */
export function badgeFor(items: readonly Item[], now: number): InboxBadge | null {
  const open = items.filter((item) => isOpen(item, now));
  if (open.length === 0) return null;
  return {
    count: open.length,
    label: `${open.length} waiting`,
    tone: open.some(isUnread) ? "warning" : "neutral",
  };
}

/**
 * Accept recommendation is possible when the item has one. For a card, every
 * decision needs a suggested option.
 */
export function canAcceptRecommendation(item: Item): boolean {
  if (item.source === "card") {
    return (
      item.card !== null &&
      item.card.decisions.every((decision) => decision.suggested !== null)
    );
  }
  return item.recommendation !== null && item.recommendation.trim() !== "";
}

/** The recommendation as one line of text, for display. */
export function recommendationText(item: Item): string | null {
  if (item.source === "card" && item.card) {
    if (!canAcceptRecommendation(item)) return item.recommendation;
    const labels = item.card.decisions.map(
      (decision) => decision.options[decision.suggested ?? 0]?.label ?? "",
    );
    return labels.length === 1 ? labels[0]! : labels.join(" · ");
  }
  return item.recommendation;
}

/** One pick per decision of a multi-decision card. */
export type DecisionPick =
  | { kind: "option"; option: number }
  | { kind: "text"; text: string }
  | null;

/** Card answers in decision order, or null while a decision has no answer. */
export function cardAnswers(picks: readonly DecisionPick[]): CardAnswer[] | null {
  const answers: CardAnswer[] = [];
  for (const pick of picks) {
    if (pick === null) return null;
    if (pick.kind === "option") answers.push({ option: pick.option });
    else if (pick.text.trim() === "") return null;
    else answers.push({ text: pick.text.trim() });
  }
  return answers.length > 0 ? answers : null;
}

// ---------------------------------------------------------------------------
// Snooze times (local time)

const HOUR = 3_600_000;

export function laterToday(now: number): number {
  return now + 3 * HOUR;
}

export function tomorrowMorning(now: number): number {
  const date = new Date(now);
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date.getTime();
}

/** The next Monday at 09:00, never today. */
export function nextMondayMorning(now: number): number {
  const date = new Date(now);
  const days = ((8 - date.getDay()) % 7) || 7;
  date.setDate(date.getDate() + days);
  date.setHours(9, 0, 0, 0);
  return date.getTime();
}

/** A `datetime-local` value as epoch ms, or null when empty or not future. */
export function parseLocalDateTime(value: string, now: number): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time > now ? time : null;
}

// ---------------------------------------------------------------------------
// Labels

/** Short age: "now", "5m", "3h", "2d", then a date. */
export function relativeAge(then: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - then) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(then).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** When a snooze ends, such as "Tue 09:00". */
export function wakeLabel(until: number, now: number): string {
  const date = new Date(until);
  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const sameDay = new Date(now).toDateString() === date.toDateString();
  if (sameDay) return time;
  const weekday = date.toLocaleDateString(undefined, { weekday: "short" });
  return until - now < 6 * 24 * HOUR
    ? `${weekday} ${time}`
    : `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

/** "Thread title · Project", leaving out what is unknown. */
export function threadLine(item: Item): string {
  return [item.threadTitle ?? "Untitled thread", item.projectName]
    .filter(Boolean)
    .join(" · ");
}

/** The error text of a failed RPC call. */
export function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === "string" && error ? error : "Something went wrong";
}
